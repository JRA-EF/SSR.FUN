// Swap packing: put several Jupiter swap legs in ONE transaction where they fit.
//
// A 10-asset mint used to build one transaction per swap (plus the mint), so
// the wallet signed 11+ transactions and the network had to land all of them.
// Most legs, quoted with a capped account budget (maxAccounts), are small
// enough that two or three share a transaction comfortably. Fewer
// transactions means fewer things to confirm, fewer partial states, and a
// shorter list in the wallet prompt.
//
// Each packed transaction is atomic: either all of its swaps land or none do,
// so a retry rebuilds exactly the legs of the transactions that did not land.
//
// Limits that decide a pack (all checked, none assumed):
//   - 1232 bytes on the wire (fitsV0, with the union of the legs' tables),
//   - 64 account locks (lookup tables shrink bytes, never this count),
//   - the compute budget: ~400k CU per routed swap, 1.4M per transaction.
import { ComputeBudgetProgram, type AddressLookupTableAccount, type PublicKey, type TransactionInstruction } from "@solana/web3.js";
import { countAccountLocks, SINGLE_TX_MICRO_LAMPORTS_PER_CU, SOLANA_MAX_TX_ACCOUNT_LOCKS } from "../../src/merge/lib/singleTxBuy";
import { fitsV0 } from "./buildCommon";

/** Compute reserved per routed swap leg (observed ~200-400k). */
export const PACK_CU_PER_SWAP = 400_000;
/** Solana's per-transaction compute ceiling. */
export const MAX_TX_COMPUTE_UNITS = 1_400_000;
/** At most this many swaps share one transaction (the compute budget allows 3). */
export const MAX_SWAPS_PER_PACK = Math.floor(MAX_TX_COMPUTE_UNITS / PACK_CU_PER_SWAP);

export interface PackableLeg {
  /** The leg's setup + swap instructions, compute-budget instructions already removed. */
  instructions: TransactionInstruction[];
  /** The lookup tables its route compiles against. */
  tables: AddressLookupTableAccount[];
}

export function packBudgetInstructions(legCount: number): TransactionInstruction[] {
  return [
    ComputeBudgetProgram.setComputeUnitLimit({ units: Math.min(MAX_TX_COMPUTE_UNITS, PACK_CU_PER_SWAP * legCount) }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: SINGLE_TX_MICRO_LAMPORTS_PER_CU }),
  ];
}

function uniqueTables(tables: AddressLookupTableAccount[]): AddressLookupTableAccount[] {
  const seen = new Set<string>();
  return tables.filter((t) => {
    const k = t.key.toBase58();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** The instructions and tables of one pack, ready to compile. */
export function packContents(legs: PackableLeg[], extraTables: AddressLookupTableAccount[] = []): { instructions: TransactionInstruction[]; tables: AddressLookupTableAccount[] } {
  return {
    instructions: [...packBudgetInstructions(legs.length), ...legs.flatMap((l) => l.instructions)],
    tables: uniqueTables([...legs.flatMap((l) => l.tables), ...extraTables]),
  };
}

export function packFits(payer: PublicKey, legs: PackableLeg[], extraTables: AddressLookupTableAccount[] = []): boolean {
  if (legs.length > MAX_SWAPS_PER_PACK) return false;
  const { instructions, tables } = packContents(legs, extraTables);
  if (countAccountLocks(payer, instructions) > SOLANA_MAX_TX_ACCOUNT_LOCKS) return false;
  return fitsV0(payer, instructions, tables);
}

/**
 * Greedy first-fit: each leg joins the first existing pack it fits in, else
 * starts a new one. Returns groups of leg indexes. A leg that does not fit
 * even alone still gets its own group -- the caller builds it the old way
 * (Jupiter's own full transaction), which is never worse than before.
 */
export function packSwapLegs(payer: PublicKey, legs: PackableLeg[], extraTables: AddressLookupTableAccount[] = []): number[][] {
  const packs: number[][] = [];
  for (let i = 0; i < legs.length; i++) {
    const home = packs.find((p) => packFits(payer, [...p.map((j) => legs[j]), legs[i]], extraTables));
    if (home) home.push(i);
    else packs.push([i]);
  }
  return packs;
}
