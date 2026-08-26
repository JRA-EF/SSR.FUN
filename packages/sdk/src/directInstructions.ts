// Mainnet-native Buy/Sell: a direct, single-signer in-kind deposit/
// withdrawal against a Reserve -- no server-held swap authority, no minted/
// fabricated legs, no price oracle. This exists because zapInstructions.ts's
// DevNet zap fundamentally depends on a swap authority that can mint fake
// test tokens for legs the user doesn't already hold -- there is no
// equivalent for a real Mainnet asset.
//
// Two shapes:
//  - buildDirectMintInstructions/buildDirectRedeemInstructions: the ORIGINAL
//    single-asset path (requireSingleAssetReserve fails loudly for anything
//    else) -- the user's own deposit IS the Reserve's sole required leg, no
//    funding step needed beyond holding it.
//  - buildDirectMultiAssetMintInstructions (added 2026-08-24, road-to-mainnet
//    MMT-01, DEC-0140): a genuinely multi-asset Reserve's in-kind mint
//    requires N proportional legs at once (the on-chain mint_reserve_tokens_in_kind
//    instruction already supports this -- see zapInstructions.ts's
//    buildBuyZapInstructions, which has always built exactly this shape for
//    DevNet's swap-authority-funded zap). The caller is responsible for the
//    user's wallet already holding each leg's required amount BEFORE calling
//    this -- see src/merge/lib/multiAssetBuyClient.ts, which funds each
//    shortfall for real (wrap the user's own SOL for a wrapped-SOL leg,
//    swap the user's own USDC via Jupiter for any other leg, mirroring
//    createReserveClient.ts's proven seed-funding pattern) before this
//    function ever builds the final mint transaction.
//  - buildDirectMultiAssetRedeemInstructions (added 2026-08-26, DEC-0158):
//    the inverse -- one redeem_reserve_tokens_in_kind paying every leg's
//    proportional entitlement into the redeemer's own ATAs; converting
//    those legs to USDC is the caller's next step (multiAssetSellClient.ts
//    swaps each non-USDC leg via Jupiter, atomically where it fits).

import { PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import * as anchor from "@anchor-lang/core";
import { BN } from "@anchor-lang/core";
import type { Program } from "@anchor-lang/core";
import { findTvlAccrual, resolveProtocolFeeDestinationTokenAccount } from "./pda";
import type { ZapAssetLeg } from "./zapInstructions";
import { computeMintRequirements, computeRedemptionEntitlements, mulDivCeil } from "./calculations";

export interface DirectInstructionResult {
  instructions: TransactionInstruction[];
  reserveTokensRequested?: bigint;
  reserveTokensToRedeem?: bigint;
  assetAmountRaw: bigint;
}

/**
 * Fails loudly (never silently mis-prices a partial deposit) if the Reserve
 * isn't genuinely single-asset. There is deliberately no fallback path this
 * throws "into" -- zapInstructions.ts's zap is DevNet-only (it depends on a
 * server-held swap authority that can mint fake test tokens for legs the
 * depositor doesn't hold; no Mainnet equivalent exists). A genuinely
 * multi-asset Mainnet Reserve has no supported Buy/Sell mechanism at all
 * today -- confirmed live (2026-08-24, road-to-mainnet MMT-01) -- callers on
 * Mainnet must gate this UI-side (see DTRDetail.tsx's
 * isSettlementBuySupported) rather than let a depositor reach this throw.
 */
export function requireSingleAssetReserve(assets: ZapAssetLeg[]): ZapAssetLeg {
  if (assets.length !== 1) {
    throw new Error(
      `This Reserve holds ${assets.length} assets. There is no supported way to buy into or sell from a multi-asset Reserve on Mainnet yet -- only a single-asset Reserve can use this direct deposit/withdrawal path.`,
    );
  }
  return assets[0];
}

/**
 * Inverse of computeMintRequirements's per-leg `mulDivCeil(reserveTokensRequested, vaultBalance, totalSupply)`.
 * Floors rather than ceils so the on-chain required amount can never exceed
 * `amountIn` -- the user only ever pays exactly what they asked to deposit,
 * never more (worst case the mint is fractionally smaller, never a
 * surprise extra charge).
 */
export function computeDirectReserveTokensRequested(amountIn: bigint, vaultBalance: bigint, totalSupply: bigint): bigint {
  if (totalSupply <= 0n || vaultBalance <= 0n) {
    throw new Error("computeDirectReserveTokensRequested: Reserve must already be seeded (nonzero supply/vault balance).");
  }
  if (amountIn <= 0n) throw new Error("computeDirectReserveTokensRequested: amountIn must be positive.");
  return (amountIn * totalSupply) / vaultBalance;
}

export interface BuildDirectMintParams {
  program: Program<anchor.Idl>;
  protocolConfig: PublicKey;
  protocolFeeDestination: PublicKey;
  reserve: PublicKey;
  reserveTokenMint: PublicKey;
  mintAuthority: PublicKey;
  user: PublicKey;
  assets: ZapAssetLeg[];
  reserveTokenSupplyRaw: string;
  amountIn: bigint;
}

/** Single-signer (the connected user), single-instruction (plus idempotent ATA setup) direct in-kind mint -- no swap authority, no server round-trip. */
export async function buildDirectMintInstructions(params: BuildDirectMintParams): Promise<DirectInstructionResult> {
  const { program, protocolConfig, protocolFeeDestination, reserve, reserveTokenMint, mintAuthority, user } = params;
  const asset = requireSingleAssetReserve(params.assets);
  const mint = new PublicKey(asset.mint);
  const vaultBalance = BigInt(asset.vaultBalanceRaw);
  const totalSupply = BigInt(params.reserveTokenSupplyRaw);

  const reserveTokensRequested = computeDirectReserveTokensRequested(params.amountIn, vaultBalance, totalSupply);

  const instructions: TransactionInstruction[] = [];

  const depositorReserveTokenAta = getAssociatedTokenAddressSync(reserveTokenMint, user);
  instructions.push(createAssociatedTokenAccountIdempotentInstruction(user, depositorReserveTokenAta, user, reserveTokenMint));
  const userAssetAta = getAssociatedTokenAddressSync(mint, user);
  instructions.push(createAssociatedTokenAccountIdempotentInstruction(user, userAssetAta, user, mint));

  const protocolFeeDestinationTokenAccount = resolveProtocolFeeDestinationTokenAccount(protocolFeeDestination, user, reserveTokenMint, program.programId);
  const [tvlAccrual] = findTvlAccrual(reserve, program.programId);

  const mintIx = await program.methods
    .mintReserveTokensInKind(
      new BN(reserveTokensRequested.toString()),
      new BN(1),
      [new BN(params.amountIn.toString())], // exact cap: never more than what the user is depositing
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
      // "None" sentinel (DEC-0094 convention, see pda.ts's doc comment) --
      // Mainnet Reserves don't opt into multi-recipient Manager fee routing
      // for this launch.
      managerFeeRecipients: program.programId,
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .remainingAccounts([
      { pubkey: new PublicKey(asset.reserveAsset), isWritable: false, isSigner: false },
      { pubkey: new PublicKey(asset.vault), isWritable: true, isSigner: false },
      { pubkey: userAssetAta, isWritable: true, isSigner: false },
      { pubkey: mint, isWritable: false, isSigner: false },
      { pubkey: TOKEN_PROGRAM_ID, isWritable: false, isSigner: false },
    ])
    .instruction();
  instructions.push(mintIx);

  return { instructions, reserveTokensRequested, assetAmountRaw: params.amountIn };
}

export interface BuildDirectMultiAssetMintParams {
  program: Program<anchor.Idl>;
  protocolConfig: PublicKey;
  protocolFeeDestination: PublicKey;
  reserve: PublicKey;
  reserveTokenMint: PublicKey;
  mintAuthority: PublicKey;
  user: PublicKey;
  assets: ZapAssetLeg[];
  reserveTokenSupplyRaw: string;
  /** Already computed (see src/merge/lib/multiAssetBuyClient.ts's usdToReserveTokensRequested) -- how many Reserve Tokens (gross, before the mint fee) this deposit is targeting. */
  reserveTokensRequested: bigint;
  /** Fractional slippage buffer applied on top of each leg's exact required amount (e.g. 0.02 = 2%) -- the on-chain instruction enforces this as a hard per-leg cap (transfer_checked can never move more), so the whole transaction reverts safely (nothing partially moves) if the real requirement ever exceeds it. */
  slippageBps?: number;
}

export interface BuildDirectMultiAssetMintResult extends DirectInstructionResult {
  /** Exact (pre-slippage-buffer) raw amount required for each of `params.assets`, in the same order -- what the caller must have already ensured the wallet holds (see multiAssetBuyClient.ts's funding step) before submitting this transaction. */
  requiredAmountsRaw: bigint[];
}

/**
 * Multi-signer-account (still ONE signer -- the connected user), multi-leg
 * in-kind mint: deposits a proportional amount of EVERY one of the Reserve's
 * registered assets in a single transaction, exactly mirroring
 * zapInstructions.ts's buildBuyZapInstructions' remainingAccounts/
 * maxAssetAmounts shape (the on-chain mint_reserve_tokens_in_kind instruction
 * has always supported this -- only this app's Mainnet client never built it
 * before). Unlike the zap, there is no swap authority here: every leg's ATA
 * must ALREADY hold at least its required amount by the time this builds --
 * see this file's header and multiAssetBuyClient.ts for how that's funded
 * for real (wrap/swap) before this ever runs. If a leg's real balance is
 * short, `transfer_checked` fails and the whole transaction reverts --
 * nothing partially deposits.
 */
export async function buildDirectMultiAssetMintInstructions(params: BuildDirectMultiAssetMintParams): Promise<BuildDirectMultiAssetMintResult> {
  const { program, protocolConfig, protocolFeeDestination, reserve, reserveTokenMint, mintAuthority, user, assets, reserveTokensRequested } = params;
  if (assets.length < 2) {
    throw new Error(`buildDirectMultiAssetMintInstructions requires a genuinely multi-asset Reserve; found ${assets.length}. Use buildDirectMintInstructions for a single-asset Reserve instead.`);
  }
  const totalSupply = BigInt(params.reserveTokenSupplyRaw);
  const balances = assets.map((a) => ({ mint: a.mint, vaultBalance: BigInt(a.vaultBalanceRaw) }));
  const requirements = computeMintRequirements(reserveTokensRequested, totalSupply, balances);
  const slippageBps = BigInt(Math.round((params.slippageBps ?? 0.02) * 10_000));
  const maxAssetAmounts = requirements.map((r) => mulDivCeil(r.requiredAmount, 10_000n + slippageBps, 10_000n));

  const instructions: TransactionInstruction[] = [];

  const depositorReserveTokenAta = getAssociatedTokenAddressSync(reserveTokenMint, user);
  instructions.push(createAssociatedTokenAccountIdempotentInstruction(user, depositorReserveTokenAta, user, reserveTokenMint));

  const protocolFeeDestinationTokenAccount = resolveProtocolFeeDestinationTokenAccount(protocolFeeDestination, user, reserveTokenMint, program.programId);
  const [tvlAccrual] = findTvlAccrual(reserve, program.programId);

  const remainingAccounts: { pubkey: PublicKey; isWritable: boolean; isSigner: boolean }[] = [];
  for (const leg of assets) {
    const mint = new PublicKey(leg.mint);
    const userAta = getAssociatedTokenAddressSync(mint, user);
    // Idempotent -- a no-op if multiAssetBuyClient.ts's funding step already
    // created this ATA (it always does, to fund it), harmless either way.
    instructions.push(createAssociatedTokenAccountIdempotentInstruction(user, userAta, user, mint));
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
      // "None" sentinel (DEC-0094 convention) -- same as the single-asset path above.
      managerFeeRecipients: program.programId,
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .remainingAccounts(remainingAccounts)
    .instruction();
  instructions.push(mintIx);

  return { instructions, reserveTokensRequested, assetAmountRaw: requirements.reduce((sum, r) => sum + r.requiredAmount, 0n), requiredAmountsRaw: requirements.map((r) => r.requiredAmount) };
}

export interface BuildDirectRedeemParams {
  program: Program<anchor.Idl>;
  reserve: PublicKey;
  reserveTokenMint: PublicKey;
  vaultAuthority: PublicKey;
  user: PublicKey;
  assets: ZapAssetLeg[];
  reserveTokenSupplyRaw: string;
  redemptionFeeBps: bigint;
  reserveTokensToRedeem: bigint;
}

/** Single-signer, single-instruction direct in-kind redeem -- the on-chain program pays the user's own asset ATA directly, no intermediary. */
export async function buildDirectRedeemInstructions(params: BuildDirectRedeemParams): Promise<DirectInstructionResult> {
  const { program, reserve, reserveTokenMint, vaultAuthority, user } = params;
  const asset = requireSingleAssetReserve(params.assets);
  const mint = new PublicKey(asset.mint);
  const vaultBalance = BigInt(asset.vaultBalanceRaw);
  const totalSupply = BigInt(params.reserveTokenSupplyRaw);

  const feeShares = (params.reserveTokensToRedeem * params.redemptionFeeBps + 9_999n) / 10_000n; // mulDivCeil, protocol-favoring, matches computeRedemptionEntitlements
  const netShares = params.reserveTokensToRedeem - feeShares;
  if (netShares <= 0n) throw new Error("buildDirectRedeemInstructions: redemption fee consumes the entire redeemed amount.");
  const entitlement = (netShares * vaultBalance) / totalSupply; // mulDivFloor, matches computeRedemptionEntitlements

  const redeemerReserveTokenAta = getAssociatedTokenAddressSync(reserveTokenMint, user);
  const userAssetAta = getAssociatedTokenAddressSync(mint, user);
  const [tvlAccrual] = findTvlAccrual(reserve, program.programId);

  const instructions: TransactionInstruction[] = [];
  instructions.push(createAssociatedTokenAccountIdempotentInstruction(user, userAssetAta, user, mint));

  const redeemIx = await program.methods
    .redeemReserveTokensInKind(new BN(params.reserveTokensToRedeem.toString()), [new BN(0)])
    .accounts({
      reserve,
      reserveTokenMint,
      vaultAuthority,
      redeemerReserveTokenAccount: redeemerReserveTokenAta,
      redeemer: user,
      managerFeeRecipients: program.programId, // "None" sentinel, same as the mint path above
      tvlAccrual,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .remainingAccounts([
      { pubkey: new PublicKey(asset.reserveAsset), isWritable: false, isSigner: false },
      { pubkey: new PublicKey(asset.vault), isWritable: true, isSigner: false },
      { pubkey: userAssetAta, isWritable: true, isSigner: false },
      { pubkey: mint, isWritable: false, isSigner: false },
      { pubkey: TOKEN_PROGRAM_ID, isWritable: false, isSigner: false },
    ])
    .instruction();
  instructions.push(redeemIx);

  return { instructions, reserveTokensToRedeem: params.reserveTokensToRedeem, assetAmountRaw: entitlement };
}

export interface BuildDirectMultiAssetRedeemResult {
  /** Idempotent per-leg user-ATA creations first, the single redeem instruction last. */
  instructions: TransactionInstruction[];
  reserveTokensToRedeem: bigint;
  /** Per-leg proportional entitlement (raw), in `assets` order -- the exact floor-rounded amounts the deployed program will pay (computeRedemptionEntitlements). */
  entitlementsRaw: bigint[];
}

/**
 * Multi-asset in-kind redeem (DEC-0158): ONE redeem_reserve_tokens_in_kind
 * call paying the redeemer's proportional entitlement of EVERY registered
 * Reserve asset into their own ATAs -- the exact inverse of
 * buildDirectMultiAssetMintInstructions, using the same deployed-binary
 * account shape (redeem never drifted -- verified instruction-by-instruction
 * in the DEC-0154 pass). Selling to USDC is the caller's next step
 * (multiAssetSellClient.ts swaps each non-USDC leg's entitlement to USDC
 * via Jupiter, ideally inside the same atomic transaction).
 */
export async function buildDirectMultiAssetRedeemInstructions(params: BuildDirectRedeemParams): Promise<BuildDirectMultiAssetRedeemResult> {
  const { program, reserve, reserveTokenMint, vaultAuthority, user, assets } = params;
  if (assets.length < 2) {
    throw new Error(`buildDirectMultiAssetRedeemInstructions requires a genuinely multi-asset Reserve; found ${assets.length}. Use buildDirectRedeemInstructions for a single-asset Reserve instead.`);
  }
  const balances = assets.map((a) => ({ mint: a.mint, vaultBalance: BigInt(a.vaultBalanceRaw) }));
  const entitlements = computeRedemptionEntitlements(
    params.reserveTokensToRedeem,
    params.redemptionFeeBps,
    BigInt(params.reserveTokenSupplyRaw),
    balances,
  );

  const redeemerReserveTokenAta = getAssociatedTokenAddressSync(reserveTokenMint, user);
  const [tvlAccrual] = findTvlAccrual(reserve, program.programId);
  const instructions: TransactionInstruction[] = [];
  const remainingAccounts: { pubkey: PublicKey; isWritable: boolean; isSigner: boolean }[] = [];
  for (const leg of assets) {
    const mint = new PublicKey(leg.mint);
    const userAta = getAssociatedTokenAddressSync(mint, user);
    instructions.push(createAssociatedTokenAccountIdempotentInstruction(user, userAta, user, mint));
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
      // min_asset_amounts_out: 0 per leg, matching every existing redeem
      // caller -- the entitlement math is deterministic from supply/vault
      // balances, and the caller verifies real delivery after confirmation.
      entitlements.map(() => new BN(0)),
    )
    .accounts({
      reserve,
      reserveTokenMint,
      vaultAuthority,
      redeemerReserveTokenAccount: redeemerReserveTokenAta,
      redeemer: user,
      managerFeeRecipients: program.programId, // "None" sentinel, same as the mint path above
      tvlAccrual,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .remainingAccounts(remainingAccounts)
    .instruction();
  instructions.push(redeemIx);

  return { instructions, reserveTokensToRedeem: params.reserveTokensToRedeem, entitlementsRaw: entitlements.map((e) => e.entitlement) };
}
