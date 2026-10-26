// DEC-0257: the creator's trade tax, carried by the Reserve Token's
// Token-2022 transfer fee so Jupiter, bots and direct Raydium swaps pay it.
//
// - enable_trade_tax: only in the pool launch transaction, after
//   configure_liquidity_revenue_v2. Sets the mint's fee to the protocol rate
//   plus the larger of the pool's Buy/Sell rates (effective two epochs later)
//   and zeroes the swap wrapper's rates.
// - collect_trade_tax: permissionless; replaces collect_transfer_fees for
//   these mints (which now refuses them). Splits withheld fees: protocol part
//   + 20% of the tax to the SSR treasury, the creator's 80% to the pool's
//   treasury, the holder share of it burned.
import { PublicKey, SystemProgram, TransactionInstruction, type AccountMeta } from "@solana/web3.js";
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { findProtocolConfig, findReserveTokenMint, findTransferFeeAuthority } from "./pda";
import { findLiquidityRevenue, findLiquidityTerms, holderPart, SSR_CREATOR_SHARE_BPS } from "./liquidityRevenue";

export const TRADE_TAX_SEED = "trade_tax";
export const TRADE_TAX_MAX_BPS = 200;
export const TRADE_TAX_SIZE = 8 + 32 * 3 + 2 * 3 + 8 * 3 + 1;
/** collect_trade_tax carries 14 fixed accounts; this many harvest sources still fit one transaction. */
export const MAX_TRADE_TAX_HARVEST_SOURCES = 16;

const DISCRIMINATORS = {
  enable: Buffer.from([189, 133, 54, 242, 77, 43, 176, 231]),
  collect: Buffer.from([201, 9, 105, 77, 200, 221, 136, 254]),
  account: Buffer.from([207, 216, 73, 70, 44, 28, 233, 84]),
};
const INSTRUCTIONS_SYSVAR = new PublicKey("Sysvar1nstructions1111111111111111111111111");
const meta = (pubkey: PublicKey, isWritable = false, isSigner = false): AccountMeta => ({ pubkey, isWritable, isSigner });

export function findTradeTax(reserve: PublicKey, programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from(TRADE_TAX_SEED), reserve.toBuffer()], programId)[0];
}

export interface TradeTaxState {
  reserve: PublicKey; revenue: PublicKey; treasury: PublicKey;
  taxBps: number; protocolBps: number; holderShareBps: number;
  totalProtocol: bigint; totalCreator: bigint; totalBurned: bigint;
}
export function decodeTradeTax(data: Buffer): TradeTaxState {
  if (data.length < TRADE_TAX_SIZE || !data.subarray(0, 8).equals(DISCRIMINATORS.account)) throw new Error("Not a TradeTax account");
  return {
    reserve: new PublicKey(data.subarray(8, 40)), revenue: new PublicKey(data.subarray(40, 72)), treasury: new PublicKey(data.subarray(72, 104)),
    taxBps: data.readUInt16LE(104), protocolBps: data.readUInt16LE(106), holderShareBps: data.readUInt16LE(108),
    totalProtocol: data.readBigUInt64LE(110), totalCreator: data.readBigUInt64LE(118), totalBurned: data.readBigUInt64LE(126),
  };
}

/** Mirrors `trade_tax_split`: (SSR, creator, burned) of `withheld` collected while the mint charged `feeBps`. */
export function splitTradeTax(withheld: bigint, feeBps: number, protocolBps: number, holderShareBps: number) {
  if (feeBps <= protocolBps || withheld === 0n) return { protocol: withheld, creator: 0n, burned: 0n };
  const protocolPart = (withheld * BigInt(protocolBps)) / BigInt(feeBps);
  const tax = withheld - protocolPart;
  const creatorAll = (tax * BigInt(10_000 - SSR_CREATOR_SHARE_BPS)) / 10_000n;
  const burned = holderPart(creatorAll, holderShareBps);
  return { protocol: withheld - creatorAll, creator: creatorAll - burned, burned };
}

/** Must follow `buildConfigureLiquidityRevenueV2` in the same transaction (the program refuses it otherwise). */
export function buildEnableTradeTax(input: { programId: PublicKey; manager: PublicKey; reserve: PublicKey }) {
  const { programId, reserve } = input;
  const revenue = findLiquidityRevenue(reserve, programId);
  return new TransactionInstruction({
    programId, data: DISCRIMINATORS.enable,
    keys: [meta(input.manager, true, true), meta(findProtocolConfig(programId)[0]), meta(reserve), meta(revenue, true),
      meta(findLiquidityTerms(reserve, programId)), meta(findTradeTax(reserve, programId), true),
      meta(findReserveTokenMint(reserve, programId)[0], true), meta(findTransferFeeAuthority(programId)[0]),
      meta(INSTRUCTIONS_SYSVAR), meta(TOKEN_2022_PROGRAM_ID), meta(SystemProgram.programId)],
  });
}

export function buildCollectTradeTax(input: {
  programId: PublicKey; reserve: PublicKey;
  /** ProtocolConfig.defaultProtocolFeeDestination, read live -- the program rejects any other wallet. */
  protocolTreasury: PublicKey;
  /** TradeTax.treasury, read live -- the program rejects any other wallet. */
  creatorTreasury: PublicKey;
  payer: PublicKey;
  /** Token accounts of this mint holding withheld fees. May be empty. */
  harvestSources?: PublicKey[];
}) {
  const { programId, reserve } = input;
  const sources = input.harvestSources ?? [];
  if (sources.length > MAX_TRADE_TAX_HARVEST_SOURCES) throw new Error(`At most ${MAX_TRADE_TAX_HARVEST_SOURCES} harvest sources per transaction; got ${sources.length}.`);
  const mint = findReserveTokenMint(reserve, programId)[0];
  const tradeTax = findTradeTax(reserve, programId);
  const ataOf = (owner: PublicKey) => getAssociatedTokenAddressSync(mint, owner, true, TOKEN_2022_PROGRAM_ID);
  return new TransactionInstruction({
    programId, data: DISCRIMINATORS.collect,
    keys: [meta(findProtocolConfig(programId)[0]), meta(reserve), meta(tradeTax, true), meta(mint, true),
      meta(findTransferFeeAuthority(programId)[0]), meta(ataOf(tradeTax), true),
      meta(input.protocolTreasury), meta(ataOf(input.protocolTreasury), true),
      meta(input.creatorTreasury), meta(ataOf(input.creatorTreasury), true),
      meta(input.payer, true, true), meta(TOKEN_2022_PROGRAM_ID), meta(ASSOCIATED_TOKEN_PROGRAM_ID), meta(SystemProgram.programId),
      ...sources.map((s) => meta(s, true))],
  });
}
