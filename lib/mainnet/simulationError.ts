// DEC-0290: name the program that actually failed a pre-sign simulation.
//
// describeOnChainError decodes a Custom(n) code against ssr_protocol's own
// error table, but in a one-transaction mint or redemption the failing
// instruction is often a Jupiter swap, whose codes overlap ours: Jupiter 6001 is
// SlippageToleranceExceeded, which read as "SsrError::ZeroValue" (live
// 2026-11-07, SSRES redemption). This looks up the failing instruction's
// program first and explains a Jupiter failure in plain words.
import type { VersionedTransaction } from "@solana/web3.js";
import { describeOnChainError } from "@ssr/sdk";

export const JUPITER_V6_PROGRAM_ID = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";

const JUPITER_ERRORS: Record<number, string> = {
  6001: "the price moved past the slippage limit before the swap could run",
};

/** Pure: the program id of the instruction a simulation error points at, or null. */
export function failingProgramId(tx: VersionedTransaction, err: unknown): string | null {
  const ie = (err as { InstructionError?: [number, unknown] } | null)?.InstructionError;
  if (!Array.isArray(ie) || typeof ie[0] !== "number") return null;
  const ix = tx.message.compiledInstructions[ie[0]];
  if (!ix) return null;
  // Program ids are always static keys in a v0 message (never loaded from a table).
  return tx.message.staticAccountKeys[ix.programIdIndex]?.toBase58() ?? null;
}

/** The user-facing explanation for a failed pre-sign simulation of `tx`. */
export function describeSimulationFailure(tx: VersionedTransaction, err: unknown): string {
  const raw = `Transaction failed on-chain (${JSON.stringify(err)}).`;
  if (failingProgramId(tx, err) === JUPITER_V6_PROGRAM_ID) {
    const custom = ((err as { InstructionError: [number, { Custom?: number }] }).InstructionError[1] ?? {}).Custom;
    const why = (typeof custom === "number" && JUPITER_ERRORS[custom]) || "the swap route failed";
    return `${raw} -- one of the swaps in this transaction would fail: ${why} (Jupiter error ${custom ?? "unknown"}). Try again in a moment; a fresh quote usually goes through.`;
  }
  return describeOnChainError(new Error(raw));
}
