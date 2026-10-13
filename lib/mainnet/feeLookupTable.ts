// DEC-0238: the protocol-wide, FROZEN lookup table holding the fixed accounts
// every USDC-fee mint and seed names, so those transactions stay well under
// Solana's 1232-byte limit even for 10-12 asset Reserves (the fee quote signer
// and the payer's USDC account add bytes a per-Reserve table cannot remove).
// Created once by scripts/create_fee_lookup_table_mainnet.ts; frozen, so it
// can never be changed or closed.
import { AddressLookupTableAccount, ComputeBudgetProgram, Connection, PublicKey, SystemProgram } from "@solana/web3.js";
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { findProtocolConfig, findSettlementKeeperConfig } from "@ssr/sdk";

const PROGRAM_ID = new PublicKey("8hTW7fHwn8t8hcgTVeyAhHMiCTHGUP3783NWUTBBFwH9");
const TREASURY = new PublicKey("3CBpVMPDQD75b5bXgDunkpVJ3EeQWcwU9DCSLsTjWQL5");
const USDC = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");

/** Its address on Mainnet (created and frozen 2026-10-13, signature 7syqHmFJ...vzmvg). */
export const USDC_FEE_LOOKUP_TABLE: string | null = "4EUmenaC82D83UER3iuCuFM8pRxnov2cJ9PfxJ4ku9Fq";

export const USDC_FEE_LOOKUP_TABLE_ADDRESSES: PublicKey[] = [
  TREASURY,
  getAssociatedTokenAddressSync(USDC, TREASURY, true),
  findSettlementKeeperConfig(PROGRAM_ID)[0],
  findProtocolConfig(PROGRAM_ID)[0],
  USDC,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  SystemProgram.programId,
  ComputeBudgetProgram.programId,
];

/** The fee table as a lookup-table account, or none if it cannot be read (the build then compiles without it). */
export async function loadFeeLookupTable(connection: Connection): Promise<AddressLookupTableAccount[]> {
  if (!USDC_FEE_LOOKUP_TABLE) return [];
  try {
    const res = await connection.getAddressLookupTable(new PublicKey(USDC_FEE_LOOKUP_TABLE));
    return res.value ? [res.value] : [];
  } catch {
    return [];
  }
}
