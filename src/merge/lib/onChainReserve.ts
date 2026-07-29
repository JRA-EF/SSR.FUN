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
import type { DTR, OnChainAssetMeta, OnChainDelegateMeta, OnChainReserveMeta } from "./types";
import type { DiscoveredDelegate, DiscoveredReserve, ReserveOnChain } from "@ssr/sdk";
import {
  DEVNET_FIXTURES,
  SOL_TEST_PRICE_USD,
  WRAPPED_SOL_MINT,
  DEVUSDC,
  parseReserveMetadataUri,
  findMintAuthority,
  findVaultAuthority,
  type FixtureReserve,
} from "@ssr/sdk";

/** DevNet-only, fixed test prices for every mint the app's real-deployment path can actually use (see CreateDTR.tsx's DEVNET_REAL_ASSETS). Arbitrary and documented -- never real market data. An asset mint NOT in this map prices as $0 here (honest -- never a fabricated guess), which only affects the simulated USD/NAV display, never any on-chain amount. */
export const TEST_ASSET_PRICES_USD: Record<string, number> = {
  [DEVNET_FIXTURES.mints.mintX.address]: 1,
  [DEVNET_FIXTURES.mints.mintY.address]: 1,
  [DEVNET_FIXTURES.mints.mintZ.address]: 1,
  [WRAPPED_SOL_MINT.toBase58()]: SOL_TEST_PRICE_USD,
  [DEVUSDC.mint]: 1, // devUSDC is pegged to $1 by design (Phase C)
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
    // Delegate discovery runs on a separate cadence (see ManageDTR.tsx) --
    // preserve whatever was last resolved rather than clobbering it with
    // "unknown" on every routine balance/composition poll.
    delegatesOnChain: prev.onChain?.delegatesOnChain,
    delegateCountOnChain: prev.onChain?.delegateCountOnChain,
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

function onChainDelegateFromDiscovered(d: DiscoveredDelegate): OnChainDelegateMeta {
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
 * on-chain `metadataUri` when possible (see parseReserveMetadataUri) --
 * falls back to the known committed-fixture description for the 2 fixtures
 * (seeded before this metadata convention existed), or an honest
 * "unresolved metadata" placeholder for anything else. Never fabricates a
 * plausible-looking name.
 */
export function buildDtrFromDiscoveredReserve(
  discovered: DiscoveredReserve,
  delegates: DiscoveredDelegate[],
  connectedWallet: string | null,
): DTR {
  const parsed = parseReserveMetadataUri(discovered.metadataUri);
  const meta =
    parsed ??
    KNOWN_FIXTURE_META[discovered.reserve] ?? {
      name: `Unnamed Decentralized Token Reserve (#${discovered.reserveId})`,
      ticker: `RSV${discovered.reserveId}`,
      description: "This Reserve's on-chain metadata could not be parsed -- name/ticker are placeholders, not fabricated data.",
      category: "DevNet",
    };

  const id = `devnet-${discovered.reserveId}`;
  const programId = new PublicKey(DEVNET_FIXTURES.programId);
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
    const symbol = fixtureSymbol ?? (a.assetMint === WRAPPED_SOL_MINT.toBase58() ? "SOL" : a.assetMint === DEVUSDC.mint ? DEVUSDC.symbol : `Asset${i + 1}`);
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
    programId: DEVNET_FIXTURES.programId,
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
      managerBuyTaxPct: 0,
      managerSellTaxPct: 0,
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
