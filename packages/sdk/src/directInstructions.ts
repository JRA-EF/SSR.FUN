// Mainnet-native Buy/Sell: a direct, single-signer, single-asset in-kind
// deposit/withdrawal against a Reserve whose sole underlying asset is USDC
// (or any other single settlement asset) -- no server-held swap authority,
// no minted/fabricated legs, no price oracle. This exists because
// zapInstructions.ts's DevNet zap fundamentally depends on a swap authority
// that can mint fake test tokens for legs the user doesn't already hold --
// there is no equivalent for a real Mainnet asset like USDC, and Creator has
// scoped Mainnet Reserves to a single primary settlement asset "for
// simplicity for now" (see docs/project/DECISION_LOG.md's Mainnet-launch
// entry), so no swap is needed at all: the user's own deposit IS the
// Reserve's sole required leg.
//
// Deliberately does not attempt to generalize to a multi-asset Reserve --
// see requireSingleAssetReserve below, which fails loudly rather than
// silently mis-computing a partial deposit if that assumption ever stops
// holding.

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

export interface DirectInstructionResult {
  instructions: TransactionInstruction[];
  reserveTokensRequested?: bigint;
  reserveTokensToRedeem?: bigint;
  assetAmountRaw: bigint;
}

/** Fails loudly (never silently mis-prices a partial deposit) if the Reserve isn't genuinely single-asset. */
function requireSingleAssetReserve(assets: ZapAssetLeg[]): ZapAssetLeg {
  if (assets.length !== 1) {
    throw new Error(
      `directInstructions requires a single-asset Reserve; found ${assets.length} assets. This Reserve needs the zap path (zapInstructions.ts), not the direct path.`,
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
