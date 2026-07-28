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
//   3) SPL mintTo per asset leg, authority=swapAuthority, destination=user's ATA
//   4) mint_reserve_tokens_in_kind, signer=user (depositor)
//
// Sell = proportional protocol redeem followed by a zap into SOL:
//   1) redeem_reserve_tokens_in_kind, signer=user (redeemer) -- assets land in the user's own ATAs
//   2) idempotent-create swapAuthority's per-asset ATAs
//   3) SPL transfer per asset leg: user -> swapAuthority (the "assets out" leg)
//   4) SystemProgram.transfer: swapAuthority -> user (the "SOL out" leg)
import { PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createMintToInstruction,
  createTransferInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import * as anchor from "@anchor-lang/core";
import { BN } from "@anchor-lang/core";
import type { Program } from "@anchor-lang/core";
import { computeMintRequirements, computeRedemptionEntitlements, mulDivCeil, type AssetBalance } from "./calculations";
import { solLamportsToUsd, SOL_TEST_PRICE_USD } from "./zapPricing";

export interface ZapAssetLeg {
  mint: string;
  decimals: number;
  reserveAsset: string;
  vault: string;
  vaultBalanceRaw: string;
}

export interface BuildBuyZapParams {
  program: Program<anchor.Idl>;
  protocolConfig: PublicKey;
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
  const { program, protocolConfig, reserve, reserveTokenMint, mintAuthority, user, swapAuthority, assets, reserveTokenSupplyRaw } = params;

  const reserveTokensRequested = solToReserveTokensRequested(params.solLamports, reserveTokenSupplyRaw, assets, params.assetTestPricesUsd);

  const balances: AssetBalance[] = assets.map((a) => ({ mint: a.mint, vaultBalance: BigInt(a.vaultBalanceRaw) }));
  const requirements = computeMintRequirements(reserveTokensRequested, BigInt(reserveTokenSupplyRaw), balances);
  const slippageBps = BigInt(Math.round((params.slippageBps ?? 0.02) * 10_000));
  const maxAssetAmounts = requirements.map((r) => mulDivCeil(r.requiredAmount, 10_000n + slippageBps, 10_000n));

  const instructions: TransactionInstruction[] = [];

  const depositorReserveTokenAta = getAssociatedTokenAddressSync(reserveTokenMint, user);
  instructions.push(createAssociatedTokenAccountIdempotentInstruction(user, depositorReserveTokenAta, user, reserveTokenMint));

  const remainingAccounts: { pubkey: PublicKey; isWritable: boolean; isSigner: boolean }[] = [];
  for (let i = 0; i < assets.length; i++) {
    const leg = assets[i];
    const mint = new PublicKey(leg.mint);
    const userAta = getAssociatedTokenAddressSync(mint, user);
    instructions.push(createAssociatedTokenAccountIdempotentInstruction(user, userAta, user, mint));
    instructions.push(createMintToInstruction(mint, userAta, swapAuthority, requirements[i].requiredAmount));
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
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .remainingAccounts(remainingAccounts)
    .instruction();
  instructions.push(mintIx);

  return { instructions, reserveTokensRequested, assetAmountsRaw: requirements.map((r) => r.requiredAmount) };
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
      tokenProgram: TOKEN_PROGRAM_ID,
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
