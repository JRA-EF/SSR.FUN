// Offline, pure-logic regression coverage for this pass's Featured-Reserves
// and RPC-secret-redaction fixes -- see docs/project/DECISION_LOG.md.
import { expect } from "chai";
import type { DTR } from "../src/merge/lib/types";
import { buildReserveCardProps, selectFeaturedReserves } from "../src/merge/lib/reserveCardProps";
import { redactRpcSecrets } from "../api/devnet/_lib/rpc";

function makeDtr(overrides: Partial<DTR> & { id: string }): DTR {
  return {
    id: overrides.id,
    name: overrides.name ?? "Test Reserve",
    ticker: overrides.ticker ?? "TEST",
    description: overrides.description ?? "",
    logoUrl: undefined,
    category: overrides.category ?? "DevNet",
    tokenPrice: overrides.tokenPrice ?? 1,
    nav: overrides.nav ?? 1,
    aum: overrides.aum ?? 1000,
    change24h: overrides.change24h ?? 0,
    change7d: overrides.change7d ?? 0,
    liquidityUsdc: overrides.liquidityUsdc ?? 5000,
    composition: overrides.composition ?? [{ symbol: "MOCX", name: "mockX", weight: 1, mint: "mockxmint" } as any],
    priceHistory: overrides.priceHistory ?? [],
    trades: overrides.trades ?? [],
    holders: overrides.holders ?? 1,
    managerAddress: overrides.managerAddress ?? "manager",
    delegates: overrides.delegates ?? [],
    feeConfig: overrides.feeConfig ?? ({} as any),
    onChain: overrides.onChain,
  } as unknown as DTR;
}

const TRADABLE_MINTS = ["Djn4aGJ3JTgqGpGdQFkmq73gG8KvkwRswP7pNaouuw4k", "2KBajm7Xufj8UaFQbKqLquhMRqeqjLZdDuXtoqYkSUgu"];
const UNSUPPORTED_MINT = "So11111111111111111111111111111111111111112"; // wrapped SOL -- never in SUPPORTED_ASSET_MINTS

function onChainMeta(overrides: { assetsResolvedFully: boolean; mints: string[] }) {
  return {
    programId: "prog", reserveId: "1", reserve: "res", reserveTokenMint: "mint", mintAuthority: "ma", vaultAuthority: "va",
    manager: "manager", status: "active", assets: overrides.mints.map((m) => ({ mint: m, symbol: "X", decimals: 6, weightBps: 10000, reserveAsset: "ra", vault: "v", vaultBalanceRaw: "0" })),
    totalTargetWeightBps: 10000, reserveTokenSupplyRaw: "1000", vaultBalancesRaw: {}, assetsResolvedFully: overrides.assetsResolvedFully,
  } as any;
}

describe("selectFeaturedReserves -- excludes unresolved/unsupported/unnamed Reserves", () => {
  it("keeps a fully-resolved, tradable, named on-chain Reserve", () => {
    const dtr = makeDtr({ id: "a", name: "Real Reserve", aum: 500, onChain: onChainMeta({ assetsResolvedFully: true, mints: TRADABLE_MINTS }) });
    expect(selectFeaturedReserves([dtr])).to.deep.equal([dtr]);
  });

  it("excludes a purely local/simulated Reserve (no onChain data at all)", () => {
    const dtr = makeDtr({ id: "a", aum: 999999 });
    expect(selectFeaturedReserves([dtr])).to.deep.equal([]);
  });

  it("excludes an under-resolved Reserve (assetsResolvedFully: false), even if its AUM is large", () => {
    const dtr = makeDtr({ id: "a", aum: 999999, onChain: onChainMeta({ assetsResolvedFully: false, mints: TRADABLE_MINTS }) });
    expect(selectFeaturedReserves([dtr])).to.deep.equal([]);
  });

  it("excludes a fully-resolved Reserve holding an unsupported asset (e.g. wrapped SOL)", () => {
    const dtr = makeDtr({ id: "a", onChain: onChainMeta({ assetsResolvedFully: true, mints: [UNSUPPORTED_MINT] }) });
    expect(selectFeaturedReserves([dtr])).to.deep.equal([]);
  });

  it("excludes a Reserve with the 'Unnamed Reserve (#N)' placeholder name", () => {
    const dtr = makeDtr({ id: "a", name: "Unnamed Reserve (#7)", onChain: onChainMeta({ assetsResolvedFully: true, mints: TRADABLE_MINTS }) });
    expect(selectFeaturedReserves([dtr])).to.deep.equal([]);
  });

  it("sorts the remaining eligible Reserves by AUM, descending", () => {
    const low = makeDtr({ id: "low", aum: 100, onChain: onChainMeta({ assetsResolvedFully: true, mints: TRADABLE_MINTS }) });
    const high = makeDtr({ id: "high", aum: 900, onChain: onChainMeta({ assetsResolvedFully: true, mints: TRADABLE_MINTS }) });
    expect(selectFeaturedReserves([low, high]).map((d) => d.id)).to.deep.equal(["high", "low"]);
  });
});

describe("buildReserveCardProps -- sparkline always uses the centralized fallback, never NaN metrics", () => {
  it("produces a non-empty sparkline (fallback flatline) for a Reserve with no real price history but a valid NAV", () => {
    const dtr = makeDtr({ id: "a", nav: 1.5, tokenPrice: 1.5, priceHistory: [] });
    const props = buildReserveCardProps(dtr);
    expect(props.sparkline.length).to.be.greaterThan(2);
    expect(props.sparkline.every((v) => v === 1.5)).to.equal(true);
    expect(props.sparklineIsFallback).to.equal(true);
  });

  it("produces an empty sparkline (never a fabricated $0 line) when NAV is genuinely unavailable and there's no real history", () => {
    const dtr = makeDtr({ id: "a", nav: 0, priceHistory: [] });
    const props = buildReserveCardProps(dtr);
    expect(props.sparkline).to.deep.equal([]);
  });

  it("uses genuine recorded history when it exists, not a fallback", () => {
    const now = Date.now();
    const dtr = makeDtr({
      id: "a",
      nav: 1.1,
      priceHistory: [
        { t: now - 6 * 24 * 60 * 60 * 1000, price: 1.0 },
        { t: now - 3 * 24 * 60 * 60 * 1000, price: 1.05 },
        { t: now - 1 * 60 * 60 * 1000, price: 1.1 },
      ],
    });
    const props = buildReserveCardProps(dtr);
    expect(props.sparklineIsFallback).to.equal(false);
    expect(props.sparkline).to.include(1.0);
    expect(props.sparkline).to.include(1.05);
  });

  it("never renders NaN%/$NaN for Market Cap or Prem/Discount when NAV is 0 -- shows an honest placeholder instead", () => {
    // Mainnet-pricing-layer pass: the card's "NAV" chip was replaced by
    // "Market Cap" (supply x Token Price, computed independently -- see
    // reserveCardProps.ts/onChainReserve.ts's computeMarketCap). This DTR
    // has no onChain data (a simulated/non-Mainnet fixture, matching every
    // other DTR in this test file), so supply is honestly 0 -- Market Cap is
    // genuinely $0, not NaN and not a fabricated "unavailable," which is
    // exactly what's being asserted here. Prem/Discount keeps its original
    // "—" placeholder (nav === 0 makes the premium/discount ratio undefined).
    const dtr = makeDtr({ id: "a", nav: 0, tokenPrice: 5 });
    const props = buildReserveCardProps(dtr);
    const mcapMetric = props.metrics.find((m) => m.key === "mcap")!;
    const premMetric = props.metrics.find((m) => m.key === "prem")!;
    expect(mcapMetric.value).to.not.match(/NaN/);
    expect(premMetric.value).to.not.match(/NaN/);
    expect(mcapMetric.value).to.equal("$0");
    expect(premMetric.value).to.equal("—");
  });
});

// --- 2026-08-20 pass: Discover/Featured cards said "Live on Solana DevNet" for a genuinely Mainnet-deployed Reserve ---
// Live-reported bug -- sourceBadge was hardcoded to the DevNet label
// unconditionally. `isMainnet` is a plain parameter (default false) rather
// than importing IS_MAINNET from ./solana-config directly, since this file
// is required by ts-mocha tests and that module's import.meta.env syntax
// isn't loadable there (see reserveCardProps.ts's own header comment).
describe("buildReserveCardProps -- cluster-aware source badge (root-cause regression: must never say DevNet for a Mainnet Reserve)", () => {
  it("defaults to the DevNet label when isMainnet is omitted -- every pre-existing caller/test unchanged", () => {
    const dtr = makeDtr({ id: "a", onChain: onChainMeta({ assetsResolvedFully: true, mints: TRADABLE_MINTS }) });
    const props = buildReserveCardProps(dtr);
    expect(props.sourceBadge).to.deep.equal({ label: "Live on Solana DevNet", tone: "onchain" });
  });

  it("shows the Mainnet label when isMainnet is true, for the exact same on-chain Reserve", () => {
    const dtr = makeDtr({ id: "a", onChain: onChainMeta({ assetsResolvedFully: true, mints: TRADABLE_MINTS }) });
    const props = buildReserveCardProps(dtr, true);
    expect(props.sourceBadge).to.deep.equal({ label: "Live on Solana Mainnet", tone: "onchain" });
  });

  it("a purely simulated (no onChain) Reserve never shows a cluster label at all, regardless of isMainnet", () => {
    const dtr = makeDtr({ id: "a", onChain: undefined });
    expect(buildReserveCardProps(dtr, true).sourceBadge).to.deep.equal({ label: "Simulated Demo", tone: "simulated" });
    expect(buildReserveCardProps(dtr, false).sourceBadge).to.deep.equal({ label: "Simulated Demo", tone: "simulated" });
  });
});

describe("redactRpcSecrets (api/devnet/_lib/rpc.ts) -- never leaks the configured RPC URL/API key", () => {
  const originalHelius = process.env.HELIUS_RPC_URL;
  afterEach(() => {
    if (originalHelius === undefined) delete process.env.HELIUS_RPC_URL;
    else process.env.HELIUS_RPC_URL = originalHelius;
  });

  it("strips the exact configured HELIUS_RPC_URL out of an error message", () => {
    process.env.HELIUS_RPC_URL = "https://devnet.helius-rpc.com/?api-key=super-secret-123";
    const msg = `fetch failed: https://devnet.helius-rpc.com/?api-key=super-secret-123 timed out`;
    const redacted = redactRpcSecrets(msg);
    expect(redacted).to.not.include("super-secret-123");
    expect(redacted).to.include("[redacted-rpc-url]");
  });

  it("also redacts an api-key-bearing URL even if it doesn't exactly match the configured env value (defense in depth)", () => {
    delete process.env.HELIUS_RPC_URL;
    const msg = "TypeError: fetch failed, cause: url: 'https://some-other-provider.example/rpc?api-key=abcdef123456'";
    const redacted = redactRpcSecrets(msg);
    expect(redacted).to.not.include("abcdef123456");
  });

  it("leaves an ordinary error message with no URL/secret untouched", () => {
    const msg = "unexpected signer: Ef7vbQghn7Fc4LzUnyJsvov1f5f9aRSfWksiaSmWpquj";
    expect(redactRpcSecrets(msg)).to.equal(msg);
  });
});
