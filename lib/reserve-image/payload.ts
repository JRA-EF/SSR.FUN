// Pure validation/hashing logic for the Reserve Image Store -- permanent,
// content-addressed storage for a Reserve's profile picture, referenced
// from the Reserve Metadata Store payload's `imageUrl` field (see
// lib/reserve-metadata/payload.ts). Mirrors that module's precedent
// exactly: dependency-free beyond Node's built-in crypto, so it's directly
// testable offline without a database connection.
import { createHash } from "node:crypto";

export interface ReserveImagePayload {
  /** One of ALLOWED_IMAGE_CONTENT_TYPES -- served back verbatim as the GET response's Content-Type. */
  contentType: string;
  /** The raw image bytes, base64-encoded (stored as text -- the Neon HTTP driver speaks JSON, not binary). */
  dataBase64: string;
}

/**
 * Cap on the DECODED image size. The frontend downscales every picked file
 * to a small square before uploading (see src/merge/lib/reserveImageClient.ts),
 * so a real profile picture lands far under this -- the bound exists to
 * protect this public, unauthenticated POST endpoint against a
 * pathological/abusive request, exactly like MAX_PAYLOAD_JSON_BYTES in
 * lib/reserve-metadata/payload.ts.
 */
export const MAX_IMAGE_BYTES = 400_000;

/** The only image formats served back. A fixed allowlist (never the caller's arbitrary string) is what makes it safe to echo the stored content type verbatim as a response header. */
export const ALLOWED_IMAGE_CONTENT_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;

const DATA_URL_RE = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]+={0,2})$/;

/**
 * Validates a `data:image/...;base64,...` string (the browser-side encoding
 * of the picked file) into a ReserveImagePayload, or throws a
 * plain-language error. Never trusts the caller's shape -- this is the one
 * place every write to reserve_image goes through.
 */
export function validateReserveImageDataUrl(dataUrl: unknown): ReserveImagePayload {
  if (typeof dataUrl !== "string" || !dataUrl) {
    throw new Error("The profile picture upload is missing its image data.");
  }
  const match = DATA_URL_RE.exec(dataUrl);
  if (!match) {
    throw new Error("The profile picture must be a PNG, JPEG, WebP, or GIF image.");
  }
  const [, contentType, dataBase64] = match;
  if (dataBase64.length % 4 !== 0) {
    throw new Error("The profile picture upload is corrupted -- try choosing the image again.");
  }
  // Exact decoded size from the base64 length, without materializing the
  // buffer: 3 bytes per 4 chars, minus padding.
  const padding = dataBase64.endsWith("==") ? 2 : dataBase64.endsWith("=") ? 1 : 0;
  const decodedBytes = (dataBase64.length / 4) * 3 - padding;
  if (decodedBytes === 0) {
    throw new Error("The profile picture upload is empty -- try choosing the image again.");
  }
  if (decodedBytes > MAX_IMAGE_BYTES) {
    throw new Error(`The profile picture is ${decodedBytes.toLocaleString()} bytes, exceeding the ${MAX_IMAGE_BYTES.toLocaleString()}-byte limit -- use a smaller image.`);
  }
  return { contentType, dataBase64 };
}

/**
 * Base58 shape of a Solana account address (32-44 chars of the Bitcoin
 * base58 alphabet -- no 0, O, I, or l). Deliberately a shape check, not a
 * full base58 decode: this module stays dependency-free beyond node:crypto
 * (see header), and the pointer table only ever KEYS on the string -- a
 * well-shaped-but-nonexistent address can only ever point a picture at a
 * Reserve nobody will ever render, never corrupt another Reserve's row.
 */
const RESERVE_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/**
 * Validates the `reserve` field of a pointer-setting upload (the Reserve's
 * on-chain account address, used as the reserve_image_pointer primary key)
 * or throws a plain-language error. The one place every pointer write's
 * key goes through, mirroring validateReserveImageDataUrl for the bytes.
 */
export function validateReserveAddress(reserve: unknown): string {
  if (typeof reserve !== "string" || !reserve) {
    throw new Error("The profile picture update is missing its Reserve address.");
  }
  if (!RESERVE_ADDRESS_RE.test(reserve)) {
    throw new Error("The profile picture update's Reserve address is not a valid Solana account address.");
  }
  return reserve;
}

/**
 * Deterministic, content-addressed id for a validated image: identical
 * bytes always produce the same id, so a retried upload reuses the exact
 * same stored row and URL instead of writing a duplicate (the insert is
 * `on conflict (id) do nothing`, same as reserve_metadata). Same 16-hex
 * format and collision reasoning as computeMetadataId -- see
 * lib/reserve-metadata/payload.ts.
 */
export function computeImageId(payload: ReserveImagePayload): string {
  return createHash("sha256").update(`${payload.contentType}:${payload.dataBase64}`).digest("hex").slice(0, 16);
}
