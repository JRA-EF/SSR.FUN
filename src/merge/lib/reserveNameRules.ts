/**
 * DEC-0274: a Reserve's name becomes its token's on-chain Metaplex name, which
 * holds 32 UTF-8 bytes; DEXes, Jupiter, explorers and wallets all read that
 * field. A longer name used to be cut silently on chain while the off-chain
 * metadata kept the full text, so the two disagreed. Refuse it instead.
 */
export const RESERVE_NAME_MAX_BYTES = 32;

/** Plain-language reason a Reserve name can't be used on chain, or null when it fits. */
export function reserveNameProblem(name: string): string | null {
  const trimmed = name.trim();
  // A null byte is refused later by the payload's own Postgres check, with its own message.
  // eslint-disable-next-line no-control-regex
  if (/[\u0001-\u001f\u007f]/.test(trimmed)) return "The name can't contain line breaks or control characters.";
  const bytes = new TextEncoder().encode(trimmed.replace(/\s+/g, " ")).length;
  if (bytes > RESERVE_NAME_MAX_BYTES) return `The name is too long for the on-chain token name (${bytes} of ${RESERVE_NAME_MAX_BYTES} bytes; emoji and accented letters use more than one). Shorten it.`;
  return null;
}
