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
  enumerateReserveAssetMintsOnChain,
  fetchReserveTokenHolderOwners,
  fetchReserve24hVolumeUsd,
  evaluateReserveEligibility,
  registerDynamicSupportedAssetMints,
  MAINNET_USDC_MINT,
  type AssetPricing,
} from "@ssr/sdk";
import { fetchJupiterPrices } from "./asset-prices";
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

// USDC is a fixed $1; every OTHER Reserve Asset is priced live via the same
// Jupiter Price source api/mainnet/asset-prices.ts already serves the app
// from (DEC-0158 -- previously only USDC was priced, so every non-USDC
// leg's volume was counted as $0). An asset whose live price can't be
// fetched still contributes 0 to the USD volume figure (never a fabricated
// guess), the same fallback-to-zero convention api/devnet/landing-stats.ts
// uses for its own unpriced assets.
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

  // Candidate mints: the chain's own ReserveAsset enumeration is the
  // authority (DEC-0158 -- one gPA discriminator scan; the Mainnet ledger
  // had ingested nothing, which silently reduced this endpoint to
  // USDC-composed Reserves only). The Ledger read stays unioned in as a
  // secondary source; either source failing alone must never take the
  // endpoint down.
  const [ledgerMints, onChainMints] = await Promise.all([
    loadKnownAssetMints().catch(() => [] as string[]),
    enumerateReserveAssetMintsOnChain(connection).catch(() => [] as string[]),
  ]);
  const knownMints = [...new Set([...ledgerMints, ...onChainMints])];
  const candidateAssetMints = [new PublicKey(MAINNET_USDC_MINT), ...knownMints.filter((m) => m !== MAINNET_USDC_MINT).map((m) => new PublicKey(m))];
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

  // Live USD prices for every asset any displayable Reserve holds -- one
  // batched Jupiter Price read, best-effort per mint (an unpriced mint's
  // volume counts as 0, never a guess).
  const allAssetMints = [...new Set(displayable.flatMap((r) => r.assets.map((a) => a.assetMint)))];
  const livePrices: Map<string, { usdPrice: number | null | undefined }> = await fetchJupiterPrices(allAssetMints.filter((m) => !(m in ASSET_PRICES_USD))).catch(
    () => new Map<string, { usdPrice: number | null | undefined }>(),
  );

  await Promise.all(
    displayable.map((reserve) =>
      withReadConcurrencyLimit(async () => {
        try {
          const pricing: Record<string, AssetPricing> = {};
          for (const asset of reserve.assets) {
            const fixed = ASSET_PRICES_USD[asset.assetMint];
            const live = livePrices.get(asset.assetMint)?.usdPrice;
            pricing[asset.assetMint] = { decimals: asset.decimals, priceUsd: fixed ?? (Number.isFinite(live) && (live as number) > 0 ? (live as number) : 0) };
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
