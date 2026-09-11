// Pure validation/hashing logic for the Reserve Metadata Store (see
// schema.sql's header and docs/project/DECISION_LOG.md's entry for the
// MetadataUriTooLong fix this backs). Deliberately dependency-free beyond
// Node's built-in crypto, so it's directly testable offline without a
// database connection -- mirrors lib/reserve-activity/cursorLogic.ts's
// precedent of splitting pure logic out from the DB-touching indexer.ts.
import { createHash } from "node:crypto";

export interface ReserveMetadataPayload {
  name: string;
  ticker: string;
  description: string;
  category: string;
  buyTaxPct: number;
  sellTaxPct: number;
  /**
   * Optional HTTPS URL of the Reserve's profile picture (this app's own
   * content-addressed /api/<cluster>/reserve-image?id=... store, or any
   * other permanent HTTPS image URL). OMITTED -- never stored as "" -- when
   * the Reserve has no picture, so every payload minted before this field
   * existed keeps its exact JSON bytes and therefore its content-addressed
   * id; an absent picture can never silently re-key existing rows.
   */
  imageUrl?: string;
}

/**
 * The wallet/explorer-facing view of a stored payload (DEC-0200).
 *
 * Wallets, explorers and aggregators read the Metaplex off-chain JSON
 * convention -- `name`, `symbol`, `image`, `description` -- while this store's
 * own schema has always used `ticker` and `imageUrl`. Stored rows are
 * content-addressed and IMMUTABLE (their hash is the id the on-chain
 * `metadata_uri` points at), so the standard keys are added at READ time and
 * never written: the bytes on disk keep their hash, and one document now
 * satisfies both the app and any external consumer.
 *
 * Both spellings are emitted. The app keeps reading `ticker`/`imageUrl`, so
 * nothing client-side needs to change.
 */
export interface WalletFacingMetadata extends ReserveMetadataPayload {
  /** Metaplex convention; same value as `ticker`. */
  symbol: string;
  /** Metaplex convention; same value as `imageUrl`, omitted when there is none. */
  image?: string;
}

export function toWalletFacingMetadata(payload: ReserveMetadataPayload): WalletFacingMetadata {
  return {
    ...payload,
    symbol: payload.ticker,
    ...(payload.imageUrl ? { image: payload.imageUrl } : {}),
  };
}

/**
 * Generous cap on the STORED JSON payload itself -- distinct from, and much
 * larger than, packages/sdk/src/metadataUri.ts's 200-byte on-chain URI
 * limit (which bounds the on-chain *link*, never the off-chain content it
 * points at). Exists only to bound this public, unauthenticated POST
 * endpoint against a pathological/abusive request, not as a realistic
 * ceiling for a real Reserve's name/ticker/description/category text.
 */
export const MAX_PAYLOAD_JSON_BYTES = 4_000;

/** Tax percentages are stored and later consumed as literal percentages (0-100) by downstream fee math -- a value outside this range (e.g. -25 or 500) is never economically meaningful, so it's treated the same as a non-finite value below: normalized to 0 rather than persisted as garbage. */
const MAX_TAX_PCT = 100;

/** Generous cap on the stored profile-picture URL. This app's own content-addressed image store produces ~85-byte URLs; the bound exists (like MAX_PAYLOAD_JSON_BYTES) to reject a pathological/abusive value on this public endpoint, not as a realistic ceiling. */
export const MAX_IMAGE_URL_BYTES = 500;

function isValidTaxPct(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= MAX_TAX_PCT;
}

/**
 * Validates and normalizes an arbitrary request body into a
 * ReserveMetadataPayload, or throws a plain-language error. Never trusts
 * the caller's shape -- this is the one place every write to
 * reserve_metadata goes through.
 */
export function validateReserveMetadataPayload(body: unknown): ReserveMetadataPayload {
  if (!body || typeof body !== "object") {
    throw new Error("Metadata payload must be a JSON object.");
  }
  const p = body as Record<string, unknown>;
  const name = typeof p.name === "string" ? p.name.trim() : "";
  const ticker = typeof p.ticker === "string" ? p.ticker.trim() : "";
  if (!name) throw new Error("Metadata payload is missing a name.");
  if (!ticker) throw new Error("Metadata payload is missing a ticker.");

  const payload: ReserveMetadataPayload = {
    name,
    ticker,
    description: typeof p.description === "string" ? p.description : "",
    category: typeof p.category === "string" ? p.category : "",
    buyTaxPct: isValidTaxPct(p.buyTaxPct) ? p.buyTaxPct : 0,
    sellTaxPct: isValidTaxPct(p.sellTaxPct) ? p.sellTaxPct : 0,
  };

  // Assigned AFTER the fixed fields above so it always serializes last --
  // key order is what keeps computeMetadataId deterministic across callers.
  const imageUrl = typeof p.imageUrl === "string" ? p.imageUrl.trim() : "";
  if (imageUrl) {
    if (!/^https:\/\//i.test(imageUrl)) {
      throw new Error("The profile picture link must be a permanent HTTPS URL.");
    }
    if (new TextEncoder().encode(imageUrl).length > MAX_IMAGE_URL_BYTES) {
      throw new Error(`The profile picture link exceeds the ${MAX_IMAGE_URL_BYTES}-byte limit -- use a shorter permanent URL.`);
    }
    payload.imageUrl = imageUrl;
  }

  // Postgres' UTF-8 column type rejects a literal null byte outright (a raw
  // driver-level exception, not a validation error) -- reject it here, at
  // the one place every write goes through, instead of letting that DB
  // exception (and its internal error text) reach the client.
  for (const [field, value] of Object.entries(payload)) {
    if (typeof value === "string" && value.includes("\u0000")) {
      throw new Error(`Metadata field "${field}" contains a null byte, which is not supported.`);
    }
  }

  const jsonBytes = new TextEncoder().encode(JSON.stringify(payload)).length;
  if (jsonBytes > MAX_PAYLOAD_JSON_BYTES) {
    throw new Error(`Metadata is ${jsonBytes} bytes, exceeding the ${MAX_PAYLOAD_JSON_BYTES}-byte stored-payload limit -- shorten the description.`);
  }
  return payload;
}

/**
 * Deterministic, content-addressed id for a validated payload: identical
 * content always produces the same id. This is what makes a retried
 * upload (a network hiccup mid-submit, or resuming a Reserve-creation
 * attempt that failed after uploading but before the on-chain transaction
 * landed) safe -- it reuses the exact same stored row and URL instead of
 * writing a duplicate, and `reserve_metadata`'s `on conflict (id) do
 * nothing` insert makes the write itself idempotent too. 16 hex characters
 * (64 bits of a SHA-256 digest) is negligible collision risk at this app's
 * realistic volume, and keeps the resulting URL comfortably short.
 */
export function computeMetadataId(payload: ReserveMetadataPayload): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex").slice(0, 16);
}
