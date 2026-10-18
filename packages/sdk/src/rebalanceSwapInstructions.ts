// DEC-0250: builders for the real Mainnet rebalance (programs/ssr_protocol/
// src/instructions/rebalance_swap.rs and remove_reserve_asset_compact.rs).
//
// One rebalance swap is ONE transaction:
//   rebalance_swap_begin -> the swap route (Jupiter) -> rebalance_swap_end
// begin lends the sell asset from its vault to the signer, the route turns it
// into the buy asset in the signer's account, end deposits what arrived
// (at least min_out, set by SSR's fee quote signer) into the buy vault.
import { PublicKey, SystemProgram, SYSVAR_INSTRUCTIONS_PUBKEY, TransactionInstruction } from "@solana/web3.js";
import * as anchor from "@anchor-lang/core";
import { BN } from "@anchor-lang/core";
import type { Program } from "@anchor-lang/core";
import { findReserveAsset, findReserveVault, findSettlementKeeperConfig, findVaultAuthority } from "./pda";
import { resolveLegTokenProgram } from "./tokenPrograms";

export const REBALANCE_TICKET_SEED = Buffer.from("rebalance_ticket");

export function findRebalanceTicket(reserve: PublicKey, programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([REBALANCE_TICKET_SEED, reserve.toBuffer()], programId);
}

export interface RebalanceSwapBeginInput {
  reserve: PublicKey;
  signer: PublicKey;
  /** The signer's co-manager record (`findDelegate`); any address when the signer is the root Manager. */
  delegate: PublicKey;
  mintSell: PublicKey;
  mintBuy: PublicKey;
  /** The signer's token account for the sell asset (receives the loan). */
  signerSellAccount: PublicKey;
  /** The signer's token account for the buy asset (the swap pays into it). */
  signerBuyAccount: PublicKey;
  /** Token program of the sell mint; omit for classic SPL Token. */
  tokenProgramSell?: PublicKey | null;
  feeQuoteSigner: PublicKey;
  amountIn: bigint;
  minOut: bigint;
}

export async function buildRebalanceSwapBeginInstruction(program: Program<anchor.Idl>, programId: PublicKey, p: RebalanceSwapBeginInput): Promise<TransactionInstruction> {
  return program.methods
    .rebalanceSwapBegin(new BN(p.amountIn.toString()), new BN(p.minOut.toString()))
    .accountsStrict({
      reserve: p.reserve,
      delegate: p.delegate,
      signer: p.signer,
      reserveAssetSell: findReserveAsset(p.reserve, p.mintSell, programId)[0],
      vaultSell: findReserveVault(p.reserve, p.mintSell, programId)[0],
      mintSell: p.mintSell,
      signerSellAccount: p.signerSellAccount,
      reserveAssetBuy: findReserveAsset(p.reserve, p.mintBuy, programId)[0],
      vaultBuy: findReserveVault(p.reserve, p.mintBuy, programId)[0],
      mintBuy: p.mintBuy,
      signerBuyAccount: p.signerBuyAccount,
      vaultAuthority: findVaultAuthority(p.reserve, programId)[0],
      ticket: findRebalanceTicket(p.reserve, programId)[0],
      settlementKeeperConfig: findSettlementKeeperConfig(programId)[0],
      feeQuoteSigner: p.feeQuoteSigner,
      instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
      tokenProgramSell: resolveLegTokenProgram({ tokenProgram: p.tokenProgramSell ?? null }),
      systemProgram: SystemProgram.programId,
    })
    .instruction();
}

export interface RebalanceSwapEndInput {
  reserve: PublicKey;
  signer: PublicKey;
  mintBuy: PublicKey;
  signerBuyAccount: PublicKey;
  tokenProgramBuy?: PublicKey | null;
}

export async function buildRebalanceSwapEndInstruction(program: Program<anchor.Idl>, programId: PublicKey, p: RebalanceSwapEndInput): Promise<TransactionInstruction> {
  return program.methods
    .rebalanceSwapEnd()
    .accountsStrict({
      reserve: p.reserve,
      signer: p.signer,
      ticket: findRebalanceTicket(p.reserve, programId)[0],
      mintBuy: p.mintBuy,
      signerBuyAccount: p.signerBuyAccount,
      vaultBuy: findReserveVault(p.reserve, p.mintBuy, programId)[0],
      tokenProgramBuy: resolveLegTokenProgram({ tokenProgram: p.tokenProgramBuy ?? null }),
    })
    .instruction();
}

export interface RemoveReserveAssetCompactInput {
  reserve: PublicKey;
  reserveManager: PublicKey;
  signer: PublicKey;
  delegate: PublicKey;
  assetMint: PublicKey;
  assetTokenProgram?: PublicKey | null;
  /** Mint of the last-registered asset when it is a DIFFERENT asset (it takes over the freed position); null when removing the last one. */
  lastAssetMint: PublicKey | null;
}

export async function buildRemoveReserveAssetCompactInstruction(program: Program<anchor.Idl>, programId: PublicKey, p: RemoveReserveAssetCompactInput): Promise<TransactionInstruction> {
  return program.methods
    .removeReserveAssetCompact()
    .accountsStrict({
      reserve: p.reserve,
      reserveAsset: findReserveAsset(p.reserve, p.assetMint, programId)[0],
      assetMint: p.assetMint,
      vault: findReserveVault(p.reserve, p.assetMint, programId)[0],
      // Anchor encodes an omitted optional account as the program id.
      lastReserveAsset: p.lastAssetMint ? findReserveAsset(p.reserve, p.lastAssetMint, programId)[0] : programId,
      vaultAuthority: findVaultAuthority(p.reserve, programId)[0],
      manager: p.reserveManager,
      delegate: p.delegate,
      signer: p.signer,
      tokenProgram: resolveLegTokenProgram({ tokenProgram: p.assetTokenProgram ?? null }),
    })
    .instruction();
}
