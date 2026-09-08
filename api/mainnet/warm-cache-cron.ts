// GET/POST /api/mainnet/warm-cache-cron -- the self-warming keeper that keeps
// the homepage/Discover Reserve snapshot fresh EVEN WITH NO USERS, so a visitor
// paints instantly from one DB read (api/mainnet/reserves-snapshot.ts) instead
// of running the on-chain discovery burst in their browser (the burst that
// self-inflicted the rpc-proxy 429s and broke Discover under load).
//
// Vercel Cron can't fire faster than once/minute, so this handler SELF-WARMS:
// one invocation refreshes the snapshot every ~15s for ~52s (staying under the
// api/mainnet/* maxDuration of 60), giving ~15s effective freshness with zero
// external scheduler. Register in vercel.json `crons` at "*/1 * * * *".
//
// Same CRON_SECRET pattern as api/kpis/kpis-backfill-cron.ts: a real scheduled
// invocation carries `Authorization: Bearer $CRON_SECRET`; `?dryRun=true` skips
// that check for manual inspection but runs the identical real work. This
// endpoint's path MUST also be in middleware.ts's CRON_PATHS allowlist so the
// site password gate lets the scheduler through.
//
// The discovery pass mirrors api/mainnet/landing-stats.ts exactly (same
// candidate-mint sourcing, same discoverAllReserves + evaluateReserveEligibility
// gate) so the cached Reserve set is identical to what that KPI endpoint counts
// and to what the client would discover live.
import { Connection, PublicKey } from "@solana/web3.js";
import {
  discoverAllReserves,
  enumerateReserveAssetMintsOnChain,
  evaluateReserveEligibility,
  registerDynamicSupportedAssetMints,
  resolveReserveMetadata,
  MAINNET_USDC_MINT,
  type ParsedReserveMetadata,
} from "@ssr/sdk";
import { fetchJupiterPrices } from "./asset-prices";
import { resolveRpcUrl } from "./_lib/rpc";
import { getSql } from "../../lib/ledger/db";
import { getSql as getMetadataSql } from "../../lib/reserve-metadata/db";
import { writeReserveSnapshot } from "../../lib/reserve-warm-cache/db";
import { withReadConcurrencyLimit } from "../../src/merge/lib/rpcResilience";

interface ApiRequest {
  method?: string;
  headers: Record<string, string | string[] | undefined>;
  url?: string;
}
interface ApiResponse {
  status(code: number): ApiResponse;
  json(body: unknown): void;
}

const RPC_URL = resolveRpcUrl();
// Hardcoded (not imported from solana-config.ts, which reads import.meta.env) --
// matches landing-stats.ts and the live-verified deployment record.
const PROGRAM_ID = new PublicKey("8hTW7fHwn8t8hcgTVeyAhHMiCTHGUP3783NWUTBBFwH9");
const CLUSTER = "mainnet-beta";
const MAX_KNOWN_MINTS = 2000;
const REFRESH_SPACING_MS = 15_000;
const BUDGET_MS = 52_000; // under the api/mainnet/* maxDuration (60s in vercel.json)

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function getHeader(req: ApiRequest, name: string): string | undefined {
  const v = req.headers[name] ?? req.headers[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
}

// A Reserve's metadata_uri points at this app's OWN gated
// /api/mainnet/reserve-metadata?id=<16hex> endpoint. resolveReserveMetadata
// would fetch that over HTTP -- but a server-side fetch has no site-gate
// cookie and gets a 401, so every name came back null. The stored payload IS
// already exactly ParsedReserveMetadata ({name,ticker,description,category,
// buyTaxPct,sellTaxPct,imageUrl?}), so read it straight from the store,
// bypassing the HTTP round-trip and the gate entirely.
const META_ID_RE = /[?&]id=([0-9a-f]{16})\b/i;
async function resolveMetadata(metadataUri: string): Promise<ParsedReserveMetadata | null> {
  if (!metadataUri) return null;
  const m = metadataUri.match(META_ID_RE);
  if (m) {
    const sql = getMetadataSql();
    const rows = (await sql`select payload from reserve_metadata where id = ${m[1]}`) as { payload: unknown }[];
    const p = rows[0]?.payload;
    return p && typeof p === "object" ? (p as ParsedReserveMetadata) : null;
  }
  // Non-store URI (inline data:, or a truly external host) -- the generic
  // resolver handles those and is safe server-side.
  return resolveReserveMetadata(metadataUri).catch(() => null);
}

async function loadKnownAssetMints(): Promise<string[]> {
  const sql = getSql();
  const rows = (await sql`
    select distinct reserve_asset_mint as mint
    from ledger_events
    where cluster = 'mainnet-beta'
      and reserve_asset_mint is not null
      and status = 'confirmed'
    limit ${MAX_KNOWN_MINTS}
  `) as { mint: string }[];
  return rows.map((r) => r.mint);
}

/**
 * One discovery + price + metadata pass -> one snapshot write. `metadataCache`
 * is invocation-scoped: Reserve name/ticker/category are 24h-stable, so each
 * Reserve's metadata is resolved once and reused across the loop's ~4 refreshes
 * (only the balances/prices, which actually move, are re-read each pass).
 */
async function refreshOnce(
  connection: Connection,
  candidateAssetMints: PublicKey[],
  metadataCache: Map<string, ParsedReserveMetadata | null>,
): Promise<number> {
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

  // Live USD prices (best-effort). USDC is fixed $1; an unpriced mint is simply
  // omitted -- the client renders it as unavailable, never a fabricated guess.
  const allAssetMints = [...new Set(displayable.flatMap((r) => r.assets.map((a) => a.assetMint)))];
  const livePrices = await fetchJupiterPrices(allAssetMints.filter((m) => m !== MAINNET_USDC_MINT)).catch(
    () => new Map<string, { usdPrice: number | null | undefined }>(),
  );
  const priceByMint: Record<string, number> = { [MAINNET_USDC_MINT]: 1 };
  for (const m of allAssetMints) {
    const live = livePrices.get(m)?.usdPrice;
    if (typeof live === "number" && Number.isFinite(live) && live > 0) priceByMint[m] = live;
  }

  const metadataByReserve: Record<string, ParsedReserveMetadata | null> = {};
  await Promise.all(
    displayable.map((r) =>
      withReadConcurrencyLimit(async () => {
        if (!metadataCache.has(r.reserveId)) {
          try {
            metadataCache.set(r.reserveId, await resolveMetadata(r.metadataUri));
          } catch {
            metadataCache.set(r.reserveId, null);
          }
        }
        metadataByReserve[r.reserveId] = metadataCache.get(r.reserveId) ?? null;
      }),
    ),
  );

  // Asset symbols from the ledger catalogue (ledger_asset_catalogue -- the same
  // source the client's useMainnetAssetCatalogue reads) so the client paints
  // REAL asset symbols from the first snapshot frame instead of "Asset2/Asset3"
  // until its own Jupiter catalogue loads. SOL/USDC are resolved client-side
  // without mintMeta; this map covers every other asset. Best-effort: a
  // catalogue read failure just omits symbols (the live poll still backfills
  // them), and never fails the snapshot.
  const mintMeta: Record<string, { symbol: string; name: string }> = {};
  try {
    const sql = getSql();
    const rows = (await sql`
      select mint, symbol, name from ledger_asset_catalogue
      where mint = any(${allAssetMints}) and symbol is not null
    `) as { mint: string; symbol: string; name: string | null }[];
    for (const row of rows) mintMeta[row.mint] = { symbol: row.symbol, name: row.name ?? row.symbol };
  } catch (e) {
    console.error("api/mainnet/warm-cache-cron: asset-symbol lookup failed (non-fatal):", e);
  }

  // DiscoveredReserve is a flat DTO (all string/number/boolean) -- safe to
  // persist as jsonb and round-trip to the client's buildDtrFromDiscoveredReserve.
  await writeReserveSnapshot(CLUSTER, {
    reserves: displayable,
    priceByMint,
    metadataByReserve,
    mintMeta,
    computedAt: Date.now(),
    reserveCount: displayable.length,
  });
  return displayable.length;
}

export default async function handler(req: ApiRequest, res: ApiResponse) {
  if (req.method !== "GET" && req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const dryRun = typeof req.url === "string" && /[?&]dryRun=(?:true|1)(?:&|$)/.test(req.url);
  if (!dryRun) {
    const expected = process.env.CRON_SECRET;
    if (!expected) {
      res.status(500).json({ error: "CRON_SECRET is not configured on this deployment." });
      return;
    }
    if (getHeader(req, "authorization") !== `Bearer ${expected}`) {
      res.status(401).json({ error: "Unauthorized." });
      return;
    }
  }

  try {
    const connection = new Connection(RPC_URL, "confirmed");
    // Candidate mints (the heavy gPA enumeration + Ledger read) are stable
    // within a minute -- computed ONCE per invocation and reused across the
    // self-warming refreshes; only discover + price passes repeat every ~15s.
    const [ledgerMints, onChainMints] = await Promise.all([
      loadKnownAssetMints().catch(() => [] as string[]),
      enumerateReserveAssetMintsOnChain(connection).catch(() => [] as string[]),
    ]);
    const knownMints = [...new Set([...ledgerMints, ...onChainMints])];
    const candidateAssetMints = [
      new PublicKey(MAINNET_USDC_MINT),
      ...knownMints.filter((m) => m !== MAINNET_USDC_MINT).map((m) => new PublicKey(m)),
    ];
    registerDynamicSupportedAssetMints(knownMints);

    const metadataCache = new Map<string, ParsedReserveMetadata | null>();
    const deadline = Date.now() + BUDGET_MS;
    let refreshes = 0;
    let lastReserveCount = 0;
    let lastError: string | null = null;

    do {
      try {
        lastReserveCount = await refreshOnce(connection, candidateAssetMints, metadataCache);
        refreshes++;
      } catch (e) {
        lastError = e instanceof Error ? e.message : String(e);
        console.error("api/mainnet/warm-cache-cron: refresh failed:", e);
      }
      // Only sleep for another cycle if a full (spacing + typical refresh) fits.
      if (Date.now() + REFRESH_SPACING_MS + 3_000 < deadline) await sleep(REFRESH_SPACING_MS);
      else break;
    } while (Date.now() < deadline);

    res.status(200).json({
      ok: refreshes > 0,
      cluster: CLUSTER,
      refreshes,
      reserveCount: lastReserveCount,
      knownMints: knownMints.length,
      lastError,
      dryRun,
    });
  } catch (e) {
    console.error("api/mainnet/warm-cache-cron: fatal:", e);
    res.status(503).json({ error: "Warm-cache refresh failed." });
  }
}
