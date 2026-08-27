// Offline coverage for the Reserve profile-picture feature: (1) the
// Reserve Image Store's pure validation/hashing logic
// (lib/reserve-image/payload.ts -- what api/devnet/reserve-image.ts and
// api/mainnet/reserve-image.ts enforce on every write), and (2) the SDK's
// metadata parsing of the payload's `imageUrl` field
// (packages/sdk/src/discovery.ts's metadataFromJson, exercised through
// parseReserveMetadataUri so no network is involved). The on-chain
// update_metadata instruction this feature rides on already has its own
// validator-backed coverage in tests/ssr_protocol.ts.
//
// Run in isolation:
//   npx ts-mocha -p ./tests/tsconfig.json -t 30000 tests/phase_reserve_profile_image.ts
import { expect } from "chai";
import { validateReserveImageDataUrl, computeImageId, MAX_IMAGE_BYTES, ALLOWED_IMAGE_CONTENT_TYPES } from "../lib/reserve-image/payload";
import { parseReserveMetadataUri } from "../packages/sdk/src/discovery";

/** A tiny but genuine 1x1 transparent PNG. */
const TINY_PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const TINY_PNG_DATA_URL = `data:image/png;base64,${TINY_PNG_BASE64}`;

describe("lib/reserve-image/payload.ts -- validateReserveImageDataUrl", () => {
  it("accepts a genuine PNG data URL and preserves its content type and bytes", () => {
    const p = validateReserveImageDataUrl(TINY_PNG_DATA_URL);
    expect(p.contentType).to.equal("image/png");
    expect(p.dataBase64).to.equal(TINY_PNG_BASE64);
  });

  it("accepts every allowlisted format", () => {
    for (const contentType of ALLOWED_IMAGE_CONTENT_TYPES) {
      const p = validateReserveImageDataUrl(`data:${contentType};base64,${TINY_PNG_BASE64}`);
      expect(p.contentType).to.equal(contentType);
    }
  });

  it("rejects a non-string / empty value", () => {
    expect(() => validateReserveImageDataUrl(undefined)).to.throw(/missing/);
    expect(() => validateReserveImageDataUrl("")).to.throw(/missing/);
    expect(() => validateReserveImageDataUrl(42)).to.throw(/missing/);
  });

  it("rejects a non-image or non-allowlisted content type -- an SVG (scriptable) or arbitrary type must never be stored and served back", () => {
    expect(() => validateReserveImageDataUrl(`data:image/svg+xml;base64,${TINY_PNG_BASE64}`)).to.throw(/PNG, JPEG, WebP, or GIF/);
    expect(() => validateReserveImageDataUrl(`data:text/html;base64,${TINY_PNG_BASE64}`)).to.throw(/PNG, JPEG, WebP, or GIF/);
    expect(() => validateReserveImageDataUrl("https://example.com/a.png")).to.throw(/PNG, JPEG, WebP, or GIF/);
  });

  it("rejects a data URL without base64 encoding or with characters outside the base64 alphabet", () => {
    expect(() => validateReserveImageDataUrl("data:image/png,notbase64")).to.throw(/PNG, JPEG, WebP, or GIF/);
    expect(() => validateReserveImageDataUrl("data:image/png;base64,????")).to.throw(/PNG, JPEG, WebP, or GIF/);
  });

  it("rejects a base64 body whose length is not a multiple of 4 (corrupted upload)", () => {
    expect(() => validateReserveImageDataUrl("data:image/png;base64,AAAAA")).to.throw(/corrupted/);
  });

  it("rejects an empty image body", () => {
    // "====" alone is not matched by the base64 group (padding only), so a
    // zero-byte body can only be expressed as an empty match -- which the
    // regex already rejects; this documents that outcome.
    expect(() => validateReserveImageDataUrl("data:image/png;base64,")).to.throw(/PNG, JPEG, WebP, or GIF/);
  });

  it("accepts a decoded size just under MAX_IMAGE_BYTES and rejects one just over -- bounds the public POST endpoint against abuse", () => {
    // 3 decoded bytes per 4 unpadded base64 chars -- construct the largest
    // whole-quantum body at-or-under the cap, and the smallest one over it.
    const underCap = "A".repeat(Math.floor(MAX_IMAGE_BYTES / 3) * 4);
    expect(() => validateReserveImageDataUrl(`data:image/png;base64,${underCap}`)).to.not.throw();
    const overCap = "A".repeat(Math.ceil((MAX_IMAGE_BYTES + 1) / 3) * 4);
    expect(() => validateReserveImageDataUrl(`data:image/png;base64,${overCap}`)).to.throw(/exceeding/);
  });
});

describe("lib/reserve-image/payload.ts -- computeImageId (content-addressed, retry-safe)", () => {
  it("is deterministic -- identical bytes always produce the same id, so a retried upload reuses the same row/URL", () => {
    const p = validateReserveImageDataUrl(TINY_PNG_DATA_URL);
    expect(computeImageId(p)).to.equal(computeImageId({ ...p }));
  });

  it("differs for different bytes AND for the same bytes under a different content type", () => {
    const p = validateReserveImageDataUrl(TINY_PNG_DATA_URL);
    expect(computeImageId(p)).to.not.equal(computeImageId({ ...p, dataBase64: TINY_PNG_BASE64.slice(0, -4) + "AAAA" }));
    expect(computeImageId(p)).to.not.equal(computeImageId({ ...p, contentType: "image/webp" }));
  });

  it("is exactly 16 lowercase hex characters -- same short-URL format as computeMetadataId", () => {
    expect(computeImageId(validateReserveImageDataUrl(TINY_PNG_DATA_URL))).to.match(/^[0-9a-f]{16}$/);
  });
});

describe("packages/sdk/src/discovery.ts -- metadata imageUrl parsing (via parseReserveMetadataUri, offline)", () => {
  const inlineUri = (json: unknown) => `data:application/json,${encodeURIComponent(JSON.stringify(json))}`;

  it("surfaces a valid HTTPS imageUrl from the metadata payload", () => {
    const url = "https://strategic-super-reserve.fun/api/devnet/reserve-image?id=0123456789abcdef";
    const parsed = parseReserveMetadataUri(inlineUri({ name: "X", ticker: "X", imageUrl: url }));
    expect(parsed?.imageUrl).to.equal(url);
  });

  it("OMITS imageUrl when the payload has none -- the UI falls back to the ticker-initial avatar, never a fabricated image", () => {
    const parsed = parseReserveMetadataUri(inlineUri({ name: "X", ticker: "X" }));
    expect(parsed).to.not.equal(null);
    expect(parsed && "imageUrl" in parsed).to.equal(false);
  });

  it("ignores a non-HTTPS imageUrl (javascript:, data:, http:, non-string) -- a hostile payload can never smuggle a scriptable scheme into an <img src>", () => {
    for (const bad of ["javascript:alert(1)", "data:text/html,<script>", "http://insecure.example.com/a.png", 42, { url: "x" }]) {
      const parsed = parseReserveMetadataUri(inlineUri({ name: "X", ticker: "X", imageUrl: bad }));
      expect(parsed?.imageUrl, JSON.stringify(bad)).to.equal(undefined);
    }
  });
});
