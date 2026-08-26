// GET /api/mainnet/landing-stats -- real, on-chain-derived numbers for the
// landing page's KPI strip, on Mainnet. Mirrors api/devnet/landing-stats.ts
// exactly in shape and intent (see that file's header for the full
// rationale) -- deliberately a separate file, not a shared handler
// branching on cluster, so a Mainnet page can never end up reading DevNet
// numbers or vice versa (see docs/project/DECISION_LOG.md's entry for the
// pass that added this file: the homepage was found calling
// /api/devnet/landing-stats unconditionally, showing DevNet holder/volume
// figures on the live Mainnet product).
//
// Candidate asset mints (needed to even find a Reserve's registered assets
// on-chain -- see packages/sdk/src/discovery.ts's header) are the real
// Mainnet USDC mint plus every mint the Ledger has actually observed in a
// confirmed Mainnet reserve-asset event (lib/ledger's ledger_events table,
// the same source api/ledger/known-asset-mints.ts serves to the browser) --
// NOT the full Jupiter catalogue, which would multiply this endpoint's
// (cached, but still real) RPC volume by hundreds for assets no Reserve has
// ever actually used. See api/ledger/known-asset-mints.ts's header for the
// full reasoning, shared verbatim with RealReserveSync.tsx's client-side
// poll.
import { Connection, PublicKey } from "@solana/web3.js";
// Imported via the "@ssr/sdk" package name -- see api/devnet/swap-sign.ts's
// header comment for why a relative "../../packages/sdk/src" import crashes
// this endpoint when deployed.
import {
  buildReadOnlyProgram,
  discoverAllReserves,
  fetchReserveTokenHolderOwners,
  fetchReserve24hVolumeUsd,
  evaluateReserveEligibility,
  registerDynamicSupportedAssetMints,
  MAINNET_USDC_MINT,
  type AssetPricing,
} from "@ssr/sdk";
import { resolveRpcUrl } from "./_lib/rpc";
import { getSql } from "../../lib/ledger/db";
import { withReadConcurrencyLimit } from "../../src/merge/lib/rpcResilience";
import { checkRateWindow } from "../devnet/_lib/rateLimit";

interface ApiRequest {
  method?: string;
  headers: Record<string, string | string[] | undefined>;
  url?: string;
  body?: unknown;
}

interface ApiResponse {
  status(code: number): ApiResponse;
  setHeader?(name: string, value: string): void;
  json(body: unknown): void;
}

const RPC_URL = resolveRpcUrl();
// Matches solana-config.ts's VITE_SSR_PROGRAM_ID Mainnet fallback and the
// live-verified deployment record (DEC-0115) exactly -- hardcoded rather
// than imported from src/merge/lib/solana-config.ts, which reads
// `import.meta.env` (a Vite/browser-build construct unavailable in this
// Node serverless function).
const PROGRAM_ID = new PublicKey("8hTW7fHwn8t8hcgTVeyAhHMiCTHGUP3783NWUTBBFwH9");
const CACHE_TTL_MS = 60_000;
const KNOWN_MINTS_TTL_MS = 2 * 60_000;
const TWENTY_FOUR_HOURS_SEC = 24 * 60 * 60;
const MAX_KNOWN_MINTS = 2000;

// Only USDC has a known, fixed USD price today -- no live price oracle is
// wired up for arbitrary Reserve Assets yet (see docs/protocol/
// LEDGER_ARCHITECTURE.md). An asset with no known price contributes 0 to
// this endpoint's USD volume figure (never a fabricated guess), the exact
// same fallback-to-zero convention api/devnet/landing-stats.ts already uses
// for its own unpriced assets.
const ASSET_PRICES_USD: Record<string, number> = { [MAINNET_USDC_MINT]: 1 };

interface PerReserveStats {
  holders: number;
  volume24hUsd: number;
}

interface LandingStats {
  holders: number;
  volume24hUsd: number;
  computedAt: number;
  reservesCounted: number;
  perReserve: Record<string, PerReserveStats>;
}

let cached: LandingStats | null = null;
let cachedKnownMints: { mints: string[]; fetchedAt: number } | null = null;

async function loadKnownAssetMints(): Promise<string[]> {
  if (cachedKnownMints && Date.now() - cachedKnownMints.fetchedAt < KNOWN_MINTS_TTL_MS) {
    return cachedKnownMints.mints;
  }
  const sql = getSql();
  const rows = (await sql`
    select distinct reserve_asset_mint as mint
    from ledger_events
    where cluster = 'mainnet-beta'
      and reserve_asset_mint is not null
      and status = 'confirmed'
    limit ${MAX_KNOWN_MINTS}
  `) as { mint: string }[];
  const mints = rows.map((r) => r.mint);
  cachedKnownMints = { mints, fetchedAt: Date.now() };
  return mints;
}

async function computeLandingStats(): Promise<LandingStats> {
  const connection = new Connection(RPC_URL, "confirmed");
  const program = buildReadOnlyProgram(connection);

  // The Ledger read is best-effort -- a Ledger/DB hiccup must never take the
  // whole endpoint down; it just means this pass only sees USDC-composed
  // Reserves (the previously-existing, always-correct baseline) until the
  // next successful read.
  const knownMints = await loadKnownAssetMints().catch(() => [] as string[]);
  const candidateAssetMints = [new PublicKey(MAINNET_USDC_MINT), ...knownMints.map((m) => new PublicKey(m))];
  registerDynamicSupportedAssetMints(knownMints);

  const { reserves } = await discoverAllReserves(connection, PROGRAM_ID, candidateAssetMints);
  const displayable = reserves.filter(
    (r) =>
      evaluateReserveEligibility({
        reserve: r.reserve,
        assetCount: r.assetCount,
        resolvedAssetCount: r.resolvedAssetCount,
        assetMints: r.assets.map((a) => a.assetMint),
        status: r.status,
        reserveTokenSupplyRaw: r.reserveTokenSupplyRaw,
      }).eligible,
  );

  const sinceUnixSec = Math.floor(Date.now() / 1000) - TWENTY_FOUR_HOURS_SEC;
  const perReserve: Record<string, PerReserveStats> = {};
  const globalOwners = new Set<string>();
  let volume24hUsd = 0;

  await Promise.all(
    displayable.map((reserve) =>
      withReadConcurrencyLimit(async () => {
        try {
          const pricing: Record<string, AssetPricing> = {};
          for (const asset of reserve.assets) {
            pricing[asset.assetMint] = { decimals: asset.decimals, priceUsd: ASSET_PRICES_USD[asset.assetMint] ?? 0 };
          }
          const [reserveOwners, reserveVolume] = await Promise.all([
            fetchReserveTokenHolderOwners(connection, new PublicKey(reserve.reserveTokenMint)),
            fetchReserve24hVolumeUsd(connection, program, new PublicKey(reserve.reserve), pricing, sinceUnixSec),
          ]);
          perReserve[reserve.reserve] = { holders: reserveOwners.size, volume24hUsd: reserveVolume };
          for (const owner of reserveOwners) globalOwners.add(owner);
          volume24hUsd += reserveVolume;
        } catch {
          // One Reserve's read failing must not abort the whole aggregate --
          // see api/devnet/landing-stats.ts's identical rationale.
        }
      }),
    ),
  );

  return { holders: globalOwners.size, volume24hUsd, computedAt: Date.now(), reservesCounted: displayable.length, perReserve };
}

function clientIp(req: ApiRequest): string {
  const fwd = req.headers["x-forwarded-for"];
  const raw = Array.isArray(fwd) ? fwd[0] : fwd;
  return (raw ?? "unknown").split(",")[0].trim();
}

export default async function handler(req: ApiRequest, res: ApiResponse) {
  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const forceFresh = typeof req.url === "string" && /[?&]force=1(?:&|$)/.test(req.url);

  // force=1 is an undocumented, unauthenticated cache-bypass -- kept for a
  // genuine internal "refresh now" use, but gated by a per-IP throttle so it
  // can't be used to keep the backend permanently doing full-cost
  // recomputation on demand. A plain cached read is unaffected.
  if (forceFresh && !checkRateWindow(`mainnet-landing-stats-force:${clientIp(req)}`, 60_000, 3)) {
    res.status(429).json({ error: "Too many forced-refresh requests -- wait a moment and try again." });
    return;
  }

  if (!forceFresh && cached && Date.now() - cached.computedAt < CACHE_TTL_MS) {
    res.status(200).json(cached);
    return;
  }

  try {
    const stats = await computeLandingStats();
    cached = stats;
    res.status(200).json(stats);
  } catch (e) {
    // Sanitized -- never echoes a raw RPC/driver exception (which can
    // include upstream error text) to the client. Full detail server-side
    // only.
    console.error("api/mainnet/landing-stats: compute failed:", e);
    res.status(503).json({ error: "Live Mainnet Reserve stats are temporarily unavailable." });
  }
}
