// The single shared definition of "which Reserves are tradable on SSR.fun
// DevNet" -- used identically by discovery/merge (so an ineligible Reserve
// never enters the app's Reserve catalogue at all), api/devnet/landing-stats.ts
// (server-side holder/volume aggregation), api/devnet/swap-sign.ts (Buy/Sell
// gating), and src/merge/pages/CreateDTR.tsx (asset picker) -- never
// re-implemented separately in any of them, so none of them can silently
// disagree about which Reserves are real, buyable/sellable products versus
// which are excluded.
//
// A Reserve is tradable only when EVERY one of its registered assets is one
// of the four configured DevNet test mints below (devUSDC, mockX, mockY,
// mockZ) -- validated by canonical mint ADDRESS, never by ticker/symbol
// (two different Reserves/mints can share a symbol on this DevNet
// deployment; only the address is canonical identity). Wrapped SOL is
// deliberately NOT in this set: it has no genuine devUSDC-settled
// mint/redeem path (see zapInstructions.ts), so a Reserve holding it is not
// tradable through this app's Buy/Sell UI even though the underlying
// protocol instruction would technically accept it.
import { DEVNET_FIXTURES } from "./fixtures";
import { DEVUSDC } from "./devUsdc";

/**
 * Real Circle USDC on Solana Mainnet -- the sole supported Mainnet Reserve
 * Asset for this launch (see docs/project/DECISION_LOG.md's Mainnet-launch
 * entries: USDC-only, direct in-kind Buy/Sell via
 * packages/sdk/src/directInstructions.ts, no swap/zap). Included here
 * unconditionally rather than behind a cluster check: this address can
 * never appear in a genuine DevNet Reserve's asset list (DevNet Reserves
 * only ever use devUSDC/mockX/Y/Z below), so adding it doesn't change any
 * existing DevNet behavior.
 */
export const MAINNET_USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

/** Canonical DevNet test-asset mint addresses this app can genuinely Buy/Sell against, plus real Mainnet USDC (see MAINNET_USDC_MINT above). */
export const SUPPORTED_ASSET_MINTS: ReadonlySet<string> = new Set([
  DEVUSDC.mint,
  DEVNET_FIXTURES.mints.mintX.address,
  DEVNET_FIXTURES.mints.mintY.address,
  DEVNET_FIXTURES.mints.mintZ.address,
  MAINNET_USDC_MINT,
]);

export function isSupportedAssetMint(mint: string): boolean {
  return SUPPORTED_ASSET_MINTS.has(mint);
}

/**
 * A Reserve is tradable (eligible to appear anywhere on the site: Discover,
 * search, landing-page KPIs/Featured, Portfolio, Manage, direct /dtr/:id
 * routes, holder/volume calculations) only when it has at least one
 * registered asset and every one of them is a supported mint. An empty
 * asset list is never tradable -- that's an unresolved/incomplete Reserve
 * shape (e.g. still AssetsInitializing), not a supported one.
 */
export function isReserveTradable(assetMints: string[]): boolean {
  return assetMints.length > 0 && assetMints.every((m) => SUPPORTED_ASSET_MINTS.has(m));
}
