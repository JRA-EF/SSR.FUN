// Regression coverage for the Create Reserve "SsrError::MetadataUriTooLong
// (6000): Metadata URI exceeds the permitted length" failure (see
// docs/project/DECISION_LOG.md's entry for this fix). Confirmed root cause:
// CreateDTR.tsx used to submit the ENTIRE name/ticker/description/category/
// buyTaxPct/sellTaxPct payload inline as a `data:application/json,...` URI
// directly on-chain as Reserve.metadata_uri, instead of uploading it
// somewhere permanent and submitting only a short link -- routinely
// 300-600+ bytes for any real name/description, against the on-chain
// program's 200-byte MAX_METADATA_URI_LEN (programs/ssr_protocol/src/
// constants.rs). This file covers, entirely offline: (1) the shared
// byte-limit/scheme validation both the frontend and (as defense in depth)
// createReserveOnChain now enforce before ever requesting a wallet
// signature, (2) the off-chain metadata-store's pure validation/hashing
// logic, and (3) a direct before/after reproduction proving the exact old
// construction overflows the limit while the new URL-based construction
// does not.
//
// Run in isolation:
//   npx ts-mocha -p ./tests/tsconfig.json -t 30000 tests/phase_metadata_uri.ts
import { expect } from "chai";
import { MAX_METADATA_URI_LEN, metadataUriByteLength, isMetadataUriWithinLimit, validateMetadataUri } from "../packages/sdk/src/metadataUri";
import { validateReserveMetadataPayload, computeMetadataId, MAX_PAYLOAD_JSON_BYTES, type ReserveMetadataPayload } from "../lib/reserve-metadata/payload";

describe("metadataUri.ts -- MAX_METADATA_URI_LEN mirrors programs/ssr_protocol/src/constants.rs", () => {
  it("is 200, matching the on-chain MAX_METADATA_URI_LEN exactly -- update both by hand together if this ever changes", () => {
    expect(MAX_METADATA_URI_LEN).to.equal(200);
  });
});

describe("metadataUriByteLength -- genuine UTF-8 byte length, never JS's UTF-16 .length", () => {
  it("matches plain .length for pure ASCII", () => {
    const s = "https://strategic-super-reserve.fun/api/devnet/reserve-metadata?id=0123456789abcdef";
    expect(metadataUriByteLength(s)).to.equal(s.length);
  });

  it("counts more bytes than .length for a multi-byte character -- an emoji or accented letter in a name must not silently under-count against the on-chain byte limit", () => {
    const s = "😀"; // 1 JS UTF-16 code unit pair (.length === 2), 4 UTF-8 bytes
    expect(s.length).to.equal(2);
    expect(metadataUriByteLength(s)).to.equal(4);
  });

  it("counts an accented character correctly (2 UTF-8 bytes, 1 JS .length unit)", () => {
    const s = "é";
    expect(s.length).to.equal(1);
    expect(metadataUriByteLength(s)).to.equal(2);
  });
});

describe("isMetadataUriWithinLimit / validateMetadataUri", () => {
  const validHttps = "https://strategic-super-reserve.fun/api/devnet/reserve-metadata?id=0123456789abcdef";

  it("accepts a real, short HTTPS URL under the limit", () => {
    expect(isMetadataUriWithinLimit(validHttps)).to.equal(true);
    expect(() => validateMetadataUri(validHttps)).to.not.throw();
  });

  it("accepts a real ipfs:// URL", () => {
    const ipfs = "ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi";
    expect(() => validateMetadataUri(ipfs)).to.not.throw();
  });

  it("accepts a real ar:// (Arweave) URL", () => {
    const ar = "ar://" + "a".repeat(43);
    expect(() => validateMetadataUri(ar)).to.not.throw();
  });

  it("accepts a gateway-fronted HTTPS Arweave/IPFS URL (still https://, so still permitted)", () => {
    expect(() => validateMetadataUri("https://arweave.net/" + "a".repeat(43))).to.not.throw();
    expect(() => validateMetadataUri("https://ipfs.io/ipfs/bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi")).to.not.throw();
  });

  it("ROOT-CAUSE REGRESSION: rejects a data: URI outright -- the exact bug (inline JSON instead of a permanent link)", () => {
    const dataUri = `data:application/json,${encodeURIComponent(JSON.stringify({ name: "x", ticker: "X" }))}`;
    expect(() => validateMetadataUri(dataUri)).to.throw(/inline data/);
  });

  it("rejects a blob: URL -- a temporary, browser-session-only reference that resolves to nothing for anyone else", () => {
    expect(() => validateMetadataUri("blob:https://strategic-super-reserve.fun/3fa85f64-5717-4562-b3fc-2c963f66afa6")).to.throw(/temporary browser link/);
  });

  it("rejects an unsupported scheme (e.g. plain http://, or a garbage string)", () => {
    expect(() => validateMetadataUri("http://insecure.example.com/meta.json")).to.throw(/HTTPS/);
    expect(() => validateMetadataUri("not-a-url-at-all")).to.throw(/HTTPS/);
  });

  it("rejects an empty/missing URI", () => {
    expect(() => validateMetadataUri("")).to.throw(/missing/);
  });

  it("accepts a URI at exactly the 200-byte boundary", () => {
    const prefix = "https://a.io/";
    const uri = prefix + "x".repeat(MAX_METADATA_URI_LEN - prefix.length);
    expect(metadataUriByteLength(uri)).to.equal(MAX_METADATA_URI_LEN);
    expect(() => validateMetadataUri(uri)).to.not.throw();
  });

  it("rejects a URI one byte over the boundary, with the real byte count in the message", () => {
    const prefix = "https://a.io/";
    const uri = prefix + "x".repeat(MAX_METADATA_URI_LEN - prefix.length + 1);
    expect(metadataUriByteLength(uri)).to.equal(MAX_METADATA_URI_LEN + 1);
    expect(() => validateMetadataUri(uri)).to.throw(new RegExp(`${MAX_METADATA_URI_LEN + 1} bytes`));
  });
});

describe("ROOT-CAUSE REGRESSION -- the exact old vs. new metadataUri construction", () => {
  // A realistic real-world Create Reserve submission -- not a contrived
  // edge case. Any genuine name + one-sentence description was enough to
  // trigger the reported failure.
  const realistic = {
    name: "Strategic Solana Reserve",
    ticker: "SSR1",
    description: "A diversified basket of Solana ecosystem assets, rebalanced periodically to track long-term protocol growth.",
    category: "DeFi",
    buyTaxPct: 0,
    sellTaxPct: 0,
  };

  it("the OLD construction (data:application/json inline payload) genuinely exceeds the on-chain limit for this realistic input -- proves this was a real, not hypothetical, failure", () => {
    const oldMetadataUri = `data:application/json,${encodeURIComponent(JSON.stringify(realistic))}`;
    expect(metadataUriByteLength(oldMetadataUri)).to.be.greaterThan(MAX_METADATA_URI_LEN);
    expect(() => validateMetadataUri(oldMetadataUri)).to.throw();
  });

  it("the NEW construction (this app's own permanent-URL endpoint, referencing the same content by its deterministic id) is comfortably within the limit for the SAME realistic input", () => {
    const payload = validateReserveMetadataPayload(realistic);
    const id = computeMetadataId(payload);
    const newMetadataUri = `https://strategic-super-reserve.fun/api/devnet/reserve-metadata?id=${id}`;
    expect(metadataUriByteLength(newMetadataUri)).to.be.lessThan(MAX_METADATA_URI_LEN);
    expect(() => validateMetadataUri(newMetadataUri)).to.not.throw();
  });

  it("even a long, real-world-plausible name/description/category still fits comfortably under the limit with the new construction (the id is a fixed 16-hex-char length regardless of content size)", () => {
    const long = {
      name: "The Long-Term Diversified Multi-Asset Strategic Solana Ecosystem Reserve Fund",
      ticker: "LONGFUND",
      description:
        "This Reserve holds a carefully curated, actively managed basket of leading Solana ecosystem tokens, rebalanced on a regular schedule to track sector growth while managing concentration risk across the underlying assets.",
      category: "DeFi",
      buyTaxPct: 1.5,
      sellTaxPct: 1.5,
    };
    const payload = validateReserveMetadataPayload(long);
    const id = computeMetadataId(payload);
    const uri = `https://strategic-super-reserve.fun/api/devnet/reserve-metadata?id=${id}`;
    expect(metadataUriByteLength(uri)).to.be.lessThan(MAX_METADATA_URI_LEN);
  });
});

describe("lib/reserve-metadata/payload.ts -- validateReserveMetadataPayload", () => {
  it("normalizes a full, valid payload", () => {
    const p = validateReserveMetadataPayload({ name: " My Reserve ", ticker: " MYR ", description: "desc", category: "DeFi", buyTaxPct: 1.5, sellTaxPct: 2 });
    expect(p).to.deep.equal({ name: "My Reserve", ticker: "MYR", description: "desc", category: "DeFi", buyTaxPct: 1.5, sellTaxPct: 2 });
  });

  it("rejects a missing/blank name", () => {
    expect(() => validateReserveMetadataPayload({ ticker: "X" })).to.throw(/name/);
    expect(() => validateReserveMetadataPayload({ name: "   ", ticker: "X" })).to.throw(/name/);
  });

  it("rejects a missing/blank ticker", () => {
    expect(() => validateReserveMetadataPayload({ name: "X" })).to.throw(/ticker/);
  });

  it("rejects a non-object body", () => {
    expect(() => validateReserveMetadataPayload(null)).to.throw(/JSON object/);
    expect(() => validateReserveMetadataPayload("a string")).to.throw(/JSON object/);
  });

  it("defaults description/category/buyTaxPct/sellTaxPct honestly (never fabricated) when absent", () => {
    const p = validateReserveMetadataPayload({ name: "X", ticker: "X" });
    expect(p.description).to.equal("");
    expect(p.category).to.equal("");
    expect(p.buyTaxPct).to.equal(0);
    expect(p.sellTaxPct).to.equal(0);
  });

  it("ignores a non-finite buyTaxPct/sellTaxPct rather than storing garbage", () => {
    const p = validateReserveMetadataPayload({ name: "X", ticker: "X", buyTaxPct: Infinity, sellTaxPct: NaN });
    expect(p.buyTaxPct).to.equal(0);
    expect(p.sellTaxPct).to.equal(0);
  });

  it("rejects a payload whose JSON exceeds MAX_PAYLOAD_JSON_BYTES -- bounds the public POST endpoint against abuse", () => {
    const huge = { name: "X", ticker: "X", description: "y".repeat(MAX_PAYLOAD_JSON_BYTES + 1), category: "", buyTaxPct: 0, sellTaxPct: 0 };
    expect(() => validateReserveMetadataPayload(huge)).to.throw(/exceeding/);
  });
});

describe("lib/reserve-metadata/payload.ts -- computeMetadataId (content-addressed, retry-safe)", () => {
  const payload: ReserveMetadataPayload = { name: "A", ticker: "A", description: "d", category: "c", buyTaxPct: 0, sellTaxPct: 0 };

  it("is deterministic -- identical content always produces the same id, so a retried upload reuses the same row/URL instead of creating a duplicate", () => {
    expect(computeMetadataId(payload)).to.equal(computeMetadataId({ ...payload }));
  });

  it("produces a different id for different content", () => {
    expect(computeMetadataId(payload)).to.not.equal(computeMetadataId({ ...payload, name: "B" }));
  });

  it("is exactly 16 lowercase hex characters -- fixed-length regardless of input size, which is what keeps the resulting URL short even for a long description", () => {
    const id = computeMetadataId(payload);
    expect(id).to.match(/^[0-9a-f]{16}$/);
  });
});
