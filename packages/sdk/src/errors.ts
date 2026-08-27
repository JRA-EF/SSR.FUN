// Honest, IDL-backed decoding of raw on-chain program errors -- added after
// a live DevNet failure was reported as "InstructionError / Custom 6400"
// during Reserve seed-funding. Investigation found that code does not exist
// anywhere in ssr_protocol: this program declares only 41 custom errors
// (Anchor numbers them sequentially from 6000), so its entire custom-error
// range is 6000-6040 -- confirmed against both errors.rs and this bundled
// IDL. 6400 cannot be a genuine ssr_protocol error under the deployed
// program. Rather than ever again guess at what an error code "probably"
// means, this module decodes a real code against the real IDL and, when the
// code isn't defined here, says so explicitly instead of fabricating a
// meaning -- see describeOnChainError.
import idl from "../idl/ssr_protocol.json";
import { anchorFrameworkErrorRange, decodeAnchorFrameworkError } from "./anchorFrameworkErrors";

export interface DecodedProgramError {
  code: number;
  name: string;
  msg: string;
}

const SSR_PROTOCOL_ERRORS: DecodedProgramError[] = ((idl as { errors?: DecodedProgramError[] }).errors ?? []) as DecodedProgramError[];

/** Looks up a raw Anchor custom-error code against the real, deployed ssr_protocol IDL. Returns null if the code isn't defined -- never guesses at a nearby/similar one. */
export function decodeSsrProtocolError(code: number): DecodedProgramError | null {
  return SSR_PROTOCOL_ERRORS.find((e) => e.code === code) ?? null;
}

/** The exact custom-error code range this program's IDL actually defines, for honest reporting of an out-of-range code. Empty IDL reports "none defined" rather than a fabricated range. */
export function ssrProtocolErrorCodeRange(): string {
  if (SSR_PROTOCOL_ERRORS.length === 0) return "none defined";
  const codes = SSR_PROTOCOL_ERRORS.map((e) => e.code);
  return `${Math.min(...codes)}-${Math.max(...codes)}`;
}

/**
 * Extracts a `Custom(N)` program-error code from any of the shapes this app
 * actually encounters it in: a raw `{ InstructionError: [ix, { Custom: N }] }`
 * object (e.g. `status.err` from `getSignatureStatuses`), that same shape
 * already JSON-stringified (e.g. `confirmSignatureBounded`'s `outcome.error`),
 * or a wallet-adapter/web3.js message containing the cluster's own
 * "custom program error: 0x.." text. Returns null -- never a guessed code --
 * when none of these shapes match.
 */
export function extractCustomErrorCode(err: unknown): number | null {
  const fromObject = (val: unknown): number | null => {
    if (!val || typeof val !== "object") return null;
    const instructionError = (val as { InstructionError?: unknown }).InstructionError;
    if (Array.isArray(instructionError) && instructionError[1] && typeof instructionError[1] === "object" && "Custom" in (instructionError[1] as object)) {
      const n = (instructionError[1] as { Custom?: unknown }).Custom;
      return typeof n === "number" ? n : null;
    }
    return null;
  };

  if (err && typeof err === "object") {
    const direct = fromObject(err) ?? fromObject((err as { err?: unknown }).err);
    if (direct !== null) return direct;
  }

  const text = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  if (!text) return null;

  const jsonMatch = text.match(/\{"InstructionError"[\s\S]*?\}\s*\}/);
  if (jsonMatch) {
    try {
      const parsed: unknown = JSON.parse(jsonMatch[0]);
      const fromJson = fromObject(parsed);
      if (fromJson !== null) return fromJson;
    } catch {
      // Not valid JSON after all -- fall through to the plainer text patterns below.
    }
  }
  const customFieldMatch = text.match(/"Custom":\s*(\d+)/);
  if (customFieldMatch) return parseInt(customFieldMatch[1], 10);
  const hexMatch = text.match(/custom program error:\s*0x([0-9a-fA-F]+)/i);
  if (hexMatch) return parseInt(hexMatch[1], 16);
  const callMatch = text.match(/Custom\((\d+)\)/);
  if (callMatch) return parseInt(callMatch[1], 10);
  return null;
}

/**
 * Best-effort, honest translation of a raw on-chain error into a human
 * message: decodes a recognized ssr_protocol custom-error code into its real
 * name and message, or -- critically -- says plainly that an unrecognized
 * code is NOT a genuine ssr_protocol error rather than inventing a meaning
 * for it. Always returns at least the original message unchanged if no
 * error code can be extracted at all.
 */
export function describeOnChainError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  // ProgramFailedToComplete is a runtime wrapper, not a program error code --
  // in every live occurrence in this project it has meant compute-budget
  // exhaustion ("exceeded CUs meter": DEC-0166, the 10-asset DELTA seed run
  // under the default ~200k budget with no setComputeUnitLimit requested).
  // Decode it into the real explanation instead of surfacing the bare
  // wrapper, which reads like an inscrutable program crash.
  if (raw.includes("ProgramFailedToComplete")) {
    return `${raw} -- the program ran out of compute budget mid-instruction (the transaction did not request a compute-unit limit large enough for this operation). Nothing was changed on-chain: a failed Solana transaction rolls back atomically. Retrying the identical transaction will fail identically; it must be rebuilt with an explicit, sufficient compute-unit limit.`;
  }
  const code = extractCustomErrorCode(err);
  if (code === null) return raw;
  const decoded = decodeSsrProtocolError(code);
  if (decoded) return `${raw} -- SsrError::${decoded.name} (${decoded.code}): ${decoded.msg}`;
  // ssr_protocol's own custom errors start at 6000 (ERROR_CODE_OFFSET) --
  // anything below that is one of Anchor's OWN framework error codes
  // (instruction dispatch, IDL, account constraints, require! macros,
  // account deserialization/ownership), not a custom error this program
  // defined at all. Decode it against that table instead of just reporting
  // "not defined" -- see anchorFrameworkErrors.ts, added after a live
  // DevNet "Custom 2040" report traced to exactly
  // ConstraintDuplicateMutableAccount this way.
  const framework = decodeAnchorFrameworkError(code);
  if (framework) {
    return `${raw} -- Anchor::${framework.name} (${framework.code}): ${framework.msg} This is a framework-level error from the Anchor library itself (${anchorFrameworkErrorRange(code)}), not a custom ssr_protocol error -- it originates from the ssr_protocol program's own account-validation code (auto-generated by its #[derive(Accounts)] structs), not from a different program.`;
  }
  const splToken = decodeSplTokenError(code);
  if (splToken) {
    return `${raw} -- most likely SPL Token error ${code} (${splToken.name}: ${splToken.msg}) raised by a token operation INSIDE the failing instruction (an inner CPI -- e.g. one of the mint's deposit transfers), not by ssr_protocol's own logic. Codes this small exist in several native programs, so confirm against the transaction's own logs on Explorer ("Program log: Error: ..." names the real cause). Confirmed live 2026-08-26: a mint failing Custom(1) was exactly an inner token transfer with insufficient funds.`;
  }
  return `${raw} -- program error code ${code} is not defined anywhere in the deployed SSR Protocol IDL (its custom-error range is ${ssrProtocolErrorCodeRange()}) or in Anchor's own framework error table. This is not a genuine ssr_protocol error -- check whether another program in the same transaction produced it, or whether the deployed program binary has drifted from this IDL.`;
}

// SPL Token program error table (token/program/src/error.rs) -- the inner
// CPIs every ssr_protocol deposit/mint/redeem performs are token-program
// operations, and their errors bubble up as the OUTER instruction's own
// tiny Custom code (live 2026-08-26: InstructionError[5,{Custom:1}] on a
// mint was the deposit transfer's "Error: insufficient funds"). Decoded
// with an explicit most-likely hedge (several native programs share these
// small codes), never asserted as certain without the logs.
const SPL_TOKEN_ERRORS: Record<number, { name: string; msg: string }> = {
  0: { name: "NotRentExempt", msg: "Lamport balance below rent-exempt threshold" },
  1: { name: "InsufficientFunds", msg: "the source token account holds less than the transfer amount" },
  2: { name: "InvalidMint", msg: "Invalid Mint" },
  3: { name: "MintMismatch", msg: "Account not associated with this Mint" },
  4: { name: "OwnerMismatch", msg: "Owner does not match" },
  6: { name: "AlreadyInUse", msg: "Already in use" },
  9: { name: "UninitializedState", msg: "State is uninitialized" },
  12: { name: "InvalidInstruction", msg: "Invalid instruction" },
  14: { name: "Overflow", msg: "Operation overflowed" },
  17: { name: "AccountFrozen", msg: "Account is frozen" },
};

function decodeSplTokenError(code: number): { name: string; msg: string } | null {
  return SPL_TOKEN_ERRORS[code] ?? null;
}
