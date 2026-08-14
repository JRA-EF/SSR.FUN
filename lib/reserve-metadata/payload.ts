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
    buyTaxPct: typeof p.buyTaxPct === "number" && Number.isFinite(p.buyTaxPct) ? p.buyTaxPct : 0,
    sellTaxPct: typeof p.sellTaxPct === "number" && Number.isFinite(p.sellTaxPct) ? p.sellTaxPct : 0,
  };

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
