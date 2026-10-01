// Who ISSUED a tokenised real-world asset, proven on-chain.
//
// Tokenised equities are not ordinary SPL tokens: a regulated issuer has to
// be able to act on the underlying (corporate actions, forced transfers,
// redemption), which on Solana means a Token-2022 PermanentDelegate. That
// delegate is the issuer's own key, it is set at mint creation, and it
// cannot be changed afterwards -- which makes it the one identifier a
// squatter cannot imitate.
//
// DETECTION IS THE DELEGATE, NOTHING ELSE. Mint-address prefixes ("Xs..."),
// symbol suffixes ("TSLAx"), names and metadata URIs are all free to copy and
// are NEVER consulted. Verified against the live catalogue on 2026-09-23:
// of 1,732 Token-2022 mints, exactly 835 carry xStocks' delegate and all 835
// are xStocks -- no false positives, no misses.
//
// Two other equity issuers were identified in the same sweep but are NOT
// listed below, because the program does not accept their delegates and so
// their mints never reach the picker. Recorded here as evidence for whoever
// revisits that decision:
//   2cVYpagTt7ZGc3mmTXBa7fAznUtx5DUu6aCq8uVDaf4a  45 mints (SPCX, MU, MSTR, NBIS)
//   WV9PJN7XTmTLVwbutCLFxp8TyePee6Xq5mRq6Fti5Wc    9 mints (PreStocks pre-IPO)
//
// Issuer identity is INFORMATIONAL. It never makes a token eligible as a
// Reserve asset and never bypasses any check -- eligibility is decided by
// validate_asset_mint_extensions (programs/ssr_protocol/src/instructions/
// common.rs) and mirrored in mintExtensions.ts. It is a label and a filter.

/** The issuers this app can name. */
export type TokenIssuerId = "xstocks";

export const SUPPORTED_ISSUERS: readonly TokenIssuerId[] = ["xstocks"];

export interface TokenIssuerInfo {
  /** Display name, as the issuer writes it. */
  name: string;
  site: string;
  /** What the issuer's tokens represent, in one phrase, for the picker's tooltip. */
  blurb: string;
  /**
   * The issuer's Token-2022 PermanentDelegate -- the proof. One key per
   * issuer, shared across every mint they have created, so new listings are
   * recognised the moment they appear without any list to maintain.
   */
  permanentDelegate: string;
}

export const ISSUER_LABELS: Record<TokenIssuerId, TokenIssuerInfo> = {
  xstocks: {
    name: "xStocks",
    site: "xstocks.com",
    blurb: "Tokenised US equities and ETFs, 1:1 backed, issued by Backed Finance",
    permanentDelegate: "5aMNNLQJwAEeoemTEMkv5NVjqKwvvefRYCQ5Z67HFvEq",
  },
};

export function isTokenIssuerId(v: unknown): v is TokenIssuerId {
  return v === "xstocks";
}

/**
 * The issuer a permanent delegate proves, or null for a key we cannot name.
 *
 * Pure and total: unknown, empty and malformed values all return null, never
 * a guess. A mint with no permanent delegate is simply not issuer-attributed.
 */
export function issuerOfPermanentDelegate(delegate: string | null | undefined): TokenIssuerId | null {
  if (!delegate) return null;
  for (const id of SUPPORTED_ISSUERS) {
    if (ISSUER_LABELS[id].permanentDelegate === delegate) return id;
  }
  return null;
}

/**
 * The delegates the protocol accepts, derived from the issuer table so
 * "a key we can name" and "a key we accept" cannot drift apart.
 *
 * MUST equal APPROVED_PERMANENT_DELEGATES in the program's common.rs --
 * tests/phase_mint_extensions.ts reads the Rust source and asserts it.
 */
export const APPROVED_ISSUER_DELEGATES: string[] = SUPPORTED_ISSUERS.map((id) => ISSUER_LABELS[id].permanentDelegate);
