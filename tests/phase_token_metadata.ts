// Offline coverage for Reserve Token Metaplex metadata (the program's
// set_reserve_token_metadata instruction and its client/API halves -- see
// docs/project/DECISION_LOG.md's entry for the pass that added it):
// (1) the SDK's IDL carries the new instruction with the discriminator Anchor
// derives from its name, in both the raw JSON and the camelCase TS mirror;
// (2) the standard-format JSON record served at /api/<cluster>/token-metadata
// is derived correctly from a stored Reserve payload; (3) the SDK helpers
// that derive the on-chain name/symbol/uri from what the Manager entered and
// decode a Metaplex Metadata account.
//
// Run in isolation:
//   npx ts-mocha -p ./tests/tsconfig.json -t 30000 tests/phase_token_metadata.ts
import { expect } from "chai";
import { createHash } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import idlJson from "../packages/sdk/idl/ssr_protocol.json";
import { buildTokenMetadataJson, rewriteAppImageUrl } from "../lib/reserve-metadata/tokenMetadata";
import type { ReserveMetadataPayload } from "../lib/reserve-metadata/payload";
import {
  TOKEN_METADATA_PROGRAM_ID,
  MAX_TOKEN_METADATA_NAME_LEN,
  MAX_TOKEN_METADATA_SYMBOL_LEN,
  MAX_TOKEN_METADATA_URI_LEN,
  findTokenMetadata,
  fitTokenMetadataName,
  fitTokenMetadataSymbol,
  validateTokenMetadataFields,
  tokenMetadataUriFromReserveMetadataUri,
  decodeTokenMetadataAccount,
  utf8ByteLength,
} from "../packages/sdk/src/tokenMetadata";

const RESERVE = "H7NDKmf9pKow6v7eQfBchxRtPb8thP1STsRARGPWwo73";
const MINT = "BpdHpqznEgYPXZNrJVRZvBhdWoafYLVVuLxTQo34pump";

function anchorDiscriminator(preimage: string): number[] {
  return [...createHash("sha256").update(preimage).digest().subarray(0, 8)];
}

describe("IDL -- set_reserve_token_metadata is present and consistent", () => {
  const idl = idlJson as unknown as {
    instructions: { name: string; discriminator: number[]; accounts: { name: string }[]; args: { name: string; type: string }[] }[];
    events: { name: string; discriminator: number[] }[];
    types: { name: string }[];
    errors: { code: number; name: string }[];
  };

  it("carries the instruction with Anchor's sha256('global:<name>') discriminator", () => {
    const ix = idl.instructions.find((i) => i.name === "set_reserve_token_metadata");
    expect(ix, "instruction missing from packages/sdk/idl/ssr_protocol.json").to.not.equal(undefined);
    expect(ix!.discriminator).to.deep.equal(anchorDiscriminator("global:set_reserve_token_metadata"));
    expect(ix!.accounts.map((a) => a.name)).to.deep.equal([
      "protocol_config",
      "reserve",
      "reserve_token_mint",
      "mint_authority",
      "metadata",
      "delegate",
      "signer",
      "token_metadata_program",
      "system_program",
      "rent",
    ]);
    expect(ix!.args.map((a) => `${a.name}:${a.type}`)).to.deep.equal(["name:string", "symbol:string", "uri:string"]);
  });

  it("carries the ReserveTokenMetadataSet event with its sha256('event:<name>') discriminator, and its type", () => {
    const ev = idl.events.find((e) => e.name === "ReserveTokenMetadataSet");
    expect(ev).to.not.equal(undefined);
    expect(ev!.discriminator).to.deep.equal(anchorDiscriminator("event:ReserveTokenMetadataSet"));
    expect(idl.types.some((t) => t.name === "ReserveTokenMetadataSet")).to.equal(true);
  });

  it("appends the four TokenMetadata* errors after the last pre-existing code (append-only error enum)", () => {
    const names = ["TokenMetadataNameInvalid", "TokenMetadataSymbolInvalid", "TokenMetadataUriInvalid", "TokenMetadataAddressMismatch"];
    const codes = names.map((n) => idl.errors.find((e) => e.name === n)?.code);
    expect(codes).to.deep.equal([6062, 6063, 6064, 6065]);
  });

  it("the camelCase TS mirror carries the same instruction (typed program.methods.setReserveTokenMetadata resolves)", () => {
    // The TS file is a type-only module; check its text rather than importing a type at runtime.
    const fs = require("node:fs") as typeof import("node:fs");
    const ts = fs.readFileSync(require.resolve("../packages/sdk/idl/ssr_protocol.ts"), "utf8");
    expect(ts).to.include('"name": "setReserveTokenMetadata"');
    expect(ts).to.include('"name": "tokenMetadataProgram"');
    expect(ts).to.include('"name": "reserveTokenMetadataSet"');
    expect(ts).to.include('"name": "tokenMetadataAddressMismatch"');
  });
});

describe("lib/reserve-metadata/tokenMetadata.ts -- buildTokenMetadataJson (the record wallets and DEXes read)", () => {
  const payload: ReserveMetadataPayload = {
    name: "Strategic Solana Reserve",
    ticker: "SSRSol",
    description: "A basket of Solana ecosystem assets.",
    category: "Ecosystem",
    buyTaxPct: 1,
    sellTaxPct: 0,
    imageUrl: "https://ssr.fun/api/mainnet/reserve-image?id=0123456789abcdef",
  };

  it("maps ticker -> symbol and imageUrl -> image, and carries description, category and the Reserve page", () => {
    const out = buildTokenMetadataJson(payload, { externalUrl: `https://ssr.fun/#/dtr/${RESERVE}` });
    expect(out.name).to.equal("Strategic Solana Reserve");
    expect(out.symbol).to.equal("SSRSol");
    expect(out.description).to.equal(payload.description);
    expect(out.image).to.equal(payload.imageUrl);
    expect(out.external_url).to.equal(`https://ssr.fun/#/dtr/${RESERVE}`);
    expect(out.attributes).to.deep.include({ trait_type: "Category", value: "Ecosystem" });
    expect(out.attributes).to.deep.include({ trait_type: "Type", value: "SSR.fun Reserve Token" });
    // No SSR-internal field names leak into the standard record.
    expect(out).to.not.have.property("ticker");
    expect(out).to.not.have.property("imageUrl");
    expect(out).to.not.have.property("buyTaxPct");
  });

  it("prefers the Reserve's CURRENT picture pointer over the payload's imageUrl (a Manager can change the picture without republishing)", () => {
    const out = buildTokenMetadataJson(payload, { currentImageUrl: "https://ssr.fun/api/mainnet/reserve-image?id=fedcba9876543210" });
    expect(out.image).to.equal("https://ssr.fun/api/mainnet/reserve-image?id=fedcba9876543210");
  });

  it("rewrites a picture link on one of this app's other hosts onto the serving origin (a Reserve launched on the old, now-gated domain), and leaves foreign hosts alone", () => {
    const old = { ...payload, imageUrl: "https://strategic-super-reserve.fun/api/mainnet/reserve-image?id=978fa4e7b28cc378" };
    expect(buildTokenMetadataJson(old, { rewriteOrigin: "https://ssr.fun" }).image).to.equal("https://ssr.fun/api/mainnet/reserve-image?id=978fa4e7b28cc378");
    expect(buildTokenMetadataJson(old).image).to.equal(old.imageUrl);
    expect(rewriteAppImageUrl("https://cdn.example.com/pic.png", "https://ssr.fun")).to.equal("https://cdn.example.com/pic.png");
    expect(rewriteAppImageUrl("not a url", "https://ssr.fun")).to.equal("not a url");
  });

  it("omits image entirely (never an empty string) when the Reserve has no picture, and omits the Category attribute when blank", () => {
    const out = buildTokenMetadataJson({ ...payload, imageUrl: undefined, category: "" });
    expect(out).to.not.have.property("image");
    expect(out.attributes.some((a) => a.trait_type === "Category")).to.equal(false);
  });
});

describe("packages/sdk/src/tokenMetadata.ts -- helpers", () => {
  it("findTokenMetadata derives the Metaplex PDA under the Token Metadata program", () => {
    const [pda, bump] = findTokenMetadata(new PublicKey(MINT));
    const [expected, expectedBump] = PublicKey.findProgramAddressSync(
      [Buffer.from("metadata"), TOKEN_METADATA_PROGRAM_ID.toBuffer(), new PublicKey(MINT).toBuffer()],
      TOKEN_METADATA_PROGRAM_ID,
    );
    expect(pda.equals(expected)).to.equal(true);
    expect(bump).to.equal(expectedBump);
    expect(TOKEN_METADATA_PROGRAM_ID.toBase58()).to.equal("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");
  });

  it("limits mirror programs/ssr_protocol/src/instructions/set_reserve_token_metadata.rs (32 / 10 / 200 bytes)", () => {
    expect(MAX_TOKEN_METADATA_NAME_LEN).to.equal(32);
    expect(MAX_TOKEN_METADATA_SYMBOL_LEN).to.equal(10);
    expect(MAX_TOKEN_METADATA_URI_LEN).to.equal(200);
  });

  it("fitTokenMetadataName keeps a short name as-is and cuts a long one at a character boundary within 32 bytes", () => {
    expect(fitTokenMetadataName("Strategic Solana Reserve")).to.equal("Strategic Solana Reserve");
    expect(fitTokenMetadataName("  Strategic   Solana  Reserve ")).to.equal("Strategic Solana Reserve");
    const long = "Réserve Stratégique Solana Très Longue Édition";
    const fit = fitTokenMetadataName(long);
    expect(utf8ByteLength(fit)).to.be.at.most(32);
    expect(long.startsWith(fit)).to.equal(true);
    expect(fit.endsWith(" ")).to.equal(false);
  });

  it("fitTokenMetadataSymbol strips whitespace and cuts to 10 bytes", () => {
    expect(fitTokenMetadataSymbol("SSRSol")).to.equal("SSRSol");
    expect(fitTokenMetadataSymbol("SSR Sol")).to.equal("SSRSol");
    expect(fitTokenMetadataSymbol("ABCDEFGHIJKLMNOP")).to.equal("ABCDEFGHIJ");
  });

  it("validateTokenMetadataFields rejects empties, over-long values and non-HTTPS links with plain-language errors", () => {
    const ok = { name: "Strategic Solana Reserve", symbol: "SSRSol", uri: "https://ssr.fun/api/mainnet/token-metadata?id=0123456789abcdef" };
    expect(() => validateTokenMetadataFields(ok)).to.not.throw();
    expect(() => validateTokenMetadataFields({ ...ok, name: " " })).to.throw(/name is empty/);
    expect(() => validateTokenMetadataFields({ ...ok, name: "x".repeat(33) })).to.throw(/32 bytes/);
    expect(() => validateTokenMetadataFields({ ...ok, symbol: "x".repeat(11) })).to.throw(/10 bytes/);
    expect(() => validateTokenMetadataFields({ ...ok, uri: "http://ssr.fun/x" })).to.throw(/HTTPS/);
    expect(() => validateTokenMetadataFields({ ...ok, uri: "https://ssr.fun/" + "a".repeat(200) })).to.throw(/200 bytes/);
  });

  it("tokenMetadataUriFromReserveMetadataUri maps the Reserve's own record URL to the sibling token-metadata endpoint, same id, same host, plus the reserve", () => {
    const uri = tokenMetadataUriFromReserveMetadataUri(`https://ssr.fun/api/mainnet/reserve-metadata?id=0123456789abcdef`, RESERVE);
    expect(uri).to.equal(`https://ssr.fun/api/mainnet/token-metadata?id=0123456789abcdef&reserve=${RESERVE}`);
    expect(utf8ByteLength(uri!)).to.be.at.most(MAX_TOKEN_METADATA_URI_LEN);
    const dev = tokenMetadataUriFromReserveMetadataUri(`https://strategic-super-reserve.fun/api/devnet/reserve-metadata?id=fedcba9876543210`, new PublicKey(RESERVE));
    expect(dev).to.equal(`https://strategic-super-reserve.fun/api/devnet/token-metadata?id=fedcba9876543210&reserve=${RESERVE}`);
  });

  it("tokenMetadataUriFromReserveMetadataUri returns null for the legacy inline data: convention and for anything unrecognised (never fabricates a link)", () => {
    expect(tokenMetadataUriFromReserveMetadataUri("data:application/json,%7B%22name%22%3A%22x%22%7D", RESERVE)).to.equal(null);
    expect(tokenMetadataUriFromReserveMetadataUri("https://ssr.fun/api/mainnet/reserve-metadata", RESERVE)).to.equal(null);
    expect(tokenMetadataUriFromReserveMetadataUri("https://ssr.fun/api/mainnet/reserve-metadata?id=nothex", RESERVE)).to.equal(null);
    expect(tokenMetadataUriFromReserveMetadataUri("not a url", RESERVE)).to.equal(null);
  });

  it("decodeTokenMetadataAccount reads name/symbol/uri (null-padded Borsh strings), update authority, mint and is_mutable", () => {
    // Build a Metaplex Metadata account image the way the program lays it out.
    const pad = (s: string, max: number) => {
      const b = Buffer.alloc(4 + max);
      b.writeUInt32LE(max, 0);
      Buffer.from(s, "utf8").copy(b, 4);
      return b;
    };
    const updateAuthority = new PublicKey(RESERVE);
    const mint = new PublicKey(MINT);
    const data = Buffer.concat([
      Buffer.from([4]), // Key::MetadataV1
      updateAuthority.toBuffer(),
      mint.toBuffer(),
      pad("Strategic Solana Reserve", 32),
      pad("SSRSol", 10),
      pad("https://ssr.fun/api/mainnet/token-metadata?id=0123456789abcdef", 200),
      Buffer.from([0, 0]), // seller_fee_basis_points
      Buffer.from([0]), // creators: None
      Buffer.from([0]), // primary_sale_happened
      Buffer.from([1]), // is_mutable
      Buffer.from([0, 0, 0, 0]), // trailing fields, ignored
    ]);
    const [address] = findTokenMetadata(mint);
    const decoded = decodeTokenMetadataAccount(address, data);
    expect(decoded).to.deep.equal({
      address: address.toBase58(),
      mint: MINT,
      updateAuthority: RESERVE,
      name: "Strategic Solana Reserve",
      symbol: "SSRSol",
      uri: "https://ssr.fun/api/mainnet/token-metadata?id=0123456789abcdef",
      isMutable: true,
    });
    expect(() => decodeTokenMetadataAccount(address, Buffer.from([1, 2, 3]))).to.throw(/Not a Metaplex Metadata account/);
  });
});
