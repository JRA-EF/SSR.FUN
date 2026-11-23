// DEC-0296: finishing an unfinished Reserve launch from Manage Reserve, using
// only what the chain knows.
//
// Before this, the only way to finish a launch that stopped half-way (status
// `created` / `assetsInitializing`) was the Launch page's Resume panel, which
// needs the browser's single localStorage record (PendingReserveDeploy). That
// record holds one launch, is replaced by the next one, and is gone on another
// device or after clearing site data. Everything a Resume needs is on-chain
// anyway: the registered assets (mint, target weight, decimals, token
// program) and the manager. Only the seed amount is the creator's choice, so
// they pick it again.
//
// This module is the pure part (covered by tests/phase_onchain_launch_resume.ts)
// plus the thin fetch helpers the Manage card uses. The finishing itself is
// the unchanged resumeReserveDeploymentOnChain.
import type { UnfinishedLaunch } from "@ssr/sdk";
import {
  APP_MAX_RESERVE_ASSETS,
  LAUNCH_PRICE_LOCK_MS,
  MIN_SEED_TOTAL_USD,
  determineDeploymentResumePoint,
  type PendingReserveDeploy,
} from "./createReserveClient";
import { launchCancelMessage, splitCancelledLaunches, type LaunchCancelAction } from "../../../lib/launch-cancel/rules";

export { splitCancelledLaunches };

const CLASSIC_TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

/** What the Manage card may do with an unfinished launch. Only "ready" ever enables Finish. */
export type UnfinishedLaunchVerdict =
  | { kind: "ready" }
  /** create_reserve landed but no asset was registered: the basket is not on-chain, so there is nothing to finish from here. */
  | { kind: "no-assets" }
  /** Fewer asset accounts were found than `asset_count` says exist -- a read gap; never guess at the rest. */
  | { kind: "assets-unreadable"; found: number; expected: number }
  /** More assets than one seed transaction can carry (APP_MAX_RESERVE_ASSETS). */
  | { kind: "too-many-assets"; assetCount: number; max: number }
  /** It became Active in the meantime (another device finished it). */
  | { kind: "already-complete" }
  /** determineDeploymentResumePoint refused: the registered set does not add up. */
  | { kind: "asset-count-mismatch"; onChainAssetCount: number; expectedAssetCount: number };

/**
 * Pure guard. `status` is the FRESH on-chain status (the card re-reads it
 * before finishing); `launch.assets` are the asset accounts actually found.
 */
export function assessUnfinishedLaunch(
  launch: Pick<UnfinishedLaunch, "assetCount" | "assets"> & { status: string },
  maxAssets: number = APP_MAX_RESERVE_ASSETS,
): UnfinishedLaunchVerdict {
  if (launch.status !== "created" && launch.status !== "assetsInitializing") return { kind: "already-complete" };
  if (launch.assetCount === 0) return { kind: "no-assets" };
  if (launch.assets.length < launch.assetCount) return { kind: "assets-unreadable", found: launch.assets.length, expected: launch.assetCount };
  // More asset accounts than the program's own count: cannot come from a normal launch.
  if (launch.assets.length > launch.assetCount) return { kind: "asset-count-mismatch", onChainAssetCount: launch.assetCount, expectedAssetCount: launch.assets.length };
  if (launch.assetCount > maxAssets) return { kind: "too-many-assets", assetCount: launch.assetCount, max: maxAssets };
  const point = determineDeploymentResumePoint({
    reserveExists: true,
    reserveStatus: launch.status,
    onChainAssetCount: launch.assetCount,
    expectedAssetCount: launch.assets.length,
  });
  if (point.kind === "asset-count-mismatch") return point;
  if (point.kind === "already-complete") return { kind: "already-complete" };
  // resume-from-funding is the normal case. Nothing else is expected here (the
  // expected list IS the registered list); refuse anything else rather than guess.
  if (point.kind === "resume-from-funding") return { kind: "ready" };
  return { kind: "asset-count-mismatch", onChainAssetCount: launch.assetCount, expectedAssetCount: launch.assets.length };
}

/** Plain-language reason a verdict blocks Finish, or null for "ready". */
export function describeVerdict(v: UnfinishedLaunchVerdict): string | null {
  switch (v.kind) {
    case "ready":
      return null;
    case "no-assets":
      return "No reserve assets were registered before the launch stopped, so the basket isn't on-chain and this launch can't be finished from here. Launch a new Reserve instead; this one can be left as it is.";
    case "assets-unreadable":
      return `Only ${v.found} of its ${v.expected} reserve assets could be read just now. Nothing was submitted. Reload the page to try again.`;
    case "too-many-assets":
      return `It has ${v.assetCount} reserve assets, more than the ${v.max} a launch can seed in one transaction, so the app can't finish it. Nothing was submitted.`;
    case "already-complete":
      return "It has already finished launching.";
    case "asset-count-mismatch":
      return `Its on-chain record lists ${v.onChainAssetCount} reserve assets but ${v.expectedAssetCount} were found, so the app won't try to finish it automatically. Nothing was submitted.`;
  }
}

/**
 * Pure: the PendingReserveDeploy the Launch page would have persisted for
 * this launch, rebuilt from the chain plus the creator's new seed amount.
 * Assets keep registration order (the order seed_reserve's accounts use).
 * Seed shares follow the registered target weights, normalised over what is
 * registered (a basket registered at 99.96% still splits the whole seed).
 *
 * `existing` is this browser's own record for the SAME Reserve, if any: its
 * per-asset funding progress is kept (swaps already done are reconciled, not
 * repeated), and its start time -- and so the DEC-0249 20-minute price lock --
 * is kept while still inside that lock with the same seed amount.
 */
export function buildPendingDeployFromLaunch(
  launch: Pick<UnfinishedLaunch, "reserve" | "reserveId" | "manager" | "assets">,
  opts: { name: string; ticker: string; seedTotalUsd: number; now: number; existing?: PendingReserveDeploy | null },
): PendingReserveDeploy {
  const ordered = [...launch.assets].sort((a, b) => a.orderIndex - b.orderIndex);
  const totalBps = ordered.reduce((s, a) => s + a.weightBps, 0);
  const same = opts.existing && opts.existing.reserve === launch.reserve && opts.existing.wallet === launch.manager ? opts.existing : null;
  const keepClock = same !== null && same.seedTotalUsd === opts.seedTotalUsd && opts.now - same.startedAt < LAUNCH_PRICE_LOCK_MS;
  return {
    wallet: launch.manager,
    reserve: launch.reserve,
    reserveId: launch.reserveId,
    name: opts.name,
    ticker: opts.ticker.toUpperCase(),
    startedAt: keepClock ? same!.startedAt : opts.now,
    assets: ordered.map((a) => ({
      mint: a.mint,
      decimals: a.decimals,
      weightBps: a.weightBps,
      seedWeightFraction: totalBps > 0 ? a.weightBps / totalBps : 0,
      ...(a.tokenProgram && a.tokenProgram !== CLASSIC_TOKEN_PROGRAM ? { tokenProgram: a.tokenProgram } : {}),
    })),
    seedTotalUsd: opts.seedTotalUsd,
    ...(same?.assetFunding ? { assetFunding: same.assetFunding } : {}),
  };
}

/** Pure: the seed amount problem to show under the input, or null when it can be used. Same floor as the Launch page's seed step. */
export function seedAmountProblem(raw: string, minimumRecommendedSeedUsd = 0): string | null {
  const v = Number(raw);
  if (!raw.trim() || !Number.isFinite(v) || v <= 0) return "Enter how much USDC to put in.";
  if (v < MIN_SEED_TOTAL_USD) return `The initial amount must be at least $${MIN_SEED_TOTAL_USD}.`;
  if (minimumRecommendedSeedUsd > v) return `Every reserve asset needs a routable share: put in at least $${minimumRecommendedSeedUsd.toFixed(2)}.`;
  return null;
}

/** Display name for a Reserve whose metadata could not be read. */
export function fallbackReserveName(reserveId: string): string {
  return `Reserve #${reserveId}`;
}

// --- Server calls (api/mainnet/unfinished-launches.ts) ----------------------

export interface UnfinishedLaunchesResponse {
  launches: UnfinishedLaunch[];
  cancelled: { reserve: string; cancelledAt: string }[];
  cancelledUnavailable?: boolean;
}

export async function fetchUnfinishedLaunches(wallet: string, fetchImpl: typeof fetch = fetch): Promise<UnfinishedLaunchesResponse> {
  const res = await fetchImpl(`/api/mainnet/unfinished-launches?wallet=${encodeURIComponent(wallet)}`, { cache: "no-store", credentials: "same-origin" });
  const body = (await res.json().catch(() => null)) as (UnfinishedLaunchesResponse & { error?: string }) | null;
  if (!res.ok || !body || !Array.isArray(body.launches)) throw new Error(body?.error || `Could not check for unfinished launches (HTTP ${res.status}).`);
  return { launches: body.launches, cancelled: Array.isArray(body.cancelled) ? body.cancelled : [], cancelledUnavailable: body.cancelledUnavailable };
}

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

/** Signs and sends a cancel/undo; returns the wallet's cancelled list after the change. */
export async function submitLaunchCancel(
  params: { action: LaunchCancelAction; reserve: string; wallet: string; signMessage: (m: Uint8Array) => Promise<Uint8Array> },
  fetchImpl: typeof fetch = fetch,
): Promise<{ reserve: string; cancelledAt: string }[]> {
  const issuedAt = new Date().toISOString();
  const signature = await params.signMessage(new TextEncoder().encode(launchCancelMessage({ action: params.action, reserve: params.reserve, wallet: params.wallet, issuedAt })));
  const res = await fetchImpl("/api/mainnet/unfinished-launches", {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify({ action: params.action, reserve: params.reserve, wallet: params.wallet, issuedAt, signature: toBase64(signature) }),
  });
  const body = (await res.json().catch(() => null)) as { ok?: boolean; cancelled?: { reserve: string; cancelledAt: string }[]; error?: string } | null;
  if (!res.ok || !body?.ok) throw new Error(body?.error || `That didn't go through (HTTP ${res.status}).`);
  return body.cancelled ?? [];
}
