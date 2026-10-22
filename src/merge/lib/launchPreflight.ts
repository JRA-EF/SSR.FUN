// DEC-0249: the Create Reserve route check, browser side.
//
// Runs when the creator leaves the basket step and again right before
// Launch. Asks two things of every selected asset, without creating or
// signing anything:
//   1. Can the program hold it at all? (Token-2022 extensions, DEC-0205 --
//      the same read createReserveOnChain refuses on.)
//   2. Can Jupiter swap the creator's USDC into it, for the amount the launch
//      will really spend, without a price impact the swap proxy refuses?
//      (api/mainnet/launch-preflight.ts.)
// Each asset comes back ok / warning / blocked / unchecked. Only "blocked"
// stops the creator, and only until that asset is removed or replaced.
import type { Connection } from "@solana/web3.js";
import { PublicKey } from "@solana/web3.js";
import { assessMintAccount, describeIncompatibleAsset } from "@ssr/sdk";

export type LaunchCheckStatus = "ok" | "warning" | "blocked" | "unchecked";

export interface LaunchCheckAsset {
  symbol: string;
  mint: string;
  /** USDC swapped into this asset at launch: seed total x its weight. */
  usdcBudgetUsd: number;
  /** False for USDC (deposited directly) and SOL (wrapped from the wallet) -- nothing to route. */
  needsSwap: boolean;
}

export interface LaunchCheckResult {
  symbol: string;
  mint: string;
  status: LaunchCheckStatus;
  /** Plain-language reason; empty for "ok". */
  reason: string;
  priceImpactPct: number | null;
  route: string[];
  /** Set when this asset's swap failed during a launch attempt (not just the check). */
  failedDuringLaunch?: boolean;
}

export interface LaunchCheck {
  /** Which basket + seed this check answered -- a different one needs a new check. */
  fingerprint: string;
  checkedAt: number;
  results: LaunchCheckResult[];
}

/** A removed asset, kept so the creator sees what went and why, and can pick a replacement. */
export interface RemovedLaunchAsset {
  symbol: string;
  name: string;
  reason: string;
}

/** A check older than this is re-run before Launch even if the basket did not change. */
export const LAUNCH_CHECK_MAX_AGE_MS = 3 * 60_000;

/** Pure: identifies a basket + seed, order-independent, to the cent. */
export function launchCheckFingerprint(assets: LaunchCheckAsset[]): string {
  return assets
    .map((a) => `${a.mint}:${Math.round(a.usdcBudgetUsd * 100)}`)
    .sort()
    .join("|");
}

/** Pure: the check is still valid for this basket right now. */
export function isLaunchCheckFresh(check: LaunchCheck | null, assets: LaunchCheckAsset[], now: number = Date.now()): check is LaunchCheck {
  return check !== null && check.fingerprint === launchCheckFingerprint(assets) && now - check.checkedAt < LAUNCH_CHECK_MAX_AGE_MS;
}

/** Pure: the assets that must be removed or replaced before the launch can go ahead. */
export function blockedAssets(check: LaunchCheck | null): LaunchCheckResult[] {
  return check ? check.results.filter((r) => r.status === "blocked") : [];
}

/** Pure: the assets the creator should know about but may continue with. */
export function warningAssets(check: LaunchCheck | null): LaunchCheckResult[] {
  return check ? check.results.filter((r) => r.status === "warning" || r.status === "unchecked") : [];
}

/**
 * Pure: records that an asset's swap failed DURING a launch attempt, so the
 * basket step shows it as must-remove even if the earlier check passed it.
 * Works with no prior check (a launch started from a restored draft).
 */
export function markLaunchFailure(check: LaunchCheck | null, asset: { symbol: string; mint: string }, message: string, fingerprint: string): LaunchCheck {
  const reason = `Its swap failed while launching: ${message} Nothing was created on-chain. Remove it, or replace it with another asset, and launch again -- assets already swapped for stay in your wallet and are used by the next attempt.`;
  const failed: LaunchCheckResult = { symbol: asset.symbol, mint: asset.mint, status: "blocked", reason, priceImpactPct: null, route: [], failedDuringLaunch: true };
  const others = (check?.results ?? []).filter((r) => r.mint !== asset.mint);
  return { fingerprint, checkedAt: Date.now(), results: [...others, failed] };
}

interface ServerResult {
  mint: string;
  status: LaunchCheckStatus;
  reason: string;
  priceImpactPct: number | null;
  route: string[];
}

/** Runs both checks. Never throws: a check that cannot run marks assets "unchecked" (never blocks on SSR's or Jupiter's own outage). */
export async function checkLaunchRoutes(params: {
  connection: Connection;
  assets: LaunchCheckAsset[];
  isMainnet: boolean;
  origin?: string;
  fetchImpl?: typeof fetch;
}): Promise<LaunchCheck> {
  const { assets } = params;
  const fingerprint = launchCheckFingerprint(assets);
  const bySymbol = new Map<string, LaunchCheckResult>();

  // 1. Program compatibility -- same read as assertSelectedMintsAreSupported.
  try {
    const infos = (await params.connection.getMultipleAccountsInfo(assets.map((a) => new PublicKey(a.mint)))) as ({ data: Buffer; owner: PublicKey } | null)[];
    assets.forEach((a, i) => {
      const compat = assessMintAccount(new PublicKey(a.mint), infos[i]);
      if (!compat.supported) {
        bySymbol.set(a.symbol, { symbol: a.symbol, mint: a.mint, status: "blocked", reason: `${describeIncompatibleAsset(a.symbol, compat)} Remove it, or replace it with another asset.`, priceImpactPct: null, route: [] });
      }
    });
  } catch {
    // Read failed -- the launch re-checks this itself before creating anything.
  }

  // 2. Swap routes (Mainnet only; DevNet seeds from faucet test assets).
  const toRoute = params.isMainnet ? assets.filter((a) => a.needsSwap && !bySymbol.has(a.symbol)) : [];
  if (toRoute.length > 0) {
    const doFetch = params.fetchImpl ?? fetch;
    try {
      const res = await doFetch(`${params.origin ?? ""}/api/mainnet/launch-preflight`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ assets: toRoute.map((a) => ({ mint: a.mint, usdcBudgetRaw: String(Math.max(1, Math.round(a.usdcBudgetUsd * 1_000_000))) })) }),
      });
      const body = (await res.json().catch(() => null)) as { results?: ServerResult[] } | null;
      if (res.ok && body && Array.isArray(body.results)) {
        for (const r of body.results) {
          const a = toRoute.find((x) => x.mint === r.mint);
          if (a) bySymbol.set(a.symbol, { symbol: a.symbol, mint: a.mint, status: r.status, reason: r.reason, priceImpactPct: r.priceImpactPct, route: r.route ?? [] });
        }
      }
    } catch {
      // Falls through to "unchecked" below.
    }
  }

  const results = assets.map(
    (a): LaunchCheckResult =>
      bySymbol.get(a.symbol) ??
      (toRoute.some((x) => x.mint === a.mint)
        ? { symbol: a.symbol, mint: a.mint, status: "unchecked", reason: "The route check could not reach Jupiter right now. It does not block the launch; the swap is checked again when you launch.", priceImpactPct: null, route: [] }
        : { symbol: a.symbol, mint: a.mint, status: "ok", reason: "", priceImpactPct: null, route: [] }),
  );
  return { fingerprint, checkedAt: Date.now(), results };
}
