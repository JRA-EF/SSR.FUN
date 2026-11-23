// Beta-feedback data/display fixes (2026-11-23):
//  1. Jupiter Price V3 drops ids past 50 per request, so the warm-cache pass
//     left 10 mints unpriced and Reserves #93/#95 never got a NAV point (no
//     campaign PnL row). fetchJupiterPrices now batches.
//  2. Entered Reserves without a PnL figure are listed as "n/a" with a reason.
//  3. Discover hides small/inactive Reserves behind a toggle.
//  4. Old *.vercel.app metadata hosts are rewritten to the current origin.
//   npx ts-mocha -p ./tests/tsconfig.json tests/phase_data_display.ts
import { expect } from "chai";
import fs from "node:fs";
import path from "node:path";
import { fetchJupiterPrices, JUPITER_PRICE_MAX_IDS } from "../api/mainnet/asset-prices";
import { pnlUnavailableReason } from "../lib/campaign/rules";
import { isSmallOrInactiveReserve } from "../src/merge/lib/directoryEntry";
import { isAppServedUrl, rewriteAppMetadataUriToCurrentOrigin } from "../packages/sdk/src/discovery";
import { rewriteAppImageUrl } from "../lib/reserve-metadata/tokenMetadata";

const ROOT = path.resolve(__dirname, "..");
const read = (f: string) => fs.readFileSync(path.join(ROOT, f), "utf8");

describe("Jupiter price batching (warm-cache / landing-stats)", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("splits more than 50 mints into batches of at most 50 and merges every answer", async () => {
    const mints = Array.from({ length: 61 }, (_, i) => `Mint${String(i).padStart(3, "0")}`);
    const batches: string[][] = [];
    globalThis.fetch = (async (url: string) => {
      const ids = new URL(url).searchParams.get("ids")!.split(",");
      batches.push(ids);
      // Mimic Jupiter: answer at most 50 ids.
      const body = Object.fromEntries(ids.slice(0, 50).map((m) => [m, { usdPrice: 2, decimals: 6, blockId: 1 }]));
      return { ok: true, status: 200, json: async () => body } as unknown as Response;
    }) as typeof fetch;
    const out = await fetchJupiterPrices(mints);
    expect(JUPITER_PRICE_MAX_IDS).to.equal(50);
    expect(batches.every((b) => b.length <= 50)).to.equal(true);
    expect(batches.flat().sort()).to.deep.equal([...mints].sort());
    expect(out.size).to.equal(61);
  });

  it("still throws on a failed batch when the caller asks (launch seeds must retry, not misprice)", async () => {
    let n = 0;
    globalThis.fetch = (async () => {
      n++;
      return (n === 1 ? { ok: true, status: 200, json: async () => ({}) } : { ok: false, status: 503, json: async () => null }) as unknown as Response;
    }) as typeof fetch;
    const mints = Array.from({ length: 55 }, (_, i) => `M${i}`);
    let threw = false;
    try {
      await fetchJupiterPrices(mints, { throwOnFailure: true });
    } catch {
      threw = true;
    }
    expect(threw).to.equal(true);
  });
});

describe("Campaign leaderboard: PnL n/a reasons", () => {
  it("explains each case in plain language", () => {
    expect(pnlUnavailableReason({ supplyRaw: "0", hasLaunchAnchor: true, hasHistory: true, livePriced: true })).to.match(/No Reserve Tokens in circulation/);
    expect(pnlUnavailableReason({ supplyRaw: "1000000", hasLaunchAnchor: true, hasHistory: false, livePriced: false })).to.match(/no live USD price/);
    expect(pnlUnavailableReason({ supplyRaw: "1000000", hasLaunchAnchor: false, hasHistory: false, livePriced: true })).to.match(/launch price/);
    expect(pnlUnavailableReason({ supplyRaw: "1000000", hasLaunchAnchor: true, hasHistory: true, livePriced: true })).to.match(/Not enough price history/);
  });

  it("the API returns pnlUnavailable and the page renders it, with no horizontal scroll in the cards", () => {
    expect(read("lib/campaign/leaderboard.ts")).to.include("pnlUnavailable:");
    const html = read("leaderboard.html");
    expect(html).to.include('id="pnl-notes"');
    expect(html).to.include("table-layout: fixed");
    expect(html).not.to.match(/\.table-wrap\s*\{\s*overflow-x:\s*auto/);
    expect(read("src/leaderboard/main.ts")).to.include("'n/a'");
  });
});

describe("Discover: small/inactive Reserves filter", () => {
  const onChain = (supply: string, priceSource: string = "jupiter") =>
    ({ status: "active", reserveTokenSupplyRaw: supply, priceSource }) as never;

  it("hides empty, nearly-empty and under-$1 Reserves; never an unpriced or simulated one", () => {
    expect(isSmallOrInactiveReserve({ aum: 0, onChain: onChain("0") })).to.equal(true);
    expect(isSmallOrInactiveReserve({ aum: 5, onChain: onChain("500000") })).to.equal(true);
    expect(isSmallOrInactiveReserve({ aum: 0.4, onChain: onChain("20000000") })).to.equal(true);
    expect(isSmallOrInactiveReserve({ aum: 25, onChain: onChain("20000000") })).to.equal(false);
    expect(isSmallOrInactiveReserve({ aum: 0, onChain: onChain("20000000", "unavailable") })).to.equal(false);
    expect(isSmallOrInactiveReserve({ aum: 0, onChain: undefined })).to.equal(false);
  });

  it("Discover offers the toggle", () => {
    const src = read("src/merge/pages/Discover.tsx");
    expect(src).to.include("Show small/inactive Reserves");
    expect(src).to.include("smallOrInactive");
  });
});

describe("Metadata host rewrite (old Vercel preview hosts)", () => {
  it("treats *.vercel.app as this app only on its own metadata/picture paths", () => {
    expect(isAppServedUrl(new URL("https://ssr-mnfjzp7pd-ssr14.vercel.app/api/mainnet/reserve-metadata?id=c8fc6db1ad4a9de5"))).to.equal(true);
    expect(isAppServedUrl(new URL("https://ssr-x.vercel.app/api/mainnet/reserve-image?id=ab"))).to.equal(true);
    expect(isAppServedUrl(new URL("https://someone-else.vercel.app/meta.json"))).to.equal(false);
    expect(isAppServedUrl(new URL("https://ssr.fun/api/mainnet/reserve-metadata?id=1"))).to.equal(true);
  });

  it("rewrites the fetch onto the current origin in a browser", () => {
    const g = globalThis as unknown as { window?: unknown };
    const had = "window" in g;
    const prev = g.window;
    g.window = { location: { origin: "https://ssr.fun" } };
    try {
      expect(rewriteAppMetadataUriToCurrentOrigin("https://ssr-mnfjzp7pd-ssr14.vercel.app/api/mainnet/reserve-metadata?id=c8fc6db1ad4a9de5"))
        .to.equal("https://ssr.fun/api/mainnet/reserve-metadata?id=c8fc6db1ad4a9de5");
      expect(rewriteAppMetadataUriToCurrentOrigin("https://other.vercel.app/x.json")).to.equal("https://other.vercel.app/x.json");
    } finally {
      if (had) g.window = prev;
      else delete g.window;
    }
    expect(rewriteAppImageUrl("https://ssr-abc.vercel.app/api/mainnet/reserve-image?id=1", "https://ssr.fun")).to.equal("https://ssr.fun/api/mainnet/reserve-image?id=1");
  });
});

describe("Public pages: docs fallback, sitemap, feedback entry, volume caption", () => {
  it("docs.html has readable content before JavaScript runs", () => {
    const html = read("docs.html");
    expect(html).to.include('href="/docs/getting-started"');
    expect(html).to.include("<h1>SSR.fun Documentation</h1>");
  });

  it("serves a real XML sitemap outside the gate", () => {
    const xml = read("public/sitemap.xml");
    expect(xml.startsWith("<?xml")).to.equal(true);
    expect(xml).to.include("<urlset");
    expect(read("middleware.ts")).to.include("'/sitemap.xml'");
    expect(read("public/robots.txt")).to.include("Sitemap: https://ssr.fun/sitemap.xml");
  });

  it("the header and footer link to the in-app feedback page", () => {
    const shell = read("src/components/Shell.tsx");
    expect(shell).to.include("feedbackHref(");
    expect(shell).to.include(">Feedback</Link>");
  });

  it("the homepage All-Time Volume says it includes closed Reserves", () => {
    expect(read("src/pages/Home.tsx")).to.include("Includes Reserves that have since closed");
  });
});
