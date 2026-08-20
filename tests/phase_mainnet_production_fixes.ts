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
import * as fs from "fs";
import * as path from "path";
import { PublicKey, Keypair } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { isReserveTradable, isSupportedAssetMint, registerDynamicSupportedAssetMints, SUPPORTED_ASSET_MINTS } from "../packages/sdk/src/tradableAssets";
import assetCatalogueHandler, { dedupeBySymbolPreferOrganicScore, type CatalogueRow } from "../api/ledger/asset-catalogue";
import knownMintsHandler from "../api/ledger/known-asset-mints";
import mainnetMetadataHandler from "../api/mainnet/reserve-metadata";
import { uploadReserveMetadata, isJupiterSwapEligible, assertSeedAmountsMeetMinimum, fetchOwnedBalanceRawSettled } from "../src/merge/lib/createReserveClient";
import { computeSwapShortfallPct, rawToUiAmount, determineDeploymentResumePoint, computeFundingShortfall, scaleUsdcBudgetForDeficit } from "../src/merge/lib/createReserveResume";
import { matchesAssetSearch } from "../src/merge/lib/assetSearch";
import jupiterSwapHandler from "../api/mainnet/jupiter-swap";
import { ALLOWED_METHODS as MAINNET_RPC_PROXY_ALLOWED_METHODS } from "../api/mainnet/rpc-proxy";
import { ALLOWED_METHODS as DEVNET_RPC_PROXY_ALLOWED_METHODS } from "../api/devnet/rpc-proxy";
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
  const row = (mint: string, symbol: string, organicScore: number | null, name: string | null = null, tokenProgram: string | null = null): CatalogueRow => ({
    mint,
    symbol,
    name,
    decimals: 6,
    organicScore,
    tokenProgram,
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

  it("excludes a confirmed Token-2022 mint entirely -- the client-side SDK hardcodes the classic Token program on every instruction it builds, so a Token-2022 asset would fail on-chain regardless of anything else fixed client-side", () => {
    const rows = [row("Classic1", "AAA", 10, null, "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"), row("T22Mint", "BBB", 10, null, "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb")];
    const result = dedupeBySymbolPreferOrganicScore(rows);
    expect(result.map((r) => r.mint)).to.deep.equal(["Classic1"]);
  });

  it("never excludes a row with a null/unknown tokenProgram (rows captured before this field existed) -- only a POSITIVELY confirmed Token-2022 mint is excluded", () => {
    const result = dedupeBySymbolPreferOrganicScore([row("Legacy1", "CCC", 10, null, null)]);
    expect(result.map((r) => r.mint)).to.deep.equal(["Legacy1"]);
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

describe("src/merge/lib/createReserveClient.ts -- assertSeedAmountsMeetMinimum (pure, pre-flight)", () => {
  const usdc = { mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" };
  const ssr = { mint: "BpdHpqznEgYPXZNrJVRZvBhdWoafYLVVuLxTQo34pump" };

  it("does not throw when every asset meets the protocol's minimum (1000 raw units)", () => {
    expect(() => assertSeedAmountsMeetMinimum([usdc, ssr], [10_000_000n, 21_341_811_000n])).to.not.throw();
  });

  it("does not throw for an amount exactly at the minimum", () => {
    expect(() => assertSeedAmountsMeetMinimum([ssr], [1_000n])).to.not.throw();
  });

  it("throws, naming the exact mint, when an asset's amount is below the minimum", () => {
    expect(() => assertSeedAmountsMeetMinimum([usdc, ssr], [10_000_000n, 0n])).to.throw(/BpdHpqznEgYPXZNrJVRZvBhdWoafYLVVuLxTQo34pump/);
  });

  it("catches the exact reported scenario -- a Jupiter swap that settled at 0", () => {
    expect(() => assertSeedAmountsMeetMinimum([ssr], [0n])).to.throw(/minimum/);
  });
});

// --- 2026-08-20 pass: "false failure" after a genuinely successful seed ---
// Live-reported incident: the Creator received the correct Reserve Token
// amount on-chain, but the UI reported "received less than expected: 0%"
// and/or SsrError::SeedAmountTooLow (6019), then marked the deployment
// incomplete. On-chain forensics (see docs/project/DECISION_LOG.md's entry
// for this pass) confirmed the wallet genuinely held ~128,431 SSR at the
// time of the failing seed_reserve call, ruling out a real, empty wallet.
// Two concrete, independently-testable mechanisms are covered below: (1)
// fetchOwnedBalanceRawSettled reading a real, just-landed balance as zero
// because a single immediate read can hit an RPC node whose own view of
// account state hasn't caught up yet (this repo's recurring RPC-eventual-
// consistency failure mode -- see DEC-0115, DEC-0127), and (2) a raw-to-UI
// decimal conversion that must be exact, since a wrong decimals value would
// itself manufacture a fake "0" or wildly wrong received-amount display
// even when the raw on-chain amount is correct. The third, architectural
// half of this fix -- CreateDTR.tsx re-checking AUTHORITATIVE on-chain
// Reserve state via checkReserveGenuinelyComplete before ever reporting
// "deployment incomplete," so a real success is never misreported as a
// failure and a real failure is never resubmitted -- reduces to
// determineDeploymentResumePoint's already-complete branch (covered
// exhaustively in tests/phase_reserve_deploy_resumability.ts); checkReserve
// GenuinelyComplete's own network call is a thin, strictly-read-only wrapper
// around that pure decision plus fetchReserveOnChain (an Anchor-program
// read against a live Connection), so -- matching this file's own header
// policy on live database/network reads -- its end-to-end behavior is
// verified live post-deploy rather than re-mocking Anchor's Program/
// AnchorProvider machinery here.
describe("src/merge/lib/createReserveClient.ts -- fetchOwnedBalanceRawSettled (delayed RPC balance updates)", () => {
  const mint = Keypair.generate().publicKey;
  const owner = Keypair.generate().publicKey;

  function fakeConnection(amounts: string[]) {
    let call = 0;
    return {
      getTokenAccountBalance: async (_ata: PublicKey) => {
        const amount = amounts[Math.min(call, amounts.length - 1)];
        call++;
        return { value: { amount } };
      },
    } as unknown as import("@solana/web3.js").Connection;
  }

  it("a real, correct receipt that only reads back as zero on the FIRST attempt (RPC lag) is corrected by the retry loop, never left at the stale zero", async () => {
    // Exactly the reported/observed failure shape: the swap/seed genuinely
    // landed, but the very first balance read after confirmation hit a
    // lagging RPC node and returned 0.
    const connection = fakeConnection(["0", "0", "21283780000"]);
    const result = await fetchOwnedBalanceRawSettled(connection, mint, owner, 0n, { maxAttempts: 6, delayMs: 1 });
    expect(result).to.equal(21_283_780_000n);
  });

  it("delayed RPC balance updates: keeps retrying (never gives up on attempt 1) until the read genuinely differs from the pre-transaction balance", async () => {
    const connection = fakeConnection(["1000", "1000", "1000", "5000"]); // balanceBefore=1000, only changes on the 4th read
    const result = await fetchOwnedBalanceRawSettled(connection, mint, owner, 1_000n, { maxAttempts: 6, delayMs: 1 });
    expect(result).to.equal(5_000n);
  });

  it("returns immediately without any retry delay when the very first read already differs from balanceBefore (the common, non-lagged case)", async () => {
    let calls = 0;
    const connection = {
      getTokenAccountBalance: async () => {
        calls++;
        return { value: { amount: "999999" } };
      },
    } as unknown as import("@solana/web3.js").Connection;
    const result = await fetchOwnedBalanceRawSettled(connection, mint, owner, 0n, { maxAttempts: 6, delayMs: 5_000 });
    expect(result).to.equal(999_999n);
    expect(calls).to.equal(1);
  });

  it("if the balance genuinely never changes within the retry window, returns the last (unchanged/stale) read rather than fabricating a change -- the caller (assertSeedAmountsMeetMinimum) is what turns this into an honest, actionable error", async () => {
    const connection = fakeConnection(["0"]); // never changes, ever
    const result = await fetchOwnedBalanceRawSettled(connection, mint, owner, 0n, { maxAttempts: 3, delayMs: 1 });
    expect(result).to.equal(0n);
  });

  it("real-world regression: a stale IMMEDIATE read of a successful swap would have wrongly tripped SeedAmountTooLow's pre-flight guard, but the settled read (after RPC catches up) does not", async () => {
    // Mirrors the exact reported sequence: wallet held far more than enough
    // (128,431 SSR, i.e. way above the 1000-raw-unit minimum), the swap/seed
    // genuinely landed, but a naive single immediate read saw 0.
    const staleImmediateRead = 0n;
    expect(() => assertSeedAmountsMeetMinimum([{ mint: mint.toBase58() }], [staleImmediateRead])).to.throw(/minimum/);

    const connection = fakeConnection(["0", "128431197991"]); // settles on the 2nd attempt
    const settledRead = await fetchOwnedBalanceRawSettled(connection, mint, owner, 0n, { maxAttempts: 6, delayMs: 1 });
    expect(() => assertSeedAmountsMeetMinimum([{ mint: mint.toBase58() }], [settledRead])).to.not.throw();
  });

  it("real ATA derivation is exercised (not bypassed) -- getAssociatedTokenAddressSync for this mint/owner pair is deterministic across calls", () => {
    const ataA = getAssociatedTokenAddressSync(mint, owner);
    const ataB = getAssociatedTokenAddressSync(mint, owner);
    expect(ataA.equals(ataB)).to.equal(true);
  });
});

describe("src/merge/lib/createReserveResume.ts -- rawToUiAmount (decimal conversion, pure)", () => {
  it("converts a real 6-decimal SSR/USDC-scale raw amount to its exact human value", () => {
    expect(rawToUiAmount(21_283_780_000n, 6)).to.equal(21_283.78);
  });

  it("converts a real 9-decimal (e.g. wrapped SOL-scale) raw amount correctly", () => {
    expect(rawToUiAmount(1_500_000_000n, 9)).to.equal(1.5);
  });

  it("0 decimals is a pass-through (never divides when it shouldn't)", () => {
    expect(rawToUiAmount(42n, 0)).to.equal(42);
  });

  it("a genuinely zero raw amount converts to exactly 0, never a falsy-but-wrong value, regardless of decimals", () => {
    expect(rawToUiAmount(0n, 6)).to.equal(0);
    expect(rawToUiAmount(0n, 9)).to.equal(0);
  });

  it("regression: using the WRONG decimals (e.g. falling back to 0 for an unrecognized mint) manufactures a fake, wildly-off received amount even when the raw on-chain value is correct -- this is exactly the kind of decimal-conversion bug that can produce a bogus '0%'/mismatched received-amount display independent of any real on-chain shortfall", () => {
    const realRawReceived = 21_283_780_000n; // genuinely correct, 6-decimal SSR
    const correctlyDisplayed = rawToUiAmount(realRawReceived, 6);
    const wrongDecimalsDisplayed = rawToUiAmount(realRawReceived, 0); // decimals=0 fallback bug
    expect(correctlyDisplayed).to.equal(21_283.78);
    expect(wrongDecimalsDisplayed).to.not.equal(correctlyDisplayed);
    expect(wrongDecimalsDisplayed).to.equal(21_283_780_000);
  });
});

describe("Reserve deploy resumability -- successful transaction with stale UI state (idempotent resume, never resubmits)", () => {
  it("a Reserve that reached Active (seeding genuinely succeeded) is ALWAYS reported already-complete regardless of what a caller's own stale in-flight error/state believed -- this is the exact fact checkReserveGenuinelyComplete's reconciliation relies on to turn a false 'deployment incomplete' failure back into a reported success without resubmitting anything", () => {
    const point = determineDeploymentResumePoint({ reserveExists: true, reserveStatus: "active", onChainAssetCount: 2, expectedAssetCount: 2 });
    expect(point).to.deep.equal({ kind: "already-complete" });
  });

  it("repeated reconciliation reads of the identical genuinely-complete on-chain state are idempotent -- calling it 1 time or 5 times (mirroring a flaky UI retrying/re-rendering) always yields the same already-complete verdict, never a resubmission-triggering verdict on a later call", () => {
    const params = { reserveExists: true, reserveStatus: "active" as const, onChainAssetCount: 1, expectedAssetCount: 1 };
    const results = [1, 2, 3, 4, 5].map(() => determineDeploymentResumePoint(params));
    for (const r of results) expect(r).to.deep.equal({ kind: "already-complete" });
  });

  it("a Reserve genuinely still mid-seeding (assetsInitializing) is NEVER reported already-complete -- reconciliation must not paper over a real, still-incomplete deployment", () => {
    const point = determineDeploymentResumePoint({ reserveExists: true, reserveStatus: "assetsInitializing", onChainAssetCount: 1, expectedAssetCount: 1 });
    expect(point.kind).to.not.equal("already-complete");
    expect(point).to.deep.equal({ kind: "resume-from-funding" });
  });
});

// --- 2026-08-20 pass (later the same day): "seeding step reads zero" ------
// CONFIRMED ROOT CAUSE, verified against real Mainnet accounts/transactions
// (see docs/project/DECISION_LOG.md's entry for this pass): the Mainnet
// (and DevNet) rpc-proxy's ALLOWED_METHODS list was missing
// "getTokenAccountBalance" entirely. Connection.getTokenAccountBalance --
// the ONLY way fetchOwnedBalanceRaw reads a wallet's real token balance --
// is the sole route the browser has to Mainnet RPC in production, so every
// single call was rejected with a JSON-RPC "Method not permitted via this
// proxy" error, which fetchOwnedBalanceRaw's blanket try/catch silently
// swallowed and reported as a balance of exactly 0 -- deterministically, on
// EVERY attempt (never a transient RPC-lag issue, which is what the prior
// same-day pass, DEC-0127/DEC-0128, incorrectly diagnosed this class of
// symptom as). This is why balance-based idempotency never worked: the
// "already holds enough, skip the swap" check always saw 0, so every retry
// re-swapped the FULL budget (confirmed live: a wallet holding ~149,711 SSR
// -- already ~7x the ~21,000 required -- still had a fresh $10 swap
// executed against it), and the post-swap settled-balance read ALSO always
// converged to 0 after exhausting its retries (since every attempt hit the
// identical hard rejection, not a lagging-but-eventually-consistent read),
// so assertSeedAmountsMeetMinimum correctly refused to submit -- but for
// the wrong-looking reason, since the wallet never actually lacked funds.
describe("api/mainnet/rpc-proxy.ts and api/devnet/rpc-proxy.ts -- getTokenAccountBalance allowlist (the confirmed root cause)", () => {
  it("Mainnet rpc-proxy allows getTokenAccountBalance -- Connection.getTokenAccountBalance is the ONLY way the browser can read a real Mainnet SPL token balance in production", () => {
    expect(MAINNET_RPC_PROXY_ALLOWED_METHODS.has("getTokenAccountBalance")).to.equal(true);
  });

  it("DevNet rpc-proxy also allows getTokenAccountBalance -- the same createReserveClient.ts code path is shared between clusters", () => {
    expect(DEVNET_RPC_PROXY_ALLOWED_METHODS.has("getTokenAccountBalance")).to.equal(true);
  });

  it("still rejects a genuinely unrelated/unaudited method (regression guard: fixing this one method must not have widened the allowlist into a blanket pass-through)", () => {
    expect(MAINNET_RPC_PROXY_ALLOWED_METHODS.has("getProgramAccounts")).to.equal(false);
    expect(DEVNET_RPC_PROXY_ALLOWED_METHODS.has("getProgramAccounts")).to.equal(false);
  });
});

describe("createReserveClient.ts's real Connection method usage stays inside both rpc-proxy allowlists (self-auditing regression guard)", () => {
  // Reads the ACTUAL source files and extracts every `connection.<method>(`
  // call site, rather than hand-maintaining a second, driftable list here --
  // this is exactly the kind of check that would have caught
  // getTokenAccountBalance's omission the moment it was first called,
  // instead of only being discovered live in production. web3.js's
  // Connection.sendRawTransaction issues the JSON-RPC method
  // "sendTransaction" (not literally "sendRawTransaction"), so that one
  // client method name is mapped to its real wire method below.
  const METHOD_TO_RPC_NAME: Record<string, string> = { sendRawTransaction: "sendTransaction" };

  function extractConnectionMethodCalls(sourcePath: string): string[] {
    const source = fs.readFileSync(path.join(__dirname, "..", sourcePath), "utf8");
    const found = new Set<string>();
    const re = /connection\.([a-zA-Z]+)\(/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) {
      found.add(METHOD_TO_RPC_NAME[m[1]] ?? m[1]);
    }
    return [...found];
  }

  it("every Connection method createReserveClient.ts actually calls is present in BOTH the Mainnet and DevNet rpc-proxy allowlists", () => {
    const methods = extractConnectionMethodCalls("src/merge/lib/createReserveClient.ts");
    expect(methods.length).to.be.greaterThan(0); // sanity -- a broken extraction regex must not silently pass 0 checks.
    expect(methods).to.include("getTokenAccountBalance"); // sanity -- confirms this audit would have caught the exact regression it's guarding against.
    for (const method of methods) {
      expect(MAINNET_RPC_PROXY_ALLOWED_METHODS.has(method), `Mainnet rpc-proxy missing "${method}"`).to.equal(true);
      expect(DEVNET_RPC_PROXY_ALLOWED_METHODS.has(method), `DevNet rpc-proxy missing "${method}"`).to.equal(true);
    }
  });

  it("every Connection method rpcResilience.ts actually calls is present in BOTH allowlists too", () => {
    const methods = extractConnectionMethodCalls("src/merge/lib/rpcResilience.ts");
    expect(methods.length).to.be.greaterThan(0);
    for (const method of methods) {
      expect(MAINNET_RPC_PROXY_ALLOWED_METHODS.has(method), `Mainnet rpc-proxy missing "${method}"`).to.equal(true);
      expect(DEVNET_RPC_PROXY_ALLOWED_METHODS.has(method), `DevNet rpc-proxy missing "${method}"`).to.equal(true);
    }
  });
});

describe("src/merge/lib/createReserveResume.ts -- scaleUsdcBudgetForDeficit (pure, deficit-only Jupiter swap sizing)", () => {
  it("existing sufficient balance: a zero deficit needs zero USDC -- the caller's own balance>=target check is what skips the swap entirely, but the sizing function itself must never suggest spending anything for a deficit that isn't real", () => {
    expect(scaleUsdcBudgetForDeficit(10_000_000n, 0n, 21_000_000_000n)).to.equal(0n);
  });

  it("zero existing balance (nothing held yet): the deficit IS the full target, so the full USDC budget is used unchanged -- matches this app's original (correct) first-attempt behavior exactly", () => {
    expect(scaleUsdcBudgetForDeficit(10_000_000n, 21_000_000_000n, 21_000_000_000n)).to.equal(10_000_000n);
  });

  it("partial deficit: scales the USDC budget down proportionally to only the genuinely-missing fraction of the target -- the exact fix for the confirmed live incident (a wallet already ~7x over target still had the FULL budget re-swapped)", () => {
    // Held 30% of target already -> only the remaining 70% should be bought.
    const usdcBudgetRaw = 10_000_000n; // $10
    const targetRaw = 100_000_000n; // 100 tokens, 6 decimals
    const existingRaw = 30_000_000n; // already holds 30 tokens (30%)
    const deficitRaw = targetRaw - existingRaw; // 70 tokens
    const scaled = scaleUsdcBudgetForDeficit(usdcBudgetRaw, deficitRaw, targetRaw);
    expect(scaled).to.equal(7_000_000n); // exactly 70% of the $10 budget, not the full $10
  });

  it("a wallet holding ~9x the target (the exact reported scenario, 191,598 held vs. ~21,000 required) has a zero deficit -- computeFundingShortfall floors at zero, never a negative amount to 'buy back'", () => {
    const targetRaw = 21_000_000_000n; // ~21,000 SSR, 6 decimals
    const existingRaw = 191_598_743_106n; // the real, confirmed live balance
    const deficitRaw = computeFundingShortfall(targetRaw, existingRaw);
    expect(deficitRaw).to.equal(0n);
    expect(scaleUsdcBudgetForDeficit(10_000_000n, deficitRaw, targetRaw)).to.equal(0n);
  });

  it("floors a genuine but tiny nonzero deficit at 1 raw unit -- never rounds an integer-division result down to 0 and silently asks Jupiter to swap nothing", () => {
    const scaled = scaleUsdcBudgetForDeficit(1n, 1n, 1_000_000_000n); // 1 raw USDC unit budget, a minuscule fraction of the target still missing
    expect(scaled).to.equal(1n);
    expect(scaled).to.be.greaterThan(0n);
  });

  it("a zero or negative target never divides by zero -- returns 0 (nothing to buy) rather than throwing or fabricating an amount", () => {
    expect(scaleUsdcBudgetForDeficit(10_000_000n, 5_000_000n, 0n)).to.equal(0n);
  });
});

describe("Idempotent seed-funding across repeated resume attempts -- prevention of duplicate/full-re-swaps once a prior swap already landed", () => {
  it("resume after a successful swap: once the real balance genuinely reaches the target (as it would after a prior attempt's swap actually confirmed), the NEXT attempt's own deficit calculation is zero -- the swap is never repeated", () => {
    const targetRaw = 21_283_780_000n; // matches this pass's own real, confirmed-on-chain SSR seed target
    // Simulates 3 successive resume attempts against the SAME real balance,
    // as would happen if a user repeatedly clicks Resume -- every single one
    // must compute the identical zero deficit, never re-deriving a nonzero
    // one from stale/inconsistent state.
    const balanceAfterFirstSwap = targetRaw; // the swap landed and met the target exactly
    for (let attempt = 0; attempt < 3; attempt++) {
      const deficit = computeFundingShortfall(targetRaw, balanceAfterFirstSwap);
      expect(deficit, `attempt ${attempt}`).to.equal(0n);
      expect(scaleUsdcBudgetForDeficit(10_000_000n, deficit, targetRaw), `attempt ${attempt}`).to.equal(0n);
    }
  });

  it("a genuinely still-partial balance after an interrupted first swap correctly computes a nonzero (but never full-budget) deficit on the resume attempt", () => {
    const targetRaw = 21_283_780_000n;
    const partialBalance = 10_000_000_000n; // roughly half-funded from an earlier, partially-successful attempt
    const deficit = computeFundingShortfall(targetRaw, partialBalance);
    const scaled = scaleUsdcBudgetForDeficit(10_000_000n, deficit, targetRaw);
    expect(deficit).to.be.greaterThan(0n);
    expect(scaled).to.be.greaterThan(0n);
    expect(scaled).to.be.lessThan(10_000_000n); // must be LESS than the full $10 budget -- the whole point of this fix.
  });
});

describe("src/merge/lib/createReserveClient.ts -- fetchOwnedBalanceRawSettled exponential backoff (delayed RPC visibility, reasonable timeout/backoff)", () => {
  it("backs off exponentially (never a flat interval) between retries, capped at maxDelayMs", async () => {
    const mint = Keypair.generate().publicKey;
    const owner = Keypair.generate().publicKey;
    const delaysObserved: number[] = [];
    let call = 0;
    const connection = {
      getTokenAccountBalance: async () => {
        call++;
        return { value: { amount: "0" } }; // never changes -- forces every retry to actually sleep, so every delay gets observed.
      },
    } as unknown as import("@solana/web3.js").Connection;

    const originalSetTimeout = global.setTimeout;
    (global as unknown as { setTimeout: typeof setTimeout }).setTimeout = ((fn: () => void, ms?: number) => {
      delaysObserved.push(ms ?? 0);
      return originalSetTimeout(fn, 0); // fire immediately -- this test verifies the COMPUTED backoff values, not real wall-clock time.
    }) as typeof setTimeout;
    try {
      await fetchOwnedBalanceRawSettled(connection, mint, owner, 0n, { maxAttempts: 4, delayMs: 100, maxDelayMs: 300 });
    } finally {
      global.setTimeout = originalSetTimeout;
    }
    expect(call).to.equal(4);
    expect(delaysObserved).to.deep.equal([100, 200, 300]); // 100, 200 (100*2), then capped at maxDelayMs (would be 400 uncapped)
  });
});

describe("ATA derivation -- Token Program vs. Token-2022 consistency", () => {
  const TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
  const TOKEN_2022_PROGRAM_ID = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

  it("getAssociatedTokenAddressSync(mint, owner) with no explicit programId derives against the CLASSIC Token program -- verified live against the real, confirmed on-chain SSR account this incident was diagnosed against (63UUcPv7qnDjGXtS64VyUuYXQrLRNKoXK4ddWJP8YvM3, owned by TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA)", () => {
    const owner = new PublicKey("6BjTPAWGjUYjL2Hrvz7iVmzWv8yKHNDqUAif5DEPWZen");
    const mint = new PublicKey("BpdHpqznEgYPXZNrJVRZvBhdWoafYLVVuLxTQo34pump");
    const ata = getAssociatedTokenAddressSync(mint, owner);
    expect(ata.toBase58()).to.equal("63UUcPv7qnDjGXtS64VyUuYXQrLRNKoXK4ddWJP8YvM3");
  });

  it("this app's client-side SDK genuinely only supports the classic Token program end to end (every instruction builder hardcodes TOKEN_PROGRAM_ID) -- excluding Token-2022 mints from the picker (see the asset-catalogue tests above) is therefore correct scoping, not an arbitrary restriction", () => {
    const sdkFiles = ["packages/sdk/src/createReserveFlow.ts", "packages/sdk/src/directInstructions.ts", "packages/sdk/src/managementInstructions.ts"];
    for (const file of sdkFiles) {
      const source = fs.readFileSync(path.join(__dirname, "..", file), "utf8");
      expect(source, file).to.include("tokenProgram: TOKEN_PROGRAM_ID");
      expect(source, file).to.not.include(TOKEN_2022_PROGRAM_ID);
    }
  });

  it("TOKEN_PROGRAM_ID and TOKEN_2022_PROGRAM_ID are genuinely distinct real Mainnet program addresses (sanity -- guards against a copy-paste typo making the exclusion check above a no-op)", () => {
    expect(TOKEN_PROGRAM_ID).to.not.equal(TOKEN_2022_PROGRAM_ID);
    expect(() => new PublicKey(TOKEN_PROGRAM_ID)).to.not.throw();
    expect(() => new PublicKey(TOKEN_2022_PROGRAM_ID)).to.not.throw();
  });
});
