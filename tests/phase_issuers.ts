// Offline coverage for tokenised-asset issuer provenance
// (packages/sdk/src/issuers.ts, src/merge/lib/issuerLabels.ts,
// api/ledger/asset-catalogue.ts's issuerOfRow).
//
// The point of these tests is that identity comes from the mint's Token-2022
// PermanentDelegate and NOTHING else: not the "Xs" mint prefix, not the "x"
// symbol suffix, not the name. Those are all free to imitate, and a filter a
// squatter can enter is worse than no filter.
//
//   npx ts-mocha -p ./tests/tsconfig.json -t 30000 tests/phase_issuers.ts
import { expect } from "chai";
import { Keypair } from "@solana/web3.js";
import {
  APPROVED_ISSUER_DELEGATES,
  ISSUER_LABELS,
  SUPPORTED_ISSUERS,
  isTokenIssuerId,
  issuerOfPermanentDelegate,
} from "../packages/sdk/src/issuers";
import { APPROVED_PERMANENT_DELEGATES } from "../packages/sdk/src/mintExtensions";
import { ISSUER_FILTER_OPTIONS, issuerBadgeText, issuerBadgeTitle, matchesIssuerFilter } from "../src/merge/lib/issuerLabels";
import { issuerOfRow, dedupeBySymbolPreferOrganicScore, type CatalogueRow } from "../api/ledger/asset-catalogue";

const XSTOCKS_DELEGATE = "5aMNNLQJwAEeoemTEMkv5NVjqKwvvefRYCQ5Z67HFvEq";

describe("issuer identity comes from the permanent delegate", () => {
  it("names the issuer behind the verified xStocks delegate", () => {
    expect(issuerOfPermanentDelegate(XSTOCKS_DELEGATE)).to.equal("xstocks");
    expect(ISSUER_LABELS.xstocks.permanentDelegate).to.equal(XSTOCKS_DELEGATE);
  });

  it("never guesses: an unknown, empty or malformed delegate is not attributed", () => {
    expect(issuerOfPermanentDelegate(Keypair.generate().publicKey.toBase58())).to.equal(null);
    expect(issuerOfPermanentDelegate(null)).to.equal(null);
    expect(issuerOfPermanentDelegate(undefined)).to.equal(null);
    expect(issuerOfPermanentDelegate("")).to.equal(null);
    expect(issuerOfPermanentDelegate("not-a-pubkey")).to.equal(null);
  });

  it("the two OTHER equity-issuer delegates found on Mainnet are NOT attributed to xStocks", () => {
    // Real keys, read off the live catalogue on 2026-09-23 (45 and 9 mints).
    // They are equity issuers too, but not ones the program accepts, and
    // nothing may quietly fold them into the xStocks label.
    expect(issuerOfPermanentDelegate("2cVYpagTt7ZGc3mmTXBa7fAznUtx5DUu6aCq8uVDaf4a")).to.equal(null);
    expect(issuerOfPermanentDelegate("WV9PJN7XTmTLVwbutCLFxp8TyePee6Xq5mRq6Fti5Wc")).to.equal(null);
  });

  it("the approved-delegate list the program pins IS the issuer table, so the two cannot drift", () => {
    expect(APPROVED_PERMANENT_DELEGATES).to.equal(APPROVED_ISSUER_DELEGATES);
    expect(APPROVED_ISSUER_DELEGATES).to.deep.equal(SUPPORTED_ISSUERS.map((id) => ISSUER_LABELS[id].permanentDelegate));
  });

  it("isTokenIssuerId accepts only the exact ids", () => {
    expect(isTokenIssuerId("xstocks")).to.equal(true);
    expect(isTokenIssuerId("xStocks")).to.equal(false);
    expect(isTokenIssuerId("backed")).to.equal(false);
    expect(isTokenIssuerId(null)).to.equal(false);
    expect(isTokenIssuerId(undefined)).to.equal(false);
  });
});

describe("the picker's issuer filter", () => {
  it("offers every supported issuer plus 'any' and 'crypto only'", () => {
    const values = ISSUER_FILTER_OPTIONS.map((o) => o.value);
    expect(values[0]).to.equal("all");
    expect(values).to.include("crypto");
    for (const id of SUPPORTED_ISSUERS) expect(values).to.include(id);
  });

  it("'all' keeps everything; an issuer keeps only that issuer; 'crypto' keeps only unattributed assets", () => {
    expect(matchesIssuerFilter("xstocks", "all")).to.equal(true);
    expect(matchesIssuerFilter(null, "all")).to.equal(true);

    expect(matchesIssuerFilter("xstocks", "xstocks")).to.equal(true);
    expect(matchesIssuerFilter(null, "xstocks")).to.equal(false);

    expect(matchesIssuerFilter(null, "crypto")).to.equal(true);
    expect(matchesIssuerFilter(undefined, "crypto")).to.equal(true);
    expect(matchesIssuerFilter("xstocks", "crypto")).to.equal(false);
  });

  it("the badge names the issuer and its tooltip refuses to imply safety", () => {
    expect(issuerBadgeText("xstocks")).to.equal("xStocks");
    const title = issuerBadgeTitle("xstocks");
    expect(title).to.include("permanent delegate");
    expect(title).to.include("Not a safety rating");
  });
});

describe("issuer provenance never changes eligibility", () => {
  const base = (over: Partial<CatalogueRow>): CatalogueRow => ({
    mint: Keypair.generate().publicKey.toBase58(), symbol: "X", name: "X", decimals: 6, organicScore: 1,
    tokenProgram: null, launchpad: null, launchpadStage: null, launchpadVenue: null, issuer: null, ...over,
  });

  it("only the exact stored id survives; a stray value reads as no issuer", () => {
    expect(issuerOfRow({ issuer: "xstocks" })).to.equal("xstocks");
    expect(issuerOfRow({ issuer: "backed-finance" })).to.equal(null);
    expect(issuerOfRow({ issuer: null })).to.equal(null);
    expect(issuerOfRow({ issuer: undefined })).to.equal(null);
  });

  it("carries the issuer through the catalogue without letting it add or remove a token", () => {
    const rows = [
      base({ symbol: "TSLAx", issuer: "xstocks" }),
      base({ symbol: "JUP" }),
      // An issuer label must not rescue the reserved USDC symbol.
      base({ symbol: "USDC", issuer: "xstocks" }),
    ];
    const out = dedupeBySymbolPreferOrganicScore(rows);
    expect(out.map((t) => t.symbol).sort()).to.deep.equal(["JUP", "TSLAx"]);
    expect(out.find((t) => t.symbol === "TSLAx")!.issuer).to.equal("xstocks");
    expect(out.find((t) => t.symbol === "JUP")!.issuer).to.equal(null);
  });

  it("de-duplication still keys on organic score, never on issuer", () => {
    const rows = [base({ symbol: "DUP", organicScore: 5, issuer: "xstocks" }), base({ symbol: "DUP", organicScore: 9 })];
    const out = dedupeBySymbolPreferOrganicScore(rows);
    expect(out).to.have.length(1);
    expect(out[0].mint).to.equal(rows[1].mint);
    expect(out[0].issuer).to.equal(null);
  });
});
