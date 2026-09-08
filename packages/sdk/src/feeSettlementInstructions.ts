// USDC fee-settlement pipeline (2026-08-21 pass, see
// docs/project/DECISION_LOG.md) -- client-side instruction builders for the
// four new on-chain instructions (setFeeSettlementKeeper,
// redeemFeeVaultShares, approveSettlementSwap, distributeFeeUsdc). Every
// function here returns an unsigned TransactionInstruction (same pattern as
// managementInstructions.ts/directInstructions.ts) -- the caller assembles a
// Transaction, gets it signed, and submits it. The program never signs a
// swap; approveSettlementSwap only grants a bounded SPL delegate approval to
// the configured keeper wallet, which then builds/signs an ordinary Jupiter
// swap transaction off-chain (see the keeper script for that leg).
import { PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import * as anchor from "@anchor-lang/core";
import type { Program } from "@anchor-lang/core";
import {
  findProtocolConfig,
  findFeeSettlement,
  findFeeVaultAuthority,
  findSettlementAuthority,
  findSettlementKeeperConfig,
  findManagerFeeRecipients,
} from "./pda";
import type { ZapAssetLeg } from "./zapInstructions";

export async function buildSetFeeSettlementKeeperInstruction(
  program: Program<anchor.Idl>,
  programId: PublicKey,
  authority: PublicKey,
  newKeeper: PublicKey,
): Promise<TransactionInstruction> {
  const [protocolConfig] = findProtocolConfig(programId);
  const [settlementKeeperConfig] = findSettlementKeeperConfig(programId);
  return program.methods
    .setFeeSettlementKeeper(newKeeper)
    .accounts({ protocolConfig, settlementKeeperConfig, authority, systemProgram: SystemProgram.programId })
    .instruction();
}

export interface BuildRedeemFeeVaultSharesParams {
  program: Program<anchor.Idl>;
  programId: PublicKey;
  reserve: PublicKey;
  reserveTokenMint: PublicKey;
  vaultAuthority: PublicKey;
  payer: PublicKey;
  /** Every one of the Reserve's registered assets, in order_index order -- see instructions/common.rs::load_asset_legs. */
  assets: ZapAssetLeg[];
  shares: bigint;
}

/**
 * Burns `shares` from the shared fee vault and stages the proportional
 * per-asset entitlement into each asset's own settlement staging ATA (see
 * redeem_fee_vault_shares.rs). Permissionless -- `payer` just signs/fronts
 * the transaction fee and any new staging-ATA rent, never receives anything
 * itself. The caller's transaction must separately bundle an idempotent
 * ATA-creation instruction for each staging ATA the first time it's used
 * (see createAssociatedTokenAccountIdempotentInstruction) -- not built here,
 * matching every other asset-leg builder in this SDK.
 */
export async function buildRedeemFeeVaultSharesInstruction(params: BuildRedeemFeeVaultSharesParams): Promise<TransactionInstruction> {
  const { program, programId, reserve, reserveTokenMint, vaultAuthority, payer, assets, shares } = params;
  const [feeSettlement] = findFeeSettlement(reserve, programId);
  const [feeVaultAuthority] = findFeeVaultAuthority(reserve, programId);
  const [settlementAuthority] = findSettlementAuthority(reserve, programId);
  const feeVault = getAssociatedTokenAddressSync(reserveTokenMint, feeVaultAuthority, true);

  const remainingAccounts = assets.flatMap((asset) => {
    const mint = new PublicKey(asset.mint);
    const stagingAta = getAssociatedTokenAddressSync(mint, settlementAuthority, true);
    return [
      { pubkey: new PublicKey(asset.reserveAsset), isWritable: false, isSigner: false },
      { pubkey: new PublicKey(asset.vault), isWritable: true, isSigner: false },
      { pubkey: stagingAta, isWritable: true, isSigner: false },
      { pubkey: mint, isWritable: false, isSigner: false },
      { pubkey: TOKEN_PROGRAM_ID, isWritable: false, isSigner: false },
    ];
  });

  return program.methods
    .redeemFeeVaultShares(new anchor.BN(shares.toString()))
    .accounts({
      reserve,
      reserveTokenMint,
      feeSettlement,
      feeVault,
      feeVaultAuthority,
      settlementAuthority,
      vaultAuthority,
      payer,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .remainingAccounts(remainingAccounts)
    .instruction();
}

export interface BuildApproveSettlementSwapParams {
  program: Program<anchor.Idl>;
  programId: PublicKey;
  reserve: PublicKey;
  assetMint: PublicKey;
  keeper: PublicKey;
  amount: bigint;
}

/**
 * Keeper-gated (see the program's own header on approve_settlement_swap.rs):
 * grants exactly `amount` as an SPL delegate approval on one asset's
 * settlement staging ATA to the configured keeper wallet. `keeper` must be
 * the signer submitting this transaction AND must equal
 * ProtocolConfig.feeSettlementKeeper -- enforced on-chain, not just here.
 */
export async function buildApproveSettlementSwapInstruction(params: BuildApproveSettlementSwapParams): Promise<TransactionInstruction> {
  const { program, programId, reserve, assetMint, keeper, amount } = params;
  const [settlementKeeperConfig] = findSettlementKeeperConfig(programId);
  const [settlementAuthority] = findSettlementAuthority(reserve, programId);
  const stagingAta = getAssociatedTokenAddressSync(assetMint, settlementAuthority, true);

  return program.methods
    .approveSettlementSwap(new anchor.BN(amount.toString()))
    .accounts({
      settlementKeeperConfig,
      reserve,
      assetMint,
      stagingAta,
      settlementAuthority,
      keeper,
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
    })
    .instruction();
}

export interface FeeSettlementManagerRecipient {
  wallet: string;
}

export interface BuildDistributeFeeUsdcParams {
  program: Program<anchor.Idl>;
  programId: PublicKey;
  reserve: PublicKey;
  usdcMint: PublicKey;
  protocolFeeDestination: PublicKey;
  payer: PublicKey;
  /** Pass the Reserve's configured multi-recipient list (in slot order) if it has opted in, or omit/pass [] to use the legacy single `feeDestination` -- see distribute_fee_usdc.rs's header for the exact None-sentinel semantics. */
  managerRecipients: FeeSettlementManagerRecipient[];
  /** Required only when `managerRecipients` is empty (legacy single-destination Reserve) -- the Reserve's own `feeConfig.feeDestination`. */
  legacyManagerDestination?: PublicKey;
}

/**
 * Pays out whatever USDC is currently staged to the Protocol Treasury and
 * the Reserve's configured Manager fee recipient(s) -- permissionless,
 * idempotent (see distribute_fee_usdc.rs's own header for why a zero
 * staging balance is a safe, harmless no-op, never an error).
 */
export async function buildDistributeFeeUsdcInstruction(params: BuildDistributeFeeUsdcParams): Promise<TransactionInstruction> {
  const { program, programId, reserve, usdcMint, protocolFeeDestination, payer, managerRecipients, legacyManagerDestination } = params;
  const [protocolConfig] = findProtocolConfig(programId);
  const [feeSettlement] = findFeeSettlement(reserve, programId);
  const [settlementAuthority] = findSettlementAuthority(reserve, programId);
  const [managerFeeRecipients] = findManagerFeeRecipients(reserve, programId);
  const usdcStagingAta = getAssociatedTokenAddressSync(usdcMint, settlementAuthority, true);
  // allowOwnerOffCurve: the Protocol Treasury is the Squads vault, an OFF-CURVE
  // PDA (DEC-0112). Without the flag spl-token throws TokenOwnerOffCurveError
  // (with an empty message) -- live 2026-09-08 this silently blocked every
  // distribute_fee_usdc in the keeper. Recipients may be PDAs too.
  const protocolUsdcDestination = getAssociatedTokenAddressSync(usdcMint, protocolFeeDestination, true);

  const usesMultiRecipient = managerRecipients.length > 0;
  const remainingAccounts = usesMultiRecipient
    ? managerRecipients.map((r) => ({
        pubkey: getAssociatedTokenAddressSync(usdcMint, new PublicKey(r.wallet), true),
        isWritable: true,
        isSigner: false,
      }))
    : [
        {
          pubkey: getAssociatedTokenAddressSync(usdcMint, legacyManagerDestination ?? (() => { throw new Error("buildDistributeFeeUsdcInstruction: legacyManagerDestination is required when managerRecipients is empty."); })(), true),
          isWritable: true,
          isSigner: false,
        },
      ];

  return program.methods
    .distributeFeeUsdc()
    .accounts({
      protocolConfig,
      reserve,
      feeSettlement,
      usdcMint,
      usdcStagingAta,
      settlementAuthority,
      protocolUsdcDestination,
      protocolFeeDestination,
      // "None" sentinel (DEC-0094 convention) when this Reserve hasn't opted
      // into multi-recipient routing.
      managerFeeRecipients: usesMultiRecipient ? managerFeeRecipients : programId,
      payer,
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .remainingAccounts(remainingAccounts)
    .instruction();
}
