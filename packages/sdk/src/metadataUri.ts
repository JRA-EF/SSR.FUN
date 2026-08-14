// Single source of truth for the on-chain `Reserve.metadata_uri` byte
// budget, mirrored by hand from programs/ssr_protocol/src/constants.rs's
// `MAX_METADATA_URI_LEN` (currently 200) -- create_reserve.rs and
// update_metadata.rs both reject anything longer with `SsrError::
// MetadataUriTooLong`. `Reserve::SPACE` (programs/ssr_protocol/src/state/
// reserve.rs) already reserves `4 + MAX_METADATA_URI_LEN` bytes for this
// field regardless of the actual string length submitted -- account size is
// fixed at the maximum either way, so a URI that fits under this limit
// never has any account-size implication beyond what's already allocated.
//
// CRITICAL: the Rust check is `metadata_uri.len() <= MAX_METADATA_URI_LEN`,
// and Rust's `String::len()` counts UTF-8 BYTES, not characters --
// JavaScript's `string.length` counts UTF-16 code units instead, which
// silently under-counts any non-ASCII character (e.g. an emoji or accented
// letter in a Reserve name/description can be 2-4 UTF-8 bytes but only 1-2
// JS `.length` units). Every length check in this file uses
// `metadataUriByteLength` (TextEncoder-based, genuine UTF-8 byte count) for
// exactly this reason -- never plain `.length`.
//
// 200 bytes is genuinely sufficient for a real permanent metadata URL of
// any of the 3 schemes this app's Create Reserve flow needs to support (see
// docs/project/DECISION_LOG.md's entry for this fix for the worked
// examples): this app's own HTTPS-hosted endpoint
// (`https://strategic-super-reserve.fun/api/devnet/reserve-metadata?id=`
// + a 16-hex-char id is ~84 bytes), a gateway-fronted IPFS URL (a CIDv1 is
// ~59 chars; with a gateway prefix, comfortably under 100 bytes), or an
// Arweave URL (`https://arweave.net/` + a 43-char base64 transaction id is
// ~62 bytes). The bug this file exists to prevent recurring was never that
// 200 bytes is too small -- it was the frontend submitting an entire inline
// `data:application/json,...` JSON payload (routinely 300-600+ bytes for
// any real name/description) instead of a short link to that payload
// stored elsewhere. Do not raise MAX_METADATA_URI_LEN to work around a
// caller that isn't uploading first and linking second.
export const MAX_METADATA_URI_LEN = 200;

/** The genuine UTF-8 byte length of `uri` -- what the on-chain program actually measures, never JS's UTF-16-code-unit `.length`. */
export function metadataUriByteLength(uri: string): number {
  return new TextEncoder().encode(uri).length;
}

/** True iff `uri` would be accepted by create_reserve.rs/update_metadata.rs's own length check. */
export function isMetadataUriWithinLimit(uri: string): boolean {
  return metadataUriByteLength(uri) <= MAX_METADATA_URI_LEN;
}

const PERMITTED_SCHEME_RE = /^(https:\/\/|ipfs:\/\/|ar:\/\/)/i;

/**
 * Throws a plain-language, user-showable error for anything this app's
 * Create Reserve / metadata-update flow must never submit on-chain: a
 * `data:` URI (the exact bug this validates against -- embedding the JSON
 * payload directly instead of uploading it and linking to it), a `blob:`
 * URL (a temporary, browser-session-only reference that resolves to
 * nothing for anyone else, including the program itself, and stops
 * resolving the moment the tab closes), any other non-permanent-looking
 * scheme, or a URI that's genuinely too long regardless of scheme. Callers
 * MUST run this before ever requesting a wallet signature for
 * create_reserve/update_metadata -- never after, and never rely on the
 * on-chain rejection alone to catch it (that still costs the user a
 * declined wallet popup and a wasted round trip at best).
 */
export function validateMetadataUri(uri: string): void {
  if (!uri || !uri.trim()) {
    throw new Error("Metadata URL is missing.");
  }
  if (uri.startsWith("data:")) {
    throw new Error(
      "Metadata can't be submitted as inline data -- it must be uploaded first, and only its short permanent URL submitted on-chain.",
    );
  }
  if (uri.startsWith("blob:")) {
    throw new Error(
      "Metadata can't be submitted as a temporary browser link -- it must be uploaded first, and only its short permanent URL submitted on-chain.",
    );
  }
  if (!PERMITTED_SCHEME_RE.test(uri)) {
    throw new Error("Metadata URL must be a real HTTPS URL, an ipfs:// URL, or an ar:// (Arweave) URL.");
  }
  const len = metadataUriByteLength(uri);
  if (len > MAX_METADATA_URI_LEN) {
    throw new Error(`Metadata URL is ${len} bytes, which exceeds the ${MAX_METADATA_URI_LEN}-byte on-chain limit -- use a shorter permanent URL.`);
  }
}
