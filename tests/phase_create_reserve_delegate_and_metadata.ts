// Regression coverage for two bugs reported together on a real, freshly
// created Reserve ("Unnamed Reserve (#57)" / "RSV57", delegate added at
// creation time never appearing): (1) CreateDTR.tsx's "Additional Managers"
// list was collected in local UI state and displayed in the Review step
// implying it would be applied, but was NEVER submitted on-chain --
// `createReserveOnChain` had no parameter for it at all, so create_reserve
// silently ignored it entirely; a delegate added AFTER creation via
// ManageDTR.tsx worked correctly, which is what made this specifically a
// creation-time gap, not a general delegate-discovery bug (already fixed
// separately, see DEC-0096). (2) A newly created Reserve's name/ticker
// fell back to the honest-but-wrong "Unnamed Reserve (#N)" placeholder,
// because `parseReserveMetadataUri` -- written for the ORIGINAL inline
// `data:application/json,...` metadataUri convention -- doesn't know how
// to resolve the permanent-HTTPS-URL convention that superseded it (see
// DEC-0097's MetadataUriTooLong fix): every Reserve created after that fix
// has a metadataUri like `https://.../api/devnet/reserve-metadata?id=...`,
// which parseReserveMetadataUri correctly (but now overly narrowly)
// returns null for.
//
// Deliberately network-free: fetch is stubbed for the metadata-resolution
// tests, mirroring tests/phase_discovery_reliability.ts's precedent.
//
// Run in isolation:
//   npx ts-mocha -p ./tests/tsconfig.json -t 30000 tests/phase_create_reserve_delegate_and_metadata.ts
import { expect } from "chai";
import { PublicKey } from "@solana/web3.js";
import { resolveReserveMetadata, parseReserveMetadataUri, type DiscoveredReserve } from "../packages/sdk/src/discovery";
import { validateAdditionalManagers, ADDITIONAL_MANAGER_PERMISSIONS } from "../src/merge/lib/createReserveClient";
import { PERMISSION_FLAGS } from "../src/merge/lib/onChainPermissions";
import { buildDtrFromDiscoveredReserve } from "../src/merge/lib/onChainReserve";

const MANAGER = "Ef7vbQghn7Fc4LzUnyJsvov1f5f9aRSfWksiaSmWpquj";
const OTHER_1 = "Djn4aGJ3JTgqGpGdQFkmq73gG8KvkwRswP7pNaouuw4k";
const OTHER_2 = "9ERxFYyuNTMjsduY24MCp1bvUDz7PkhoycjBx76Zh8Lv";

describe("createReserveClient.ts -- validateAdditionalManagers (root-cause regression: additional managers must actually be submittable)", () => {
  it("accepts a list of valid, distinct wallets", () => {
    const result = validateAdditionalManagers([OTHER_1, OTHER_2], new PublicKey(MANAGER));
    expect(result.map((k) => k.toBase58())).to.deep.equal([OTHER_1, OTHER_2]);
  });

  it("de-duplicates repeated addresses", () => {
    const result = validateAdditionalManagers([OTHER_1, OTHER_1, OTHER_2], new PublicKey(MANAGER));
    expect(result.map((k) => k.toBase58())).to.deep.equal([OTHER_1, OTHER_2]);
  });

  it("ignores blank/whitespace-only entries", () => {
    const result = validateAdditionalManagers(["", "   ", OTHER_1], new PublicKey(MANAGER));
    expect(result.map((k) => k.toBase58())).to.deep.equal([OTHER_1]);
  });

  it("rejects an invalid Solana address with a plain-language error", () => {
    expect(() => validateAdditionalManagers(["not-a-real-address"], new PublicKey(MANAGER))).to.throw(/not a valid Solana wallet address/);
  });

  it("rejects the connected wallet's own address (already the root Manager)", () => {
    expect(() => validateAdditionalManagers([MANAGER], new PublicKey(MANAGER))).to.throw(/already the Reserve's root Manager/);
  });

  it("returns an empty array for an empty input", () => {
    expect(validateAdditionalManagers([], new PublicKey(MANAGER))).to.deep.equal([]);
  });
});

describe("createReserveClient.ts -- ADDITIONAL_MANAGER_PERMISSIONS matches CreateDTR.tsx's own promised copy exactly", () => {
  it("grants exactly rebalance + manage fees + pause/unpause -- nothing else", () => {
    expect(ADDITIONAL_MANAGER_PERMISSIONS).to.equal(
      PERMISSION_FLAGS.UPDATE_TARGETS | PERMISSION_FLAGS.INITIATE_REBALANCE | PERMISSION_FLAGS.EXECUTE_REBALANCE | PERMISSION_FLAGS.MANAGE_FEES | PERMISSION_FLAGS.PAUSE_RESERVE | PERMISSION_FLAGS.UNPAUSE_RESERVE,
    );
  });

  it("does NOT include delegate-management permissions -- copy explicitly promises 'won't be able to manage other delegates'", () => {
    expect(ADDITIONAL_MANAGER_PERMISSIONS & PERMISSION_FLAGS.ADD_RESTRICTED_DELEGATE).to.equal(0);
    expect(ADDITIONAL_MANAGER_PERMISSIONS & PERMISSION_FLAGS.REMOVE_RESTRICTED_DELEGATE).to.equal(0);
  });

  it("does NOT include metadata or liquidity-config management -- not promised by the copy", () => {
    expect(ADDITIONAL_MANAGER_PERMISSIONS & PERMISSION_FLAGS.UPDATE_METADATA).to.equal(0);
    expect(ADDITIONAL_MANAGER_PERMISSIONS & PERMISSION_FLAGS.MANAGE_LIQUIDITY_CONFIG).to.equal(0);
  });
});

describe("discovery.ts -- resolveReserveMetadata (root-cause regression: a newly created Reserve's real HTTPS metadataUri must resolve, not fall back to 'Unnamed Reserve')", () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("resolves the original inline data: URI synchronously, without ever calling fetch", async () => {
    global.fetch = (async () => {
      throw new Error("fetch must not be called for a data: URI");
    }) as typeof fetch;
    const uri = `data:application/json,${encodeURIComponent(JSON.stringify({ name: "Inline Reserve", ticker: "INL" }))}`;
    const parsed = await resolveReserveMetadata(uri);
    expect(parsed?.name).to.equal("Inline Reserve");
    expect(parsed?.ticker).to.equal("INL");
  });

  it("ROOT-CAUSE REGRESSION: resolves a real permanent HTTPS URL (this app's own reserve-metadata endpoint shape) by fetching it", async () => {
    const payload = { name: "Strategic Solana Reserve", ticker: "SSR1", description: "desc", category: "DeFi", buyTaxPct: 0, sellTaxPct: 0 };
    let fetchedUrl: string | undefined;
    global.fetch = (async (url: string) => {
      fetchedUrl = url;
      return { ok: true, json: async () => payload } as Response;
    }) as typeof fetch;
    const uri = "https://strategic-super-reserve.fun/api/devnet/reserve-metadata?id=e25da10f7ff3ebb1";
    const parsed = await resolveReserveMetadata(uri);
    expect(fetchedUrl).to.equal(uri);
    expect(parsed).to.deep.equal(payload);
  });

  it("returns null (never a fabricated guess, never a throw) when the fetch fails", async () => {
    global.fetch = (async () => {
      throw new Error("network error");
    }) as typeof fetch;
    const parsed = await resolveReserveMetadata("https://example.invalid/meta.json");
    expect(parsed).to.equal(null);
  });

  it("returns null when the response is not ok (e.g. 404 -- an id that was never stored)", async () => {
    global.fetch = (async () => ({ ok: false, json: async () => ({}) })) as unknown as typeof fetch;
    const parsed = await resolveReserveMetadata("https://strategic-super-reserve.fun/api/devnet/reserve-metadata?id=doesnotexist");
    expect(parsed).to.equal(null);
  });

  it("returns null for a non-http(s) scheme this app's pipeline never produces, without attempting a fetch", async () => {
    global.fetch = (async () => {
      throw new Error("fetch must not be called for a non-http(s) scheme");
    }) as typeof fetch;
    expect(await resolveReserveMetadata("ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi")).to.equal(null);
  });

  it("returns null for an empty metadataUri (a Reserve with no metadata set at all)", async () => {
    expect(await resolveReserveMetadata("")).to.equal(null);
  });

  it("still agrees with the pure, synchronous parseReserveMetadataUri for the inline case", async () => {
    const uri = `data:application/json,${encodeURIComponent(JSON.stringify({ name: "X", ticker: "X" }))}`;
    expect(await resolveReserveMetadata(uri)).to.deep.equal(parseReserveMetadataUri(uri));
  });
});

function fixtureDiscoveredReserve(overrides: Partial<DiscoveredReserve> = {}): DiscoveredReserve {
  return {
    reserveId: "57",
    reserve: "GFP9nJQyFWurTkJCEYYkBxjksUQUXLt9i3ZoUDncTy5C",
    manager: MANAGER,
    reserveTokenMint: OTHER_1,
    status: "active",
    assetCount: 1,
    resolvedAssetCount: 1,
    totalTargetWeightBps: 10_000,
    mintFeeBps: 50,
    redemptionFeeBps: 0,
    annualTvlFeeBps: 100,
    managerFeeShareBps: 5_000,
    protocolFeeShareBps: 5_000,
    feeDestination: MANAGER,
    pendingManagerFeeShares: "0",
    pendingProtocolFeeShares: "0",
    lastFeeAccrualTs: "0",
    effectiveMintFeeProtocolBps: 25,
    effectiveMintFeeManagerBps: 25,
    effectiveMintFeeTotalBps: 50,
    effectiveTvlFeeProtocolBps: 50,
    effectiveTvlFeeManagerBps: 50,
    effectiveTvlFeeTotalBps: 100,
    metadataUri: "https://strategic-super-reserve.fun/api/devnet/reserve-metadata?id=e25da10f7ff3ebb1",
    reserveTokenSupplyRaw: "1000000",
    delegateCount: 0,
    assets: [],
    ...overrides,
  };
}

describe("onChainReserve.ts -- buildDtrFromDiscoveredReserve (root-cause regression: resolved metadata must actually be used, not silently dropped)", () => {
  it("uses the resolved name/ticker/description/category when parsedMetadata is provided -- the exact 'Unnamed Reserve (#57)' bug, fixed", () => {
    const discovered = fixtureDiscoveredReserve();
    const dtr = buildDtrFromDiscoveredReserve(discovered, [], null, {
      name: "Strategic Solana Reserve",
      ticker: "SSR1",
      description: "A diversified basket.",
      category: "DeFi",
      buyTaxPct: 0,
      sellTaxPct: 0,
    });
    expect(dtr.name).to.equal("Strategic Solana Reserve");
    expect(dtr.ticker).to.equal("SSR1");
    expect(dtr.name).to.not.match(/Unnamed Reserve/);
  });

  it("still falls back to the honest 'Unnamed Reserve (#N)' placeholder when parsedMetadata is null (genuinely unresolvable, e.g. host down) -- never fabricates a name", () => {
    // A reserve address distinct from either committed Gate-9 fixture --
    // this test is specifically about a Reserve with NO known name source
    // at all, not the separate KNOWN_FIXTURE_META fallback path.
    const discovered = fixtureDiscoveredReserve({ reserveId: "57", reserve: OTHER_2 });
    const dtr = buildDtrFromDiscoveredReserve(discovered, [], null, null);
    expect(dtr.name).to.equal("Unnamed Reserve (#57)");
    expect(dtr.ticker).to.equal("RSV57");
  });
});

// --- 2026-08-20 pass: composition labeled "AssetN" for a real Mainnet asset (e.g. SSR) ---
// Live-reported bug: a Mainnet Reserve composed 100% of SSR (the app's own
// token, mint BpdHpqznEgYPXZNrJVRZvBhdWoafYLVVuLxTQo34pump) showed its
// composition entry generically labeled "Asset" instead of "SSR". Root
// cause: buildDtrFromDiscoveredReserve's symbol-resolution chain only knew
// about DevNet fixture mints, wrapped SOL, devUSDC, and the hardcoded
// Mainnet USDC constant -- any other real Mainnet mint (any Jupiter-
// catalogued token, including SSR itself) fell straight through to a
// generic `Asset${i+1}` placeholder, regardless of cluster. Fixed by
// threading the Jupiter asset catalogue's mint->symbol map (see
// RealReserveSync.tsx's new mainnetMintMeta) through as an additional,
// best-effort resolution source before that placeholder.
describe("onChainReserve.ts -- buildDtrFromDiscoveredReserve mintMeta (root-cause regression: a real Mainnet asset's composition entry must show its real symbol, not a generic placeholder)", () => {
  const SSR_MINT = "BpdHpqznEgYPXZNrJVRZvBhdWoafYLVVuLxTQo34pump";

  it("resolves a real Mainnet asset's symbol from the passed-in mintMeta map (e.g. a 100%-SSR Reserve shows 'SSR', not 'Asset1')", () => {
    const discovered = fixtureDiscoveredReserve({
      assetCount: 1,
      resolvedAssetCount: 1,
      assets: [{ assetMint: SSR_MINT, reserveAsset: "irrelevant", vault: "irrelevant", decimals: 6, targetWeightBps: 10_000, enabled: true, orderIndex: 0, vaultBalanceRaw: "191598743106" }],
    });
    const dtr = buildDtrFromDiscoveredReserve(discovered, [], null, null, undefined, "mainnet-beta", { [SSR_MINT]: { symbol: "SSR", name: "SSR" } });
    expect(dtr.composition).to.have.length(1);
    expect(dtr.composition[0].symbol).to.equal("SSR");
    expect(dtr.composition[0].symbol).to.not.equal("Asset1");
  });

  it("falls back to the honest 'AssetN' placeholder when the mint genuinely isn't in mintMeta yet (e.g. the catalogue hasn't loaded/indexed it) -- never fabricates a symbol", () => {
    const discovered = fixtureDiscoveredReserve({
      assetCount: 1,
      resolvedAssetCount: 1,
      assets: [{ assetMint: SSR_MINT, reserveAsset: "irrelevant", vault: "irrelevant", decimals: 6, targetWeightBps: 10_000, enabled: true, orderIndex: 0, vaultBalanceRaw: "191598743106" }],
    });
    const dtr = buildDtrFromDiscoveredReserve(discovered, [], null, null, undefined, "mainnet-beta", {});
    expect(dtr.composition[0].symbol).to.equal("Asset1");
  });

  it("mintMeta defaults to {} when omitted entirely -- every pre-existing caller/test (DevNet, no 7th argument) behaves exactly as before", () => {
    const discovered = fixtureDiscoveredReserve({
      assetCount: 1,
      resolvedAssetCount: 1,
      assets: [{ assetMint: SSR_MINT, reserveAsset: "irrelevant", vault: "irrelevant", decimals: 6, targetWeightBps: 10_000, enabled: true, orderIndex: 0, vaultBalanceRaw: "191598743106" }],
    });
    const dtr = buildDtrFromDiscoveredReserve(discovered, [], null, null);
    expect(dtr.composition[0].symbol).to.equal("Asset1");
  });

  it("a Mainnet USDC leg still resolves to 'USDC' via the pre-existing hardcoded constant, taking priority over mintMeta (never regresses the existing, already-correct path)", () => {
    const usdc = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
    const discovered = fixtureDiscoveredReserve({
      assetCount: 1,
      resolvedAssetCount: 1,
      assets: [{ assetMint: usdc, reserveAsset: "irrelevant", vault: "irrelevant", decimals: 6, targetWeightBps: 10_000, enabled: true, orderIndex: 0, vaultBalanceRaw: "10000000" }],
    });
    const dtr = buildDtrFromDiscoveredReserve(discovered, [], null, null, undefined, "mainnet-beta", { [usdc]: { symbol: "WRONG", name: "WRONG" } });
    expect(dtr.composition[0].symbol).to.equal("USDC");
  });

  it("a Reserve's tags carry the REAL cluster it was discovered on (clusterOverride), not a hardcoded 'devnet' regardless of cluster -- the same bug class, a second confirmed instance", () => {
    const discovered = fixtureDiscoveredReserve();
    const dtrMainnet = buildDtrFromDiscoveredReserve(discovered, [], null, null, undefined, "mainnet-beta");
    const dtrDevnet = buildDtrFromDiscoveredReserve(discovered, [], null, null, undefined, "devnet");
    expect(dtrMainnet.tags).to.include("mainnet-beta");
    expect(dtrMainnet.tags).to.not.include("devnet");
    expect(dtrDevnet.tags).to.include("devnet");
  });

  it("an unparsed Reserve's fallback category is also cluster-aware ('Mainnet' vs 'DevNet'), not hardcoded to 'DevNet' regardless of cluster", () => {
    const discovered = fixtureDiscoveredReserve({ reserveId: "58", reserve: OTHER_2 });
    const dtrMainnet = buildDtrFromDiscoveredReserve(discovered, [], null, null, undefined, "mainnet-beta");
    expect(dtrMainnet.category).to.equal("Mainnet");
    const discoveredDevnet = fixtureDiscoveredReserve({ reserveId: "59", reserve: OTHER_1 });
    const dtrDevnet = buildDtrFromDiscoveredReserve(discoveredDevnet, [], null, null, undefined, "devnet");
    expect(dtrDevnet.category).to.equal("DevNet");
  });
});
