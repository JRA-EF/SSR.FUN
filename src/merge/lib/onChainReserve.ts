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
import type { DTR, OnChainAssetMeta, OnChainReserveMeta } from "./types";
import type { ReserveOnChain } from "@ssr/sdk";
import { DEVNET_FIXTURES, type FixtureReserve } from "@ssr/sdk";

/** DevNet-only, fixed test prices for the Gate-9 fixture mints. Arbitrary and documented -- never real market data. */
export const TEST_ASSET_PRICES_USD: Record<string, number> = {
  [DEVNET_FIXTURES.mints.mintX.address]: 1,
  [DEVNET_FIXTURES.mints.mintY.address]: 1,
  [DEVNET_FIXTURES.mints.mintZ.address]: 1,
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
  return fixtureAssets.map((fa) => {
    const live = onChain?.assets.find((a) => a.assetMint === fa.mint);
    return {
      mint: fa.mint,
      symbol: fa.symbol,
      decimals: fa.decimals,
      weightBps: live?.targetWeightBps ?? fa.weightBps,
      reserveAsset: fa.reserveAsset,
      vault: fa.vault,
    };
  });
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
