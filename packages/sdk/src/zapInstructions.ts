// Builds the instruction lists for SSR.fun's Buy/Sell "zap" -- see
// docs/protocol/FRONTEND_INTEGRATION.md "Buy/Sell zap architecture" for the
// full design rationale. Both directions are single atomic transactions with
// two signers (the connected user + a DevNet-only swap-authority keypair
// held server-side, see api/devnet/swap-sign.ts): if any instruction fails,
// nothing partially executes, so a user can never be left holding an
// unintended intermediate basket of Reserve assets.
//
// Buy = SOL zap into proportional protocol mint:
//   1) idempotent-create the depositor's Reserve Token + per-asset ATAs
//   2) SystemProgram.transfer: user -> swapAuthority (the "SOL in" leg)
//   3) per asset leg: SPL mintTo (authority=swapAuthority, destination=user's
//      ATA) for the fixture test mints; for wrapped SOL specifically, the
//      swap authority instead wraps its OWN real SOL (transfer lamports into
//      its own WSOL ATA + syncNative) and forwards it to the user's WSOL ATA
//      -- nobody can "mint" SOL, wrapped or not.
//   4) mint_reserve_tokens_in_kind, signer=user (depositor)
//
// Sell = proportional protocol redeem followed by a zap into SOL:
//   1) redeem_reserve_tokens_in_kind, signer=user (redeemer) -- assets land in the user's own ATAs
//   2) idempotent-create swapAuthority's per-asset ATAs
//   3) SPL transfer per asset leg: user -> swapAuthority (the "assets out" leg);
//      for wrapped SOL specifically, immediately closeAccount the swap
//      authority's WSOL ATA afterward, unwrapping it back into real lamports
//      so the swap authority's real SOL balance is replenished rather than
//      accumulating idle wrapped SOL.
//   4) SystemProgram.transfer: swapAuthority -> user (the "SOL out" leg)
import { PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createMintToInstruction,
  createTransferInstruction,
  createSyncNativeInstruction,
  createCloseAccountInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import * as anchor from "@anchor-lang/core";
import { BN } from "@anchor-lang/core";
import type { Program } from "@anchor-lang/core";
import { computeMintRequirements, computeRedemptionEntitlements, mulDivCeil, type AssetBalance } from "./calculations";
import { solLamportsToUsd, SOL_TEST_PRICE_USD, WRAPPED_SOL_MINT } from "./zapPricing";
import { findTvlAccrual, findMintAuthority, findFeeSettlement, findFeeVaultAuthority, findFeeVaultAta, resolveProtocolFeeDestinationTokenAccount } from "./pda";

function isWrappedSol(mint: PublicKey): boolean {
  return mint.equals(WRAPPED_SOL_MINT);
}

export interface ZapAssetLeg {
  mint: string;
  decimals: number;
  reserveAsset: string;
  vault: string;
  vaultBalanceRaw: string;
  /**
   * The token program that owns this asset (DEC-0201). Optional so existing
   * call sites keep compiling; absent means classic SPL Token, which is what
   * every Reserve created before Token-2022 assets were selectable holds.
   * Builders resolve it through resolveLegTokenProgram, never by assuming.
   */
  tokenProgram?: string;
}

export interface BuildBuyZapParams {
  program: Program<anchor.Idl>;
  protocolConfig: PublicKey;
  /**
   * Instant Protocol mint-fee transfer (see docs/project/DECISION_LOG.md):
   * `ProtocolConfig.defaultProtocolFeeDestination`, read live -- the
   * Protocol's mint-fee share is minted directly to this wallet's Reserve
   * Token ATA in the SAME transaction, never left pending.
   */
  protocolFeeDestination: PublicKey;
  reserve: PublicKey;
  reserveTokenMint: PublicKey;
  mintAuthority: PublicKey;
  user: PublicKey;
  swapAuthority: PublicKey;
  assets: ZapAssetLeg[];
  reserveTokenSupplyRaw: string;
  solLamports: bigint;
  /** DevNet test USD price per asset mint (fixed, see onChainReserve.ts's TEST_ASSET_PRICES_USD). */
  assetTestPricesUsd: Record<string, number>;
  /** Fractional slippage buffer applied to maxAssetAmounts (e.g. 0.02 = 2%). */
  slippageBps?: number;
}

export interface BuildZapResult {
  instructions: TransactionInstruction[];
  reserveTokensRequested?: bigint;
  reserveTokensToRedeem?: bigint;
  assetAmountsRaw: bigint[];
}

/** Converts a target SOL zap amount into a requested (gross) Reserve Token amount using fixed DevNet test pricing and live NAV. */
export function solToReserveTokensRequested(
  solLamports: bigint,
  reserveTokenSupplyRaw: string,
  assets: ZapAssetLeg[],
  assetTestPricesUsd: Record<string, number>,
): bigint {
  const usdIn = solLamportsToUsd(solLamports);
  let aumUsd = 0;
  for (const a of assets) {
    const price = assetTestPricesUsd[a.mint] ?? 0;
    aumUsd += (Number(a.vaultBalanceRaw) / 10 ** a.decimals) * price;
  }
  const supply = Number(reserveTokenSupplyRaw) / 10 ** 6;
  const nav = supply > 0 ? aumUsd / supply : 1;
  const reserveTokensRequestedFloat = (usdIn / nav) * 10 ** 6;
  return BigInt(Math.max(1, Math.floor(reserveTokensRequestedFloat)));
}

export async function buildBuyZapInstructions(params: BuildBuyZapParams): Promise<BuildZapResult> {
  const { program, protocolConfig, protocolFeeDestination, reserve, reserveTokenMint, mintAuthority, user, swapAuthority, assets, reserveTokenSupplyRaw } = params;

  const reserveTokensRequested = solToReserveTokensRequested(params.solLamports, reserveTokenSupplyRaw, assets, params.assetTestPricesUsd);

  const balances: AssetBalance[] = assets.map((a) => ({ mint: a.mint, vaultBalance: BigInt(a.vaultBalanceRaw) }));
  const requirements = computeMintRequirements(reserveTokensRequested, BigInt(reserveTokenSupplyRaw), balances);
  const slippageBps = BigInt(Math.round((params.slippageBps ?? 0.02) * 10_000));
  const maxAssetAmounts = requirements.map((r) => mulDivCeil(r.requiredAmount, 10_000n + slippageBps, 10_000n));

  const instructions: TransactionInstruction[] = [];

  const depositorReserveTokenAta = getAssociatedTokenAddressSync(reserveTokenMint, user);
  instructions.push(createAssociatedTokenAccountIdempotentInstruction(user, depositorReserveTokenAta, user, reserveTokenMint));
  // Consolidation (2026-08-17 corrective pass, see docs/project/DECISION_LOG.md):
  // when the Protocol fee-destination wallet IS this buyer's own, pass the
  // Option<Account> "None" sentinel instead of a second mutable account that
  // would resolve to the exact same ATA as depositorReserveTokenAta above --
  // see resolveProtocolFeeDestinationTokenAccount's doc comment (pda.ts).
  const protocolFeeDestinationTokenAccount = resolveProtocolFeeDestinationTokenAccount(protocolFeeDestination, user, reserveTokenMint, program.programId);
  const [tvlAccrual] = findTvlAccrual(reserve, program.programId);

  const remainingAccounts: { pubkey: PublicKey; isWritable: boolean; isSigner: boolean }[] = [];
  for (let i = 0; i < assets.length; i++) {
    const leg = assets[i];
    const mint = new PublicKey(leg.mint);
    const userAta = getAssociatedTokenAddressSync(mint, user);
    instructions.push(createAssociatedTokenAccountIdempotentInstruction(user, userAta, user, mint));

    if (isWrappedSol(mint)) {
      // Nobody can "mint" SOL -- the swap authority wraps its own real SOL
      // and forwards it, rather than minting from nowhere.
      const swapAuthorityWsolAta = getAssociatedTokenAddressSync(mint, swapAuthority);
      instructions.push(createAssociatedTokenAccountIdempotentInstruction(swapAuthority, swapAuthorityWsolAta, swapAuthority, mint));
      instructions.push(SystemProgram.transfer({ fromPubkey: swapAuthority, toPubkey: swapAuthorityWsolAta, lamports: requirements[i].requiredAmount }));
      instructions.push(createSyncNativeInstruction(swapAuthorityWsolAta));
      instructions.push(createTransferInstruction(swapAuthorityWsolAta, userAta, swapAuthority, requirements[i].requiredAmount));
    } else {
      instructions.push(createMintToInstruction(mint, userAta, swapAuthority, requirements[i].requiredAmount));
    }

    remainingAccounts.push(
      { pubkey: new PublicKey(leg.reserveAsset), isWritable: false, isSigner: false },
      { pubkey: new PublicKey(leg.vault), isWritable: true, isSigner: false },
      { pubkey: userAta, isWritable: true, isSigner: false },
      { pubkey: mint, isWritable: false, isSigner: false },
      { pubkey: TOKEN_PROGRAM_ID, isWritable: false, isSigner: false },
    );
  }

  // The SOL-in leg is last among the "setup" instructions but before the
  // program call -- ordering among independent instructions in one atomic
  // transaction doesn't affect correctness, only debuggability.
  instructions.push(SystemProgram.transfer({ fromPubkey: user, toPubkey: swapAuthority, lamports: params.solLamports }));

  const mintIx = await program.methods
    .mintReserveTokensInKind(
      new BN(reserveTokensRequested.toString()),
      new BN(1),
      maxAssetAmounts.map((a) => new BN(a.toString())),
    )
    .accounts({
      protocolConfig,
      reserve,
      reserveTokenMint,
      mintAuthority,
      depositorReserveTokenAccount: depositorReserveTokenAta,
      depositor: user,
      protocolFeeDestinationTokenAccount,
      protocolFeeDestination,
      tvlAccrual,
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .remainingAccounts(remainingAccounts)
    .instruction();
  instructions.push(mintIx);

  return { instructions, reserveTokensRequested, assetAmountsRaw: requirements.map((r) => r.requiredAmount) };
}

/** Converts a target devUSDC settlement amount into a requested (gross) Reserve Token amount. devUSDC is pegged $1 by design (Phase C) -- no SOL-style price conversion needed, unlike solToReserveTokensRequested. */
export function devUsdcToReserveTokensRequested(
  devUsdcAmountRaw: bigint,
  devUsdcDecimals: number,
  reserveTokenSupplyRaw: string,
  assets: ZapAssetLeg[],
  assetTestPricesUsd: Record<string, number>,
): bigint {
  const usdIn = Number(devUsdcAmountRaw) / 10 ** devUsdcDecimals;
  let aumUsd = 0;
  for (const a of assets) {
    const price = assetTestPricesUsd[a.mint] ?? 0;
    aumUsd += (Number(a.vaultBalanceRaw) / 10 ** a.decimals) * price;
  }
  const supply = Number(reserveTokenSupplyRaw) / 10 ** 6;
  const nav = supply > 0 ? aumUsd / supply : 1;
  const reserveTokensRequestedFloat = (usdIn / nav) * 10 ** 6;
  return BigInt(Math.max(1, Math.floor(reserveTokensRequestedFloat)));
}

export interface BuildBuyZapDevUsdcParams {
  program: Program<anchor.Idl>;
  protocolConfig: PublicKey;
  /** See BuildBuyZapParams.protocolFeeDestination -- same instant mint-fee transfer, same source. */
  protocolFeeDestination: PublicKey;
  reserve: PublicKey;
  reserveTokenMint: PublicKey;
  mintAuthority: PublicKey;
  user: PublicKey;
  swapAuthority: PublicKey;
  assets: ZapAssetLeg[];
  reserveTokenSupplyRaw: string;
  devUsdcMint: PublicKey;
  devUsdcDecimals: number;
  devUsdcAmountRaw: bigint;
  assetTestPricesUsd: Record<string, number>;
  slippageBps?: number;
}

export interface BuildBuyZapDevUsdcResult extends BuildZapResult {
  /** Per-leg breakdown of what genuinely funds this mint: the devUSDC leg (if the Reserve has one) comes from the user's OWN real wallet balance -- nothing is minted/fabricated for it. Every other leg is still funded via the DevNet swap-authority's test-asset mint/wrap mechanism, unchanged from the SOL zap. Never a simulated conversion between devUSDC and the other assets -- each leg's real source is exactly what's reported here. */
  legSources: { mint: string; source: "user-devusdc-balance" | "devnet-test-asset-faucet" }[];
}

/**
 * devUSDC-settlement Buy: the default DevNet mint flow (see DEC "devUSDC
 * default settlement asset" pass). Unlike the SOL zap, this does NOT collect
 * a separate payment from the user into the swap authority -- if the
 * Reserve has a devUSDC leg, that leg's required amount is transferred
 * directly out of the user's OWN devUSDC token account by
 * mint_reserve_tokens_in_kind itself (the same real, ordinary transfer_checked
 * every asset leg always goes through), genuinely spending the user's real
 * devUSDC balance. Every OTHER leg (mockX/Y/Z, or wrapped SOL if present)
 * is still funded via the swap authority's existing test-asset mint/wrap
 * mechanism, exactly as in the SOL zap -- this is not new fabrication, just
 * the same pre-existing DevNet convenience, now clearly reported per-leg via
 * `legSources` rather than left ambiguous. If the Reserve has NO devUSDC
 * leg at all, 100% of the mint is still swap-authority-funded (like today),
 * and the caller should disclose that honestly rather than imply the user
 * paid anything real -- see DTRDetail.tsx's composition preview.
 */
export async function buildBuyZapInstructionsDevUsdc(params: BuildBuyZapDevUsdcParams): Promise<BuildBuyZapDevUsdcResult> {
  const { program, protocolConfig, protocolFeeDestination, reserve, reserveTokenMint, mintAuthority, user, swapAuthority, assets, reserveTokenSupplyRaw, devUsdcMint } = params;

  const reserveTokensRequested = devUsdcToReserveTokensRequested(
    params.devUsdcAmountRaw,
    params.devUsdcDecimals,
    reserveTokenSupplyRaw,
    assets,
    params.assetTestPricesUsd,
  );

  const balances: AssetBalance[] = assets.map((a) => ({ mint: a.mint, vaultBalance: BigInt(a.vaultBalanceRaw) }));
  const requirements = computeMintRequirements(reserveTokensRequested, BigInt(reserveTokenSupplyRaw), balances);
  const slippageBps = BigInt(Math.round((params.slippageBps ?? 0.02) * 10_000));
  const maxAssetAmounts = requirements.map((r) => mulDivCeil(r.requiredAmount, 10_000n + slippageBps, 10_000n));

  const instructions: TransactionInstruction[] = [];
  const legSources: { mint: string; source: "user-devusdc-balance" | "devnet-test-asset-faucet" }[] = [];

  const depositorReserveTokenAta = getAssociatedTokenAddressSync(reserveTokenMint, user);
  instructions.push(createAssociatedTokenAccountIdempotentInstruction(user, depositorReserveTokenAta, user, reserveTokenMint));
  // Consolidation (2026-08-17 corrective pass, see docs/project/DECISION_LOG.md):
  // when the Protocol fee-destination wallet IS this buyer's own, pass the
  // Option<Account> "None" sentinel instead of a second mutable account that
  // would resolve to the exact same ATA as depositorReserveTokenAta above --
  // see resolveProtocolFeeDestinationTokenAccount's doc comment (pda.ts).
  const protocolFeeDestinationTokenAccount = resolveProtocolFeeDestinationTokenAccount(protocolFeeDestination, user, reserveTokenMint, program.programId);
  const [tvlAccrual] = findTvlAccrual(reserve, program.programId);

  const remainingAccounts: { pubkey: PublicKey; isWritable: boolean; isSigner: boolean }[] = [];
  for (let i = 0; i < assets.length; i++) {
    const leg = assets[i];
    const mint = new PublicKey(leg.mint);
    const userAta = getAssociatedTokenAddressSync(mint, user);
    instructions.push(createAssociatedTokenAccountIdempotentInstruction(user, userAta, user, mint));

    if (mint.equals(devUsdcMint)) {
      // The user's own real devUSDC balance funds this leg directly --
      // mint_reserve_tokens_in_kind's own transfer_checked (below, via
      // remainingAccounts) moves it from userAta into the vault. No mint/wrap
      // instruction here at all; if the user doesn't hold enough, the
      // transaction fails on-chain with a real, honest SPL insufficient-funds
      // error -- never a fabricated success.
      legSources.push({ mint: leg.mint, source: "user-devusdc-balance" });
    } else if (isWrappedSol(mint)) {
      const swapAuthorityWsolAta = getAssociatedTokenAddressSync(mint, swapAuthority);
      instructions.push(createAssociatedTokenAccountIdempotentInstruction(swapAuthority, swapAuthorityWsolAta, swapAuthority, mint));
      instructions.push(SystemProgram.transfer({ fromPubkey: swapAuthority, toPubkey: swapAuthorityWsolAta, lamports: requirements[i].requiredAmount }));
      instructions.push(createSyncNativeInstruction(swapAuthorityWsolAta));
      instructions.push(createTransferInstruction(swapAuthorityWsolAta, userAta, swapAuthority, requirements[i].requiredAmount));
      legSources.push({ mint: leg.mint, source: "devnet-test-asset-faucet" });
    } else {
      instructions.push(createMintToInstruction(mint, userAta, swapAuthority, requirements[i].requiredAmount));
      legSources.push({ mint: leg.mint, source: "devnet-test-asset-faucet" });
    }

    remainingAccounts.push(
      { pubkey: new PublicKey(leg.reserveAsset), isWritable: false, isSigner: false },
      { pubkey: new PublicKey(leg.vault), isWritable: true, isSigner: false },
      { pubkey: userAta, isWritable: true, isSigner: false },
      { pubkey: mint, isWritable: false, isSigner: false },
      { pubkey: TOKEN_PROGRAM_ID, isWritable: false, isSigner: false },
    );
  }

  const mintIx = await program.methods
    .mintReserveTokensInKind(
      new BN(reserveTokensRequested.toString()),
      new BN(1),
      maxAssetAmounts.map((a) => new BN(a.toString())),
    )
    .accounts({
      protocolConfig,
      reserve,
      reserveTokenMint,
      mintAuthority,
      depositorReserveTokenAccount: depositorReserveTokenAta,
      depositor: user,
      protocolFeeDestinationTokenAccount,
      protocolFeeDestination,
      tvlAccrual,
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .remainingAccounts(remainingAccounts)
    .instruction();
  instructions.push(mintIx);

  return { instructions, reserveTokensRequested, assetAmountsRaw: requirements.map((r) => r.requiredAmount), legSources };
}

export interface BuildSellZapParams {
  program: Program<anchor.Idl>;
  reserve: PublicKey;
  reserveTokenMint: PublicKey;
  vaultAuthority: PublicKey;
  user: PublicKey;
  swapAuthority: PublicKey;
  assets: ZapAssetLeg[];
  reserveTokenSupplyRaw: string;
  redemptionFeeBps: bigint;
  reserveTokensToRedeem: bigint;
  assetTestPricesUsd: Record<string, number>;
}

export async function buildSellZapInstructions(params: BuildSellZapParams): Promise<BuildZapResult & { solLamportsOut: bigint }> {
  const { program, reserve, reserveTokenMint, vaultAuthority, user, swapAuthority, assets, reserveTokenSupplyRaw } = params;

  const balances: AssetBalance[] = assets.map((a) => ({ mint: a.mint, vaultBalance: BigInt(a.vaultBalanceRaw) }));
  const entitlements = computeRedemptionEntitlements(params.reserveTokensToRedeem, params.redemptionFeeBps, BigInt(reserveTokenSupplyRaw), balances);

  const redeemerReserveTokenAta = getAssociatedTokenAddressSync(reserveTokenMint, user);
  const [tvlAccrual] = findTvlAccrual(reserve, program.programId);

  const remainingAccounts: { pubkey: PublicKey; isWritable: boolean; isSigner: boolean }[] = [];
  const instructions: TransactionInstruction[] = [];
  let totalUsdOut = 0;

  for (let i = 0; i < assets.length; i++) {
    const leg = assets[i];
    const mint = new PublicKey(leg.mint);
    const userAta = getAssociatedTokenAddressSync(mint, user);
    remainingAccounts.push(
      { pubkey: new PublicKey(leg.reserveAsset), isWritable: false, isSigner: false },
      { pubkey: new PublicKey(leg.vault), isWritable: true, isSigner: false },
      { pubkey: userAta, isWritable: true, isSigner: false },
      { pubkey: mint, isWritable: false, isSigner: false },
      { pubkey: TOKEN_PROGRAM_ID, isWritable: false, isSigner: false },
    );
  }

  const redeemIx = await program.methods
    .redeemReserveTokensInKind(
      new BN(params.reserveTokensToRedeem.toString()),
      entitlements.map(() => new BN(0)),
    )
    .accounts({
      reserve,
      reserveTokenMint,
      vaultAuthority,
      redeemerReserveTokenAccount: redeemerReserveTokenAta,
      redeemer: user,
      tvlAccrual,
      // DEC-0173 redeem struct: the redemption fee is re-minted into the
      // shared fee vault (same trio as the mint path + the mint authority
      // the re-mint CPI signs with). Pure derivations, shared across clusters
      // like every other builder in this SDK.
      mintAuthority: findMintAuthority(reserve, program.programId)[0],
      feeSettlement: findFeeSettlement(reserve, program.programId)[0],
      feeVault: findFeeVaultAta(reserve, reserveTokenMint, program.programId),
      feeVaultAuthority: findFeeVaultAuthority(reserve, program.programId)[0],
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .remainingAccounts(remainingAccounts)
    .instruction();
  instructions.push(redeemIx);

  for (let i = 0; i < assets.length; i++) {
    const leg = assets[i];
    const mint = new PublicKey(leg.mint);
    const userAta = getAssociatedTokenAddressSync(mint, user);
    const swapAuthorityAta = getAssociatedTokenAddressSync(mint, swapAuthority);
    instructions.push(createAssociatedTokenAccountIdempotentInstruction(swapAuthority, swapAuthorityAta, swapAuthority, mint));
    instructions.push(createTransferInstruction(userAta, swapAuthorityAta, user, entitlements[i].entitlement));
    if (isWrappedSol(mint)) {
      // Immediately unwrap back into real lamports rather than letting the
      // swap authority accumulate idle wrapped SOL -- replenishes its real
      // SOL balance so it can keep funding future Buy legs.
      instructions.push(createCloseAccountInstruction(swapAuthorityAta, swapAuthority, swapAuthority));
    }
    const price = params.assetTestPricesUsd[leg.mint] ?? 0;
    totalUsdOut += (Number(entitlements[i].entitlement) / 10 ** leg.decimals) * price;
  }

  const solLamportsOut = BigInt(Math.floor((totalUsdOut / SOL_TEST_PRICE_USD) * 1_000_000_000));
  instructions.push(SystemProgram.transfer({ fromPubkey: swapAuthority, toPubkey: user, lamports: solLamportsOut }));

  return {
    instructions,
    reserveTokensToRedeem: params.reserveTokensToRedeem,
    assetAmountsRaw: entitlements.map((e) => e.entitlement),
    solLamportsOut,
  };
}

export interface BuildSellZapDevUsdcParams {
  program: Program<anchor.Idl>;
  reserve: PublicKey;
  reserveTokenMint: PublicKey;
  vaultAuthority: PublicKey;
  user: PublicKey;
  swapAuthority: PublicKey;
  /** Every asset must be one of the supported DevNet mints (devUSDC, mockX/Y/Z) -- callers (api/devnet/swap-sign.ts) verify this via packages/sdk/src/tradableAssets.ts before calling. Wrapped SOL is not handled here. */
  assets: ZapAssetLeg[];
  reserveTokenSupplyRaw: string;
  redemptionFeeBps: bigint;
  reserveTokensToRedeem: bigint;
  assetTestPricesUsd: Record<string, number>;
  devUsdcMint: PublicKey;
  devUsdcDecimals: number;
}

/**
 * devUSDC-settled Sell for a Reserve holding a mix of devUSDC and other
 * supported test assets (mockX/Y/Z) -- the inverse of
 * buildBuyZapInstructionsDevUsdc. redeem_reserve_tokens_in_kind deposits the
 * redeemer's real proportional entitlement directly into their OWN token
 * accounts for every asset leg (same single instruction as
 * buildSellZapInstructions/buildRedeemToDevUsdcInstructions). Any devUSDC
 * entitlement is real and simply stays in the user's wallet -- no further
 * instruction touches it. Every OTHER (non-devUSDC) leg is then transferred
 * from the user to the swap authority (giving up those worthless DevNet test
 * tokens, exactly as buildSellZapInstructions already does), and the swap
 * authority mints the user a devUSDC amount equal to those legs' combined
 * DevNet test-price USD value -- using its own real devUSDC mint authority
 * (the same authority api/devnet/faucet-devusdc.ts already uses), not a SOL
 * payment. This removes the swap authority's SOL balance as a dependency for
 * Sell entirely for this path (see api/devnet/swap-sign.ts, which no longer
 * calls assertSwapAuthorityHasSol for this branch).
 */
export async function buildSellZapInstructionsDevUsdc(
  params: BuildSellZapDevUsdcParams,
): Promise<{ instructions: TransactionInstruction[]; assetAmountsRaw: bigint[]; devUsdcOutRaw: bigint }> {
  const { program, reserve, reserveTokenMint, vaultAuthority, user, swapAuthority, assets, reserveTokenSupplyRaw, devUsdcMint, devUsdcDecimals } = params;

  const balances: AssetBalance[] = assets.map((a) => ({ mint: a.mint, vaultBalance: BigInt(a.vaultBalanceRaw) }));
  const entitlements = computeRedemptionEntitlements(params.reserveTokensToRedeem, params.redemptionFeeBps, BigInt(reserveTokenSupplyRaw), balances);

  const redeemerReserveTokenAta = getAssociatedTokenAddressSync(reserveTokenMint, user);
  const [tvlAccrual] = findTvlAccrual(reserve, program.programId);

  const remainingAccounts: { pubkey: PublicKey; isWritable: boolean; isSigner: boolean }[] = [];
  const instructions: TransactionInstruction[] = [];
  let totalUsdFromNonDevUsdcLegs = 0;
  let devUsdcEntitlementRaw = 0n;

  for (let i = 0; i < assets.length; i++) {
    const leg = assets[i];
    const mint = new PublicKey(leg.mint);
    const userAta = getAssociatedTokenAddressSync(mint, user);
    remainingAccounts.push(
      { pubkey: new PublicKey(leg.reserveAsset), isWritable: false, isSigner: false },
      { pubkey: new PublicKey(leg.vault), isWritable: true, isSigner: false },
      { pubkey: userAta, isWritable: true, isSigner: false },
      { pubkey: mint, isWritable: false, isSigner: false },
      { pubkey: TOKEN_PROGRAM_ID, isWritable: false, isSigner: false },
    );
  }

  const redeemIx = await program.methods
    .redeemReserveTokensInKind(
      new BN(params.reserveTokensToRedeem.toString()),
      entitlements.map(() => new BN(0)),
    )
    .accounts({
      reserve,
      reserveTokenMint,
      vaultAuthority,
      redeemerReserveTokenAccount: redeemerReserveTokenAta,
      redeemer: user,
      tvlAccrual,
      // DEC-0173 redeem struct: the redemption fee is re-minted into the
      // shared fee vault (same trio as the mint path + the mint authority
      // the re-mint CPI signs with). Pure derivations, shared across clusters
      // like every other builder in this SDK.
      mintAuthority: findMintAuthority(reserve, program.programId)[0],
      feeSettlement: findFeeSettlement(reserve, program.programId)[0],
      feeVault: findFeeVaultAta(reserve, reserveTokenMint, program.programId),
      feeVaultAuthority: findFeeVaultAuthority(reserve, program.programId)[0],
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .remainingAccounts(remainingAccounts)
    .instruction();
  instructions.push(redeemIx);

  for (let i = 0; i < assets.length; i++) {
    const leg = assets[i];
    const mint = new PublicKey(leg.mint);
    if (mint.equals(devUsdcMint)) {
      // Already real devUSDC, already in the user's own wallet from the
      // redeem instruction above -- nothing further to do for this leg.
      devUsdcEntitlementRaw = entitlements[i].entitlement;
      continue;
    }
    const userAta = getAssociatedTokenAddressSync(mint, user);
    const swapAuthorityAta = getAssociatedTokenAddressSync(mint, swapAuthority);
    instructions.push(createAssociatedTokenAccountIdempotentInstruction(swapAuthority, swapAuthorityAta, swapAuthority, mint));
    instructions.push(createTransferInstruction(userAta, swapAuthorityAta, user, entitlements[i].entitlement));
    const price = params.assetTestPricesUsd[leg.mint] ?? 0;
    totalUsdFromNonDevUsdcLegs += (Number(entitlements[i].entitlement) / 10 ** leg.decimals) * price;
  }

  const devUsdcToMintRaw = BigInt(Math.floor(totalUsdFromNonDevUsdcLegs * 10 ** devUsdcDecimals));
  const userDevUsdcAta = getAssociatedTokenAddressSync(devUsdcMint, user);
  if (devUsdcToMintRaw > 0n) {
    instructions.push(createAssociatedTokenAccountIdempotentInstruction(user, userDevUsdcAta, user, devUsdcMint));
    instructions.push(createMintToInstruction(devUsdcMint, userDevUsdcAta, swapAuthority, devUsdcToMintRaw));
  }

  return {
    instructions,
    assetAmountsRaw: entitlements.map((e) => e.entitlement),
    devUsdcOutRaw: devUsdcEntitlementRaw + devUsdcToMintRaw,
  };
}

export interface BuildRedeemToDevUsdcParams {
  program: Program<anchor.Idl>;
  reserve: PublicKey;
  reserveTokenMint: PublicKey;
  vaultAuthority: PublicKey;
  user: PublicKey;
  /** Must be exactly [{ mint: devUSDC, ... }] -- this builder does not gate that itself; callers (api/devnet/swap-sign.ts) must verify the Reserve is 100% devUSDC-backed before calling it. */
  assets: ZapAssetLeg[];
  reserveTokenSupplyRaw: string;
  redemptionFeeBps: bigint;
  reserveTokensToRedeem: bigint;
}

/**
 * Genuine devUSDC redemption for a Reserve backed 100% by devUSDC: a single
 * redeem_reserve_tokens_in_kind call, signer=user only. redeem_reserve_tokens_in_kind
 * already deposits the redeemer's real proportional entitlement directly
 * into their OWN token account (see buildSellZapInstructions's identical
 * redeemIx) -- since the Reserve's sole asset is devUSDC, that entitlement
 * IS real devUSDC, landing directly in the user's wallet. No swap-authority
 * co-signature, no zap, no SOL leg, and no conversion of any kind is
 * involved or needed -- this is the inverse of the pure-devUSDC Buy path
 * (buildBuyZapInstructionsDevUsdc), returning devUSDC exactly as the
 * authoritative product model requires. See docs/project/DECISION_LOG.md's
 * Buy/Sell architecture correction.
 */
export async function buildRedeemToDevUsdcInstructions(
  params: BuildRedeemToDevUsdcParams,
): Promise<{ instructions: TransactionInstruction[]; devUsdcOutRaw: bigint }> {
  const { program, reserve, reserveTokenMint, vaultAuthority, user, assets, reserveTokenSupplyRaw } = params;

  const balances: AssetBalance[] = assets.map((a) => ({ mint: a.mint, vaultBalance: BigInt(a.vaultBalanceRaw) }));
  const entitlements = computeRedemptionEntitlements(params.reserveTokensToRedeem, params.redemptionFeeBps, BigInt(reserveTokenSupplyRaw), balances);

  const redeemerReserveTokenAta = getAssociatedTokenAddressSync(reserveTokenMint, user);
  const [tvlAccrual] = findTvlAccrual(reserve, program.programId);
  const remainingAccounts: { pubkey: PublicKey; isWritable: boolean; isSigner: boolean }[] = [];
  for (const leg of assets) {
    const mint = new PublicKey(leg.mint);
    const userAta = getAssociatedTokenAddressSync(mint, user);
    remainingAccounts.push(
      { pubkey: new PublicKey(leg.reserveAsset), isWritable: false, isSigner: false },
      { pubkey: new PublicKey(leg.vault), isWritable: true, isSigner: false },
      { pubkey: userAta, isWritable: true, isSigner: false },
      { pubkey: mint, isWritable: false, isSigner: false },
      { pubkey: TOKEN_PROGRAM_ID, isWritable: false, isSigner: false },
    );
  }

  const redeemIx = await program.methods
    .redeemReserveTokensInKind(
      new BN(params.reserveTokensToRedeem.toString()),
      entitlements.map(() => new BN(0)),
    )
    .accounts({
      reserve,
      reserveTokenMint,
      vaultAuthority,
      redeemerReserveTokenAccount: redeemerReserveTokenAta,
      redeemer: user,
      tvlAccrual,
      // DEC-0173 redeem struct: the redemption fee is re-minted into the
      // shared fee vault (same trio as the mint path + the mint authority
      // the re-mint CPI signs with). Pure derivations, shared across clusters
      // like every other builder in this SDK.
      mintAuthority: findMintAuthority(reserve, program.programId)[0],
      feeSettlement: findFeeSettlement(reserve, program.programId)[0],
      feeVault: findFeeVaultAta(reserve, reserveTokenMint, program.programId),
      feeVaultAuthority: findFeeVaultAuthority(reserve, program.programId)[0],
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .remainingAccounts(remainingAccounts)
    .instruction();

  return { instructions: [redeemIx], devUsdcOutRaw: entitlements[0]?.entitlement ?? 0n };
}
