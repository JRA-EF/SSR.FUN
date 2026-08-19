// Maps real SSR Protocol on-chain state (packages/sdk's fetchReserveOnChain)
// into the existing DTR shape so Discover/DTRDetail/Portfolio render it
// through the exact same components as the fully-simulated seed DTRs.
//
// PRICING NOTE (see docs/protocol/FRONTEND_INTEGRATION.md "DevNet test
// pricing"): the deployed protocol has no oracle and no bonding-curve price
// discovery -- it only tracks raw per-asset backing. The USD-ish
// "tokenPrice"/"nav"/"aum" fields this UI expects are computed here using a
// fixed, clearly-DevNet-only test price per fixture mint (declared in
// TEST_ASSET_PRICES_USD below). This is NOT real market data and must never
// be presented as such -- it exists purely so the existing dollar-denominated
// UI (built for the old AMM simulation) has something coherent to render for
// a real, oracle-free Reserve.
import { PublicKey } from "@solana/web3.js";
// Deliberately NOT importing from "./solana-config" here: that module reads
// import.meta.env (Vite-only syntax), and this file is required directly by
// several tests/phase_*.ts files via ts-mocha's CommonJS loader -- pulling
// import.meta syntax in transitively crashes test loading entirely (confirmed
// live: TS1343 on every reachable test file). programId/cluster/the Mainnet
// USDC mint are accepted as optional parameters instead (see
// buildDtrFromDiscoveredReserve below), defaulting to the pre-existing
// DevNet-fixture values so every caller that doesn't pass them keeps
// behaving exactly as before; RealReserveSync.tsx (browser-only, safe to
// import solana-config.ts directly) passes the real cluster-aware values.
import type { DTR, OnChainAssetMeta, OnChainDelegateMeta, OnChainReserveMeta, QuarantinedReserveInfo } from "./types";
import type { DiscoveredDelegate, DiscoveredReserve, ReserveOnChain, ParsedReserveMetadata } from "@ssr/sdk";
import {
  DEVNET_FIXTURES,
  SOL_TEST_PRICE_USD,
  WRAPPED_SOL_MINT,
  DEVUSDC,
  MAINNET_USDC_MINT,
  findMintAuthority,
  findVaultAuthority,
  evaluateReserveEligibility,
  type FixtureReserve,
} from "@ssr/sdk";

/** DevNet-only, fixed test prices for every mint the app's real-deployment path can actually use (see CreateDTR.tsx's DEVNET_REAL_ASSETS). Arbitrary and documented -- never real market data. An asset mint NOT in this map prices as $0 here (honest -- never a fabricated guess), which only affects the simulated USD/NAV display, never any on-chain amount. */
export const TEST_ASSET_PRICES_USD: Record<string, number> = {
  [DEVNET_FIXTURES.mints.mintX.address]: 1,
  [DEVNET_FIXTURES.mints.mintY.address]: 1,
  [DEVNET_FIXTURES.mints.mintZ.address]: 1,
  [WRAPPED_SOL_MINT.toBase58()]: SOL_TEST_PRICE_USD,
  [DEVUSDC.mint]: 1, // devUSDC is pegged to $1 by design (Phase C)
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v": 1, // real Circle USDC on Mainnet -- genuinely $1-pegged, not a test fabrication
};

const RESERVE_TOKEN_DECIMALS = 6;

export interface RealReserveDescriptor {
  id: string;
  name: string;
  ticker: string;
  description: string;
  category: string;
  fixture: FixtureReserve;
}

/** The 2 persistent Gate-9 fixtures, described for display purposes (real addresses come from DEVNET_FIXTURES). */
export const REAL_RESERVE_DESCRIPTORS: RealReserveDescriptor[] = [
  {
    id: "devnet-reserve-one",
    name: "DevNet Reserve One",
    ticker: "DNR1",
    description:
      "A real, live 2-asset Reserve deployed on Solana DevNet (Gate 9 fixture). Backed by two test SPL token mints created for this testing phase -- not real assets, not real value.",
    category: "DevNet Fixture",
    fixture: DEVNET_FIXTURES.reserveOne,
  },
  {
    id: "devnet-reserve-two",
    name: "DevNet Reserve Two",
    ticker: "DNR2",
    description:
      "A real, live 3-asset Reserve deployed on Solana DevNet (Gate 9 fixture). Backed by three test SPL token mints created for this testing phase -- not real assets, not real value.",
    category: "DevNet Fixture",
    fixture: DEVNET_FIXTURES.reserveTwo,
  },
];

function toOnChainAssetMeta(fixtureAssets: FixtureReserve["assets"], onChain: ReserveOnChain | null): OnChainAssetMeta[] {
  const known = fixtureAssets.map((fa) => {
    const live = onChain?.assets.find((a) => a.assetMint === fa.mint);
    return {
      mint: fa.mint,
      symbol: fa.symbol,
      decimals: fa.decimals,
      weightBps: live?.targetWeightBps ?? fa.weightBps,
      reserveAsset: fa.reserveAsset,
      vault: fa.vault,
      orderIndex: live?.orderIndex ?? -1,
    };
  });
  // Assets discovered live on-chain but not in the fixture/candidate-mint
  // hint list (e.g. one just added via add_reserve_asset_active) -- surface
  // them too rather than silently dropping them, matching this file's
  // "assetsResolvedFully" honesty policy elsewhere.
  const extra = (onChain?.assets ?? [])
    .filter((a) => !known.some((k) => k.mint === a.assetMint))
    .map((a) => ({
      mint: a.assetMint,
      symbol: a.assetMint.slice(0, 4),
      decimals: a.decimals,
      weightBps: a.targetWeightBps,
      reserveAsset: a.reserveAsset,
      vault: a.vault,
      orderIndex: a.orderIndex,
    }));
  return [...known, ...extra];
}

/** Builds a placeholder DTR (zeroed dynamic fields) before the first live fetch resolves. */
export function buildPlaceholderRealDTR(descriptor: RealReserveDescriptor): DTR {
  const { fixture } = descriptor;
  const onChain: OnChainReserveMeta = {
    programId: DEVNET_FIXTURES.programId,
    reserveId: fixture.reserveId,
    reserve: fixture.reserve,
    reserveTokenMint: fixture.reserveTokenMint,
    mintAuthority: fixture.mintAuthority,
    vaultAuthority: fixture.vaultAuthority,
    manager: DEVNET_FIXTURES.manager,
    assets: toOnChainAssetMeta(fixture.assets, null),
    status: "active",
    totalTargetWeightBps: fixture.assets.reduce((s, a) => s + a.weightBps, 0),
    reserveTokenSupplyRaw: "0",
    vaultBalancesRaw: {},
  };

  return {
    id: descriptor.id,
    name: descriptor.name,
    ticker: descriptor.ticker,
    description: descriptor.description,
    category: descriptor.category,
    tags: ["devnet", "real"],
    logoSeed: descriptor.id,
    dtrAddress: fixture.reserve,
    managerAddress: DEVNET_FIXTURES.manager,
    delegates: [],
    feeConfig: {
      mintFeePct: 0.5,
      tvlFeePct: 1,
      managerBuyTaxPct: 0,
      managerSellTaxPct: 0,
      creatorFeeDestination: DEVNET_FIXTURES.manager,
      feeRecipients: [],
    },
    // Placeholder-safe non-zero NAV (avoids a 0/0 NaN flash in the
    // premium/discount calculation before the first live fetch resolves,
    // typically within a few hundred ms of mount -- see RealReserveSync).
    tokenPrice: 1,
    nav: 1,
    aum: 0,
    liquidityUsdc: 0,
    change24h: 0,
    change7d: 0,
    holders: 0,
    composition: onChain.assets.map((a) => ({ symbol: a.symbol, name: a.symbol, weight: a.weightBps / 10_000 })),
    unallocatedPct: Math.max(0, 1 - onChain.totalTargetWeightBps / 10_000),
    isUserCreated: false,
    priceHistory: [{ t: Date.now(), price: 0 }],
    trades: [],
    onChain,
  };
}

/** Merges live on-chain reads into a DTR built by buildPlaceholderRealDTR (or a previous call to this function). */
export function mergeOnChainIntoDTR(prev: DTR, fixture: FixtureReserve, onChain: ReserveOnChain): DTR {
  const assets = toOnChainAssetMeta(fixture.assets, onChain);
  const vaultBalancesRaw: Record<string, string> = {};
  let aumUsd = 0;
  for (const a of onChain.assets) {
    vaultBalancesRaw[a.assetMint] = a.vaultBalanceRaw;
    const price = TEST_ASSET_PRICES_USD[a.assetMint] ?? 0;
    aumUsd += (Number(a.vaultBalanceRaw) / 10 ** a.decimals) * price;
  }
  const supply = Number(onChain.reserveTokenSupplyRaw) / 10 ** RESERVE_TOKEN_DECIMALS;
  // A not-yet-seeded Reserve has zero supply; fall back to 1 rather than 0 to
  // avoid a 0/0 NaN in the premium/discount display (Discover.tsx, DTRDetail.tsx).
  const nav = supply > 0 ? aumUsd / supply : 1;

  const onChainMeta: OnChainReserveMeta = {
    programId: DEVNET_FIXTURES.programId,
    reserveId: onChain.reserveId,
    reserve: fixture.reserve,
    reserveTokenMint: fixture.reserveTokenMint,
    mintAuthority: fixture.mintAuthority,
    vaultAuthority: fixture.vaultAuthority,
    manager: onChain.manager,
    assets,
    status: onChain.status,
    totalTargetWeightBps: onChain.totalTargetWeightBps,
    reserveTokenSupplyRaw: onChain.reserveTokenSupplyRaw,
    vaultBalancesRaw,
    assetCount: onChain.assetCount,
    assetsResolvedFully: assets.length >= onChain.assetCount,
    redemptionFeeBps: onChain.redemptionFeeBps,
    // This function has no fresh delegate data to merge (ReserveOnChain, the
    // targeted single-Reserve fetch this call is built from, is deliberately
    // lighter than a full discovery pass) -- preserve whatever was last
    // resolved rather than clobbering it with "unknown". Every caller of
    // mergeOnChainReserve (ManageDTR.tsx/DTRDetail.tsx's refreshRealReserveNow)
    // separately re-verifies delegates right after this merge, via
    // discoverDelegatesForReserve + useAppStore's setOnChainDelegates, so
    // this is never the last word on delegatesOnChain in practice.
    delegatesOnChain: prev.onChain?.delegatesOnChain,
    delegateCountOnChain: prev.onChain?.delegateCountOnChain,
    feeDestination: onChain.feeDestination,
    managerFeeShareBps: onChain.managerFeeShareBps,
    protocolFeeShareBps: onChain.protocolFeeShareBps,
    pendingManagerFeeShares: onChain.pendingManagerFeeShares,
    pendingProtocolFeeShares: onChain.pendingProtocolFeeShares,
    mintFeeBps: onChain.mintFeeBps,
    tvlFeeBps: onChain.tvlFeeBps,
    effectiveMintFeeProtocolBps: onChain.effectiveMintFeeProtocolBps,
    effectiveMintFeeManagerBps: onChain.effectiveMintFeeManagerBps,
    effectiveMintFeeTotalBps: onChain.effectiveMintFeeTotalBps,
    effectiveTvlFeeProtocolBps: onChain.effectiveTvlFeeProtocolBps,
    effectiveTvlFeeManagerBps: onChain.effectiveTvlFeeManagerBps,
    effectiveTvlFeeTotalBps: onChain.effectiveTvlFeeTotalBps,
  };

  return {
    ...prev,
    managerAddress: onChain.manager,
    tokenPrice: nav,
    nav,
    aum: aumUsd,
    liquidityUsdc: aumUsd,
    composition: assets.map((a) => ({ symbol: a.symbol, name: a.symbol, weight: a.weightBps / 10_000 })),
    unallocatedPct: Math.max(0, 1 - onChain.totalTargetWeightBps / 10_000),
    onChain: onChainMeta,
  };
}

/** Shared by RealReserveSync.tsx's full discovery pass and ManageDTR.tsx's/DTRDetail.tsx's targeted post-refresh delegate re-check -- one conversion, never duplicated. */
export function onChainDelegateFromDiscovered(d: DiscoveredDelegate): OnChainDelegateMeta {
  return { wallet: d.wallet, delegateAccount: d.delegateAccount, permissions: d.permissions, restricted: d.restricted, addedAt: d.addedAt };
}

const KNOWN_FIXTURE_META: Record<string, { name: string; ticker: string; description: string; category: string }> = {
  [DEVNET_FIXTURES.reserveOne.reserve]: {
    name: "DevNet Reserve One",
    ticker: "DNR1",
    description:
      "A real, live 2-asset Reserve deployed on Solana DevNet (Gate 9 fixture). Backed by two test SPL token mints created for this testing phase -- not real assets, not real value.",
    category: "DevNet Fixture",
  },
  [DEVNET_FIXTURES.reserveTwo.reserve]: {
    name: "DevNet Reserve Two",
    ticker: "DNR2",
    description:
      "A real, live 3-asset Reserve deployed on Solana DevNet (Gate 9 fixture). Backed by three test SPL token mints created for this testing phase -- not real assets, not real value.",
    category: "DevNet Fixture",
  },
};

/**
 * Builds a full DTR entry directly from a canonically-discovered on-chain
 * Reserve (see packages/sdk/src/discovery.ts's discoverAllReserves) -- the
 * general-purpose path that replaces the old "only the 2 hardcoded
 * fixtures" assumption. Works identically for a committed fixture, a
 * dynamically-created Reserve like "TestLo", or any other Reserve; nothing
 * here special-cases any specific Reserve id, address, or name.
 *
 * Name/ticker/description/category are recovered from the Reserve's own
 * on-chain `metadataUri`, already resolved by the caller into `parsedMetadata`
 * (see packages/sdk/src/discovery.ts's resolveReserveMetadata, which handles
 * both the original inline data: URI convention and the permanent-URL
 * convention that superseded it -- this function stays synchronous/pure by
 * taking the already-resolved result rather than doing that I/O itself) --
 * falls back to the known committed-fixture description for the 2 fixtures
 * (seeded before either metadata convention existed), or an honest
 * "unresolved metadata" placeholder for anything else. Never fabricates a
 * plausible-looking name.
 */
export function buildDtrFromDiscoveredReserve(
  discovered: DiscoveredReserve,
  delegates: DiscoveredDelegate[],
  connectedWallet: string | null,
  parsedMetadata: ParsedReserveMetadata | null,
  // Optional, cluster-aware overrides -- default to the pre-existing DevNet
  // values so every existing caller (including tests, which never pass
  // these) behaves exactly as before. RealReserveSync.tsx passes the real
  // values it already has from solana-config.ts (browser-only, see this
  // file's header comment for why that module isn't imported here directly).
  programIdOverride: PublicKey = new PublicKey(DEVNET_FIXTURES.programId),
  clusterOverride: string = "devnet",
): DTR {
  const meta =
    parsedMetadata ??
    KNOWN_FIXTURE_META[discovered.reserve] ?? {
      name: `Unnamed Reserve (#${discovered.reserveId})`,
      ticker: `RSV${discovered.reserveId}`,
      description: "This Reserve's on-chain metadata could not be parsed -- name/ticker are placeholders, not fabricated data.",
      category: "DevNet",
    };

  const id = `${clusterOverride}-${discovered.reserveId}`;
  const programId = programIdOverride;
  const reserveAddress = new PublicKey(discovered.reserve);
  const [mintAuthority] = findMintAuthority(reserveAddress, programId);
  const [vaultAuthority] = findVaultAuthority(reserveAddress, programId);

  let aumUsd = 0;
  const vaultBalancesRaw: Record<string, string> = {};
  const assets: OnChainAssetMeta[] = discovered.assets.map((a, i) => {
    vaultBalancesRaw[a.assetMint] = a.vaultBalanceRaw;
    const price = TEST_ASSET_PRICES_USD[a.assetMint] ?? 0;
    aumUsd += (Number(a.vaultBalanceRaw) / 10 ** a.decimals) * price;
    const fixtureSymbol = Object.values(DEVNET_FIXTURES.mints).find((m) => m.address === a.assetMint)?.symbol;
    const symbol =
      fixtureSymbol ??
      (a.assetMint === WRAPPED_SOL_MINT.toBase58()
        ? "SOL"
        : a.assetMint === DEVUSDC.mint
          ? DEVUSDC.symbol
          : a.assetMint === MAINNET_USDC_MINT
            ? "USDC"
            : `Asset${i + 1}`);
    return {
      mint: a.assetMint,
      symbol,
      decimals: a.decimals,
      weightBps: a.targetWeightBps,
      reserveAsset: a.reserveAsset,
      vault: a.vault,
      orderIndex: a.orderIndex,
    };
  });
  const supply = Number(discovered.reserveTokenSupplyRaw) / 10 ** RESERVE_TOKEN_DECIMALS;
  const nav = supply > 0 ? aumUsd / supply : 1;

  const onChain: OnChainReserveMeta = {
    programId: programId.toBase58(),
    reserveId: discovered.reserveId,
    reserve: discovered.reserve,
    reserveTokenMint: discovered.reserveTokenMint,
    mintAuthority: mintAuthority.toBase58(),
    vaultAuthority: vaultAuthority.toBase58(),
    manager: discovered.manager,
    assets,
    status: discovered.status,
    totalTargetWeightBps: discovered.totalTargetWeightBps,
    reserveTokenSupplyRaw: discovered.reserveTokenSupplyRaw,
    vaultBalancesRaw,
    assetCount: discovered.assetCount,
    assetsResolvedFully: discovered.resolvedAssetCount >= discovered.assetCount,
    redemptionFeeBps: discovered.redemptionFeeBps,
    delegateCountOnChain: discovered.delegateCount,
    delegatesOnChain: delegates.map(onChainDelegateFromDiscovered),
    feeDestination: discovered.feeDestination,
    managerFeeShareBps: discovered.managerFeeShareBps,
    protocolFeeShareBps: discovered.protocolFeeShareBps,
    pendingManagerFeeShares: discovered.pendingManagerFeeShares,
    pendingProtocolFeeShares: discovered.pendingProtocolFeeShares,
    mintFeeBps: discovered.mintFeeBps,
    tvlFeeBps: discovered.annualTvlFeeBps,
    effectiveMintFeeProtocolBps: discovered.effectiveMintFeeProtocolBps,
    effectiveMintFeeManagerBps: discovered.effectiveMintFeeManagerBps,
    effectiveMintFeeTotalBps: discovered.effectiveMintFeeTotalBps,
    effectiveTvlFeeProtocolBps: discovered.effectiveTvlFeeProtocolBps,
    effectiveTvlFeeManagerBps: discovered.effectiveTvlFeeManagerBps,
    effectiveTvlFeeTotalBps: discovered.effectiveTvlFeeTotalBps,
  };

  return {
    id,
    name: meta.name,
    ticker: meta.ticker,
    description: meta.description,
    category: meta.category,
    tags: [meta.category, "devnet", "real"],
    logoSeed: id,
    dtrAddress: discovered.reserve,
    managerAddress: discovered.manager,
    // Locally-simulated delegate CRUD (see useAppStore's addDelegate/etc) is
    // NOT used for real on-chain Reserves -- see delegatesOnChain above for
    // the verified list. Left empty rather than repurposed so the two
    // concepts (simulated delegates vs. verified on-chain delegates) never
    // conflate.
    delegates: [],
    feeConfig: {
      mintFeePct: discovered.mintFeeBps / 100,
      tvlFeePct: discovered.annualTvlFeeBps / 100,
      // Forward-looking secondary-market configuration, read from the
      // Reserve's on-chain metadataUri JSON -- NOT enforced by mint/redeem
      // today (no secondary market/DEX exists yet for the Reserve Token).
      // Defaults to 0 for any Reserve created before this field existed.
      managerBuyTaxPct: parsedMetadata?.buyTaxPct ?? 0,
      managerSellTaxPct: parsedMetadata?.sellTaxPct ?? 0,
      creatorFeeDestination: discovered.feeDestination,
      feeRecipients: [],
    },
    tokenPrice: nav,
    nav,
    aum: aumUsd,
    liquidityUsdc: aumUsd,
    change24h: 0,
    change7d: 0,
    // Real holder count isn't derivable without a token-account scan (same
    // getProgramAccounts limitation as delegates/assets) -- 0 is an honest
    // "unknown", never a fabricated figure.
    holders: 0,
    composition: assets.map((a) => ({ symbol: a.symbol, name: a.symbol, weight: a.weightBps / 10_000 })),
    unallocatedPct: Math.max(0, 1 - discovered.totalTargetWeightBps / 10_000),
    isUserCreated: connectedWallet !== null && discovered.manager === connectedWallet,
    priceHistory: [{ t: Date.now(), price: nav }],
    trades: [],
    onChain,
    chainStatus: "ready",
  };
}

/**
 * Pure merge logic behind useAppStore's applyDiscoveredReserves -- extracted
 * so it's testable without instantiating the whole zustand+persist store
 * (which needs a real/shimmed localStorage). See docs/project/PROJECT_STATUS.md's
 * corrective DevNet data-integrity pass.
 *
 * Fail-closed: a completed, `fullyVerified` discovery pass enumerates the
 * program's ENTIRE current Reserve set from ProtocolConfig.reserveCount, so
 * an on-chain DTR the caller previously knew about but that's missing from
 * `discovered` has genuinely been closed (or never really existed) -- it is
 * dropped, never shown forever. Only kept when `fullyVerified` is false
 * (this pass itself had unresolved per-account issues, e.g. a transient
 * 429 on one account), since in that case the "missing" Reserve might just
 * be a transient read failure, not a real closure.
 */
export interface MergeDiscoveredReservesResult {
  dtrs: DTR[];
  /** Every fresh-discovery Reserve that failed the canonical eligibility check this pass, with why. Not accumulated across passes here -- see useAppStore's applyDiscoveredReserves for that. */
  quarantined: QuarantinedReserveInfo[];
}

/**
 * Adapts a DTR's on-chain fields into the canonical eligibility input and
 * calls packages/sdk's evaluateReserveEligibility -- the ONE place this
 * decision is made. See that function's own header for the full rule list.
 */
function checkDtrEligibility(d: DTR): { eligible: boolean; reason: string | null } {
  if (!d.onChain) return { eligible: false, reason: "Not a genuine on-chain Reserve." };
  return evaluateReserveEligibility({
    reserve: d.onChain.reserve,
    assetCount: d.onChain.assetCount,
    resolvedAssetCount: d.onChain.assets.length,
    assetMints: d.onChain.assets.map((a) => a.mint),
    status: d.onChain.status,
    reserveTokenSupplyRaw: d.onChain.reserveTokenSupplyRaw,
  });
}

export function mergeDiscoveredReserves(existingDtrs: DTR[], rawDiscovered: DTR[], fullyVerified: boolean): MergeDiscoveredReservesResult {
  const discovered: DTR[] = [];
  const quarantined: QuarantinedReserveInfo[] = [];
  for (const d of rawDiscovered) {
    const { eligible, reason } = checkDtrEligibility(d);
    if (eligible) {
      discovered.push(d);
    } else if (d.onChain) {
      quarantined.push({
        id: d.id,
        reserve: d.onChain.reserve,
        reserveId: d.onChain.reserveId,
        name: d.name,
        ticker: d.ticker,
        reason: reason ?? "This Reserve is not currently supported.",
      });
    }
    // A `d.onChain === undefined` fresh-discovery entry (shouldn't normally
    // occur -- discovery always resolves real on-chain data) is simply
    // dropped, matching the "non-onChain DTR never kept" policy below.
  }
  const byAddress = new Map(existingDtrs.filter((d) => d.onChain).map((d) => [d.onChain!.reserve, d]));
  const merged = discovered.map((fresh) => {
    const existing = fresh.onChain ? byAddress.get(fresh.onChain.reserve) : undefined;
    if (!existing) return fresh;
    return {
      ...fresh,
      priceHistory: existing.priceHistory.length > 1 ? existing.priceHistory : fresh.priceHistory,
      trades: existing.trades,
      logoUrl: existing.logoUrl ?? fresh.logoUrl,
    };
  });
  const discoveredAddresses = new Set(discovered.map((d) => d.onChain?.reserve).filter(Boolean));
  // A non-onChain DTR is never kept, at this layer or any other -- this app
  // only ever discovers and displays genuine on-chain DevNet Reserves (see
  // docs/project/PROJECT_STATUS.md's corrective data-integrity pass). Defense
  // in depth: the store's persist migration already strips these once on
  // load, but this function enforces it on every merge too, so it can never
  // regress even if a future change reintroduces a non-onChain DTR upstream.
  const untouched = existingDtrs.filter((d) => {
    if (!d.onChain) return false;
    if (discoveredAddresses.has(d.onChain.reserve)) return false;
    return !fullyVerified;
  });
  return { dtrs: [...untouched, ...merged], quarantined };
}

export type DtrPageState =
  | { kind: "found"; dtr: DTR }
  | { kind: "quarantined"; info: QuarantinedReserveInfo }
  /**
   * Not in `dtrs`/`quarantinedReserves` yet, but background discovery hasn't
   * proven it doesn't exist either -- e.g. a just-created or just-resumed
   * Reserve, opened before RealReserveSync's next poll has merged it in, or
   * a fresh page load whose very first discovery pass hasn't completed. Must
   * never be presented as the terminal "Reserve Not Found" -- see
   * `resolveDtrPageState`'s root-cause comment below.
   */
  | { kind: "indexing" }
  | { kind: "not-found" };

/**
 * Pure routing decision behind DTRDetail.tsx's direct-link handling --
 * extracted so it's unit-testable without rendering the full page component
 * (which has heavy wallet/RPC hook dependencies). A requested id resolves to
 * exactly one of: a genuine, eligible DTR to render normally; a genuinely
 * on-chain but quarantined Reserve (shows the honest "not supported"
 * message + Back to Discover, nothing else); still-indexing (background
 * discovery hasn't completed even one pass yet, so absence from `dtrs` isn't
 * meaningful); or truly nonexistent (generic "Reserve Not Found").
 *
 * Root cause this fixes: this function used to treat "not in `dtrs` yet" as
 * unconditionally "not-found," rendered immediately. That's exactly what
 * turned a background-discovery timing gap (RealReserveSync's poll hasn't
 * run yet, or a resumed deployment wasn't registered into the store -- see
 * CreateDTR.tsx's handleResumeDeployment) into a dead-end "Reserve Not
 * Found" page for a Reserve that had, in fact, already landed on-chain --
 * the reported "new Reserve initially showed 'Reserve not found,' then
 * later appeared" behavior. `chainDiscoveryStatus !== "ready"` covers the
 * common case (discovery is actively running); DTRDetail.tsx/ManageDTR.tsx
 * additionally perform one bounded direct on-chain read (see
 * `parseOnChainReserveId`) before ever rendering the terminal state, to
 * cover the rarer case where a pass already completed without this
 * particular (very recently created) Reserve yet.
 */
export function resolveDtrPageState(
  dtrId: string | undefined,
  dtrs: DTR[],
  quarantinedReserves: Record<string, QuarantinedReserveInfo>,
  chainDiscoveryStatus: "loading" | "ready" | "error",
): DtrPageState {
  const dtr = dtrs.find((d) => d.id === (dtrId ?? ""));
  if (dtr) return { kind: "found", dtr };
  const info = dtrId ? quarantinedReserves[dtrId] : undefined;
  if (info) return { kind: "quarantined", info };
  if (chainDiscoveryStatus !== "ready") return { kind: "indexing" };
  return { kind: "not-found" };
}

/**
 * Extracts the numeric on-chain `reserveId` from this app's `devnet-<id>`
 * DTR-id convention (see `buildDtrFromDiscoveredReserve`/CreateDTR.tsx,
 * which both mint ids this exact way for every genuinely on-chain Reserve).
 * Returns null for anything else (a simulated/legacy id, a malformed
 * param, or a non-numeric suffix) -- callers use this to decide whether a
 * "not found" id is even worth a direct fallback on-chain read.
 */
export function parseOnChainReserveId(dtrId: string | undefined): bigint | null {
  if (!dtrId) return null;
  const match = /^devnet-(\d+)$/.exec(dtrId);
  if (!match) return null;
  try {
    return BigInt(match[1]);
  } catch {
    return null;
  }
}
