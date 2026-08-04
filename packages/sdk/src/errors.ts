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
  const code = extractCustomErrorCode(err);
  if (code === null) return raw;
  const decoded = decodeSsrProtocolError(code);
  if (decoded) return `${raw} -- SsrError::${decoded.name} (${decoded.code}): ${decoded.msg}`;
  return `${raw} -- program error code ${code} is not defined anywhere in the deployed SSR Protocol IDL (its custom-error range is ${ssrProtocolErrorCodeRange()}). This is not a genuine ssr_protocol error -- check whether another program in the same transaction produced it, or whether the deployed program binary has drifted from this IDL.`;
}
