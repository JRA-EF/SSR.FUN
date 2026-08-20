// Offline, pure-logic regression coverage for the 2026-08-20 production
// incident pass: the api/mainnet/rpc-proxy ESM/CommonJS crash (both the
// homepage and Reserve-launch Wallet Cost Summary 500s), DevNet/Mainnet
// data-mixing (landing-stats, reserve-metadata routing), duplicate homepage
// warnings, and the Mainnet Jupiter-catalogue Reserve Asset selector. See
// docs/project/DECISION_LOG.md's entry for this pass for the full root
// causes.
//
// NOT covered here (documented, not silently skipped): the actual
// api/mainnet/rpc-proxy ESM crash itself is a deployment/build-format bug
// (a missing api/mainnet/package.json), not something a Node-side unit test
// can reproduce -- verified instead by a live post-deploy request (see this
// pass's Decision Log evidence). Live database reads (asset-catalogue.ts's/
// known-asset-mints.ts's SQL query shape, the Jupiter API fetch itself) are
// exercised live post-deploy the same way every other lib/ledger.ts DB
// function in this repo is (see tests/phase_ledger.ts's own header) -- this
// file covers their pure/extractable logic and their fail-closed,
// sanitized-error behavior only.
import { expect } from "chai";
import { isReserveTradable, isSupportedAssetMint, registerDynamicSupportedAssetMints, SUPPORTED_ASSET_MINTS } from "../packages/sdk/src/tradableAssets";
import assetCatalogueHandler, { dedupeBySymbolPreferOrganicScore, type CatalogueRow } from "../api/ledger/asset-catalogue";
import knownMintsHandler from "../api/ledger/known-asset-mints";
import mainnetMetadataHandler from "../api/mainnet/reserve-metadata";
import { uploadReserveMetadata, isJupiterSwapEligible } from "../src/merge/lib/createReserveClient";
import { computeSwapShortfallPct } from "../src/merge/lib/createReserveResume";
import { matchesAssetSearch } from "../src/merge/lib/assetSearch";
import jupiterSwapHandler from "../api/mainnet/jupiter-swap";
import { describeJupiterSwapError } from "../src/merge/lib/jupiterSwapClient";

interface FakeReq {
  method?: string;
}
class FakeRes {
  statusCode = 0;
  body: unknown = null;
  status(code: number) {
    this.statusCode = code;
    return this;
  }
  setHeader() {}
  json(body: unknown) {
    this.body = body;
  }
}

describe("packages/sdk/src/tradableAssets.ts -- dynamic Mainnet mint registration", () => {
  it("registering a new mint never changes the static SUPPORTED_ASSET_MINTS set", () => {
    const sizeBefore = SUPPORTED_ASSET_MINTS.size;
    registerDynamicSupportedAssetMints(["PhaseTestDynamicMintA111111111111111111111"]);
    expect(SUPPORTED_ASSET_MINTS.size).to.equal(sizeBefore);
    expect(SUPPORTED_ASSET_MINTS.has("PhaseTestDynamicMintA111111111111111111111")).to.equal(false);
  });

  it("a registered mint becomes supported without affecting an unrelated, never-registered mint", () => {
    registerDynamicSupportedAssetMints(["PhaseTestDynamicMintB222222222222222222222"]);
    expect(isSupportedAssetMint("PhaseTestDynamicMintB222222222222222222222")).to.equal(true);
    expect(isSupportedAssetMint("PhaseTestNeverRegisteredMintZZZZZZZZZZZZZZZ")).to.equal(false);
  });

  it("isReserveTradable honors dynamically-registered mints alongside the static set", () => {
    registerDynamicSupportedAssetMints(["PhaseTestDynamicMintC333333333333333333333"]);
    expect(isReserveTradable(["PhaseTestDynamicMintC333333333333333333333"])).to.equal(true);
    // Mixing one static (real Mainnet USDC) and one dynamically-registered mint is tradable too.
    expect(isReserveTradable(["EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", "PhaseTestDynamicMintC333333333333333333333"])).to.equal(true);
  });

  it("registration is additive/idempotent -- registering the same mint twice changes nothing", () => {
    registerDynamicSupportedAssetMints(["PhaseTestDynamicMintD444444444444444444444"]);
    registerDynamicSupportedAssetMints(["PhaseTestDynamicMintD444444444444444444444"]);
    expect(isSupportedAssetMint("PhaseTestDynamicMintD444444444444444444444")).to.equal(true);
  });
});

describe("api/ledger/asset-catalogue.ts -- dedupeBySymbolPreferOrganicScore (pure)", () => {
  const row = (mint: string, symbol: string, organicScore: number | null, name: string | null = null): CatalogueRow => ({
    mint,
    symbol,
    name,
    decimals: 6,
    organicScore,
  });

  it("keeps only the highest-organic-score mint when two rows share a symbol (squatter/duplicate protection)", () => {
    const rows = [row("MintLow", "FOO", 10), row("MintHigh", "FOO", 90)];
    const result = dedupeBySymbolPreferOrganicScore(rows);
    expect(result).to.have.length(1);
    expect(result[0].mint).to.equal("MintHigh");
  });

  it("excludes the reserved USDC symbol entirely, case-insensitively -- the app's own hardcoded MAINNET_USDC_MINT is the only USDC entry ever offered", () => {
    const rows = [row("FakeUsdcMint", "USDC", 100), row("LowerCaseUsdc", "usdc", 100), row("RealAsset", "JUP", 50)];
    const result = dedupeBySymbolPreferOrganicScore(rows);
    expect(result.map((r) => r.symbol)).to.deep.equal(["JUP"]);
  });

  it("sorts by organic score descending, nulls last, symbol as a stable tiebreak", () => {
    const rows = [row("M1", "AAA", null), row("M2", "ZZZ", 5), row("M3", "BBB", 5)];
    const result = dedupeBySymbolPreferOrganicScore(rows);
    expect(result.map((r) => r.symbol)).to.deep.equal(["BBB", "ZZZ", "AAA"]);
  });

  it("falls back to the symbol as the display name when Jupiter's name field is null (never blank)", () => {
    const result = dedupeBySymbolPreferOrganicScore([row("M1", "NONAME", 1, null)]);
    expect(result[0].name).to.equal("NONAME");
  });

  it("an empty input list produces an empty, valid (never fabricated) result", () => {
    expect(dedupeBySymbolPreferOrganicScore([])).to.deep.equal([]);
  });
});

describe("api/ledger/asset-catalogue.ts and api/ledger/known-asset-mints.ts -- method allowlist + sanitized failure", () => {
  it("asset-catalogue.ts rejects a non-GET method with 405, no database touched", async () => {
    const res = new FakeRes();
    await assetCatalogueHandler({ method: "POST" } as FakeReq, res as never);
    expect(res.statusCode).to.equal(405);
  });

  it("known-asset-mints.ts rejects a non-GET method with 405, no database touched", async () => {
    const res = new FakeRes();
    await knownMintsHandler({ method: "DELETE" } as FakeReq, res as never);
    expect(res.statusCode).to.equal(405);
  });

  it("asset-catalogue.ts never leaks the raw 'DATABASE_URL is not configured.' driver message to the client on a DB failure -- only the sanitized notice", async () => {
    const previous = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    try {
      const res = new FakeRes();
      await assetCatalogueHandler({ method: "GET" } as FakeReq, res as never);
      expect(res.statusCode).to.equal(503);
      const body = res.body as { error?: string };
      expect(body.error).to.equal("The asset catalogue is temporarily unavailable.");
      expect(body.error).to.not.include("DATABASE_URL");
    } finally {
      if (previous !== undefined) process.env.DATABASE_URL = previous;
    }
  });

  it("known-asset-mints.ts never leaks the raw 'DATABASE_URL is not configured.' driver message to the client on a DB failure -- only the sanitized notice", async () => {
    const previous = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    try {
      const res = new FakeRes();
      await knownMintsHandler({ method: "GET" } as FakeReq, res as never);
      expect(res.statusCode).to.equal(503);
      const body = res.body as { error?: string };
      expect(body.error).to.equal("The known-asset-mint list is temporarily unavailable.");
      expect(body.error).to.not.include("DATABASE_URL");
    } finally {
      if (previous !== undefined) process.env.DATABASE_URL = previous;
    }
  });
});

describe("api/mainnet/reserve-metadata.ts -- cluster-routed, no DevNet path", () => {
  it("rejects a non-GET/POST method with 405", async () => {
    const res = new FakeRes();
    await mainnetMetadataHandler({ method: "PUT", headers: {} } as never, res as never);
    expect(res.statusCode).to.equal(405);
  });

  it("a GET with no id is a clean 400, not a DB touch or a crash", async () => {
    const res = new FakeRes();
    await mainnetMetadataHandler({ method: "GET", headers: {}, url: "/api/mainnet/reserve-metadata" } as never, res as never);
    expect(res.statusCode).to.equal(400);
  });
});

describe("src/merge/lib/assetSearch.ts -- matchesAssetSearch (Reserve Asset picker search, pure)", () => {
  const usdc = { name: "USD Coin", symbol: "USDC", mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" };
  const ssr = { name: "SSR", symbol: "SSR", mint: "BpdHpqznEgYPXZNrJVRZvBhdWoafYLVVuLxTQo34pump" };

  it("an empty or whitespace-only query matches everything", () => {
    expect(matchesAssetSearch(usdc, "")).to.equal(true);
    expect(matchesAssetSearch(usdc, "   ")).to.equal(true);
  });

  it("matches by name or ticker, case-insensitively", () => {
    expect(matchesAssetSearch(usdc, "usd")).to.equal(true);
    expect(matchesAssetSearch(usdc, "USDC")).to.equal(true);
    expect(matchesAssetSearch(usdc, "coin")).to.equal(true);
    expect(matchesAssetSearch(usdc, "sol")).to.equal(false);
  });

  it("matches by a full contract address, case-insensitively", () => {
    expect(matchesAssetSearch(ssr, "BpdHpqznEgYPXZNrJVRZvBhdWoafYLVVuLxTQo34pump")).to.equal(true);
    expect(matchesAssetSearch(ssr, "bpdhpqznegypxzNRJVRZvBhdWoafYLVVuLxTQo34PUMP")).to.equal(true);
  });

  it("matches by a partial contract-address substring (a pasted prefix/suffix)", () => {
    expect(matchesAssetSearch(ssr, "34pump")).to.equal(true);
    expect(matchesAssetSearch(ssr, "BpdHpqzn")).to.equal(true);
  });

  it("does not match an unrelated asset's contract address", () => {
    expect(matchesAssetSearch(usdc, "34pump")).to.equal(false);
    expect(matchesAssetSearch(ssr, "EPjFWdd5")).to.equal(false);
  });
});

describe("src/merge/lib/createReserveClient.ts -- uploadReserveMetadata is cluster-routed", () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("defaults to the DevNet route when no cluster is given (existing callers/scripts keep working unchanged)", async () => {
    let requestedUrl = "";
    global.fetch = (async (url: string) => {
      requestedUrl = String(url);
      return { ok: true, json: async () => ({ id: "abc123" }) } as Response;
    }) as typeof fetch;
    const uri = await uploadReserveMetadata("https://example.test", { name: "N", ticker: "T", description: "", category: "Other", buyTaxPct: 0, sellTaxPct: 0 });
    expect(requestedUrl).to.equal("https://example.test/api/devnet/reserve-metadata");
    expect(uri).to.equal("https://example.test/api/devnet/reserve-metadata?id=abc123");
  });

  it("routes to /api/mainnet/reserve-metadata when cluster='mainnet' -- never the DevNet path", async () => {
    let requestedUrl = "";
    global.fetch = (async (url: string) => {
      requestedUrl = String(url);
      return { ok: true, json: async () => ({ id: "xyz789" }) } as Response;
    }) as typeof fetch;
    const uri = await uploadReserveMetadata("https://strategic-super-reserve.fun", { name: "N", ticker: "T", description: "", category: "Other", buyTaxPct: 0, sellTaxPct: 0 }, "mainnet");
    expect(requestedUrl).to.equal("https://strategic-super-reserve.fun/api/mainnet/reserve-metadata");
    expect(uri).to.equal("https://strategic-super-reserve.fun/api/mainnet/reserve-metadata?id=xyz789");
    expect(uri).to.not.include("/api/devnet/");
  });
});

describe("src/merge/lib/createReserveClient.ts -- isJupiterSwapEligible (pure)", () => {
  const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  const WSOL = "So11111111111111111111111111111111111111112";
  const SSR = "BpdHpqznEgYPXZNrJVRZvBhdWoafYLVVuLxTQo34pump";

  it("real Circle USDC is never swap-eligible -- it's the input currency, not something to swap for", () => {
    expect(isJupiterSwapEligible(USDC)).to.equal(false);
  });

  it("wrapped SOL is never swap-eligible -- it's funded by the creator wrapping their own SOL, not a Jupiter swap", () => {
    expect(isJupiterSwapEligible(WSOL)).to.equal(false);
  });

  it("any other real asset (e.g. a Jupiter-catalogue token) is swap-eligible", () => {
    expect(isJupiterSwapEligible(SSR)).to.equal(true);
  });
});

describe("api/mainnet/jupiter-swap.ts -- input validation (no network/API-key dependency)", () => {
  const VALID_OUTPUT_MINT = "BpdHpqznEgYPXZNrJVRZvBhdWoafYLVVuLxTQo34pump";
  const VALID_USER_PUBKEY = "9bAG6E3NrPrnANfhCQTiqJ1MTGNApPqvMjDsxvtMWkJG";
  const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

  it("rejects a non-POST method with 405", async () => {
    const res = new FakeRes();
    await jupiterSwapHandler({ method: "GET", headers: {} } as never, res as never);
    expect(res.statusCode).to.equal(405);
  });

  it("rejects USDC itself as the outputMint -- it's the input currency, not a swap target", async () => {
    const res = new FakeRes();
    await jupiterSwapHandler({ method: "POST", headers: {}, body: { outputMint: USDC, amountRaw: "1000000", userPublicKey: VALID_USER_PUBKEY } } as never, res as never);
    expect(res.statusCode).to.equal(400);
  });

  it("rejects a malformed outputMint", async () => {
    const res = new FakeRes();
    await jupiterSwapHandler({ method: "POST", headers: {}, body: { outputMint: "not-base58!!!", amountRaw: "1000000", userPublicKey: VALID_USER_PUBKEY } } as never, res as never);
    expect(res.statusCode).to.equal(400);
  });

  it("rejects a malformed userPublicKey", async () => {
    const res = new FakeRes();
    await jupiterSwapHandler({ method: "POST", headers: {}, body: { outputMint: VALID_OUTPUT_MINT, amountRaw: "1000000", userPublicKey: "not-a-real-pubkey" } } as never, res as never);
    expect(res.statusCode).to.equal(400);
  });

  it("rejects a non-numeric amountRaw", async () => {
    const res = new FakeRes();
    await jupiterSwapHandler({ method: "POST", headers: {}, body: { outputMint: VALID_OUTPUT_MINT, amountRaw: "not-a-number", userPublicKey: VALID_USER_PUBKEY } } as never, res as never);
    expect(res.statusCode).to.equal(400);
  });

  it("rejects a zero or negative amountRaw", async () => {
    const res = new FakeRes();
    await jupiterSwapHandler({ method: "POST", headers: {}, body: { outputMint: VALID_OUTPUT_MINT, amountRaw: "0", userPublicKey: VALID_USER_PUBKEY } } as never, res as never);
    expect(res.statusCode).to.equal(400);
  });

  it("rejects a slippageBps outside 1..500", async () => {
    const res = new FakeRes();
    await jupiterSwapHandler({ method: "POST", headers: {}, body: { outputMint: VALID_OUTPUT_MINT, amountRaw: "1000000", userPublicKey: VALID_USER_PUBKEY, slippageBps: 10_000 } } as never, res as never);
    expect(res.statusCode).to.equal(400);
  });

  it("returns a clean 500 (not a crash) when JUPITER_API_KEY isn't configured, only after input validation passes", async () => {
    const previous = process.env.JUPITER_API_KEY;
    delete process.env.JUPITER_API_KEY;
    try {
      const res = new FakeRes();
      await jupiterSwapHandler({ method: "POST", headers: {}, body: { outputMint: VALID_OUTPUT_MINT, amountRaw: "1000000", userPublicKey: VALID_USER_PUBKEY } } as never, res as never);
      expect(res.statusCode).to.equal(500);
      const body = res.body as { error?: string };
      expect(body.error).to.equal("Jupiter swap is not configured on this deployment.");
    } finally {
      if (previous !== undefined) process.env.JUPITER_API_KEY = previous;
    }
  });
});

describe("src/merge/lib/createReserveResume.ts -- computeSwapShortfallPct (pure)", () => {
  it("a swap that met or exceeded its quoted target is never a shortfall", () => {
    expect(computeSwapShortfallPct(1_000_000n, 1_000_000n)).to.equal(0);
    expect(computeSwapShortfallPct(1_000_000n, 1_200_000n)).to.equal(0);
  });

  it("computes the exact fraction short of target for a genuine shortfall", () => {
    expect(computeSwapShortfallPct(1_000_000n, 900_000n)).to.equal(0.1);
    expect(computeSwapShortfallPct(1_000_000n, 500_000n)).to.equal(0.5);
  });

  it("a zero actual result against a real target is a 100% shortfall", () => {
    expect(computeSwapShortfallPct(1_000_000n, 0n)).to.equal(1);
  });

  it("a zero target is never a shortfall (nothing was expected)", () => {
    expect(computeSwapShortfallPct(0n, 0n)).to.equal(0);
  });
});

describe("src/merge/lib/jupiterSwapClient.ts -- describeJupiterSwapError (pure)", () => {
  it("decodes a real InstructionError/Custom shape into an honest, swap-context explanation, never claiming a specific ssr_protocol meaning", () => {
    const msg = describeJupiterSwapError('{"InstructionError":[4,{"Custom":52}]}');
    expect(msg).to.include("error code 52");
    expect(msg).to.include("slippage");
    expect(msg).to.not.include("ssr_protocol");
    expect(msg).to.not.include("program binary has drifted");
  });

  it("falls back to a generic-but-honest message for an error shape it doesn't recognize", () => {
    const msg = describeJupiterSwapError('{"SomeOtherErrorShape":true}');
    expect(msg).to.include("slippage");
    expect(msg).to.include('{"SomeOtherErrorShape":true}');
  });

  it("never throws on malformed/non-JSON input -- always returns a usable message", () => {
    const msg = describeJupiterSwapError("not json at all");
    expect(msg).to.be.a("string");
    expect(msg.length).to.be.greaterThan(0);
  });
});
