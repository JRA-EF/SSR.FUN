// GET /api/ledger/known-asset-mints -- the set of Reserve Asset mints that
// have genuinely appeared in a confirmed Mainnet on-chain event (see
// lib/ledger's ledger_events.reserve_asset_mint, populated by
// api/ledger/ingest-cron.ts). This -- NOT the full Jupiter catalogue -- is
// what src/merge/lib/RealReserveSync.tsx and api/mainnet/landing-stats.ts
// use as their discovery "candidate mint" hint list.
//
// Why not just probe the whole Jupiter catalogue (hundreds of mints)
// instead: discovery derives 2 PDAs per (Reserve x candidate mint) and reads
// them every poll tick (every ~15s, on every page, for every visitor) --
// scaling that by the catalogue's size instead of by what's actually in use
// would multiply the Mainnet RPC-call volume by orders of magnitude for no
// benefit (an asset nobody has ever put in a Reserve yet has nothing to
// discover). This list only grows when a real Reserve actually uses a new
// asset, so it stays small in practice. It is a slower-moving, ledger-
// derived hint, not a real-time source -- see useAppStore.ts's
// mainnetKnownAssetMints for how a browser's OWN just-created Reserve is
// discoverable immediately, before this endpoint's data (refreshed daily by
// the ledger ingest cron) would otherwise catch up.
//
// Public, read-only, no dashboard auth, no secrets.
import { getSql } from "../../lib/ledger/db";

interface ApiRequest {
  method?: string;
}

interface ApiResponse {
  status(code: number): ApiResponse;
  setHeader?(name: string, value: string): void;
  json(body: unknown): void;
}

const CACHE_TTL_MS = 2 * 60 * 1000;
const MAX_MINTS = 2000;

let cached: { mints: string[]; updatedAt: number } | null = null;

async function loadKnownMints(): Promise<{ mints: string[]; updatedAt: number }> {
  const sql = getSql();
  const rows = (await sql`
    select distinct reserve_asset_mint as mint
    from ledger_events
    where cluster = 'mainnet-beta'
      and reserve_asset_mint is not null
      and status = 'confirmed'
    limit ${MAX_MINTS}
  `) as { mint: string }[];
  return { mints: rows.map((r) => r.mint), updatedAt: Date.now() };
}

export default async function handler(req: ApiRequest, res: ApiResponse) {
  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }
  res.setHeader?.("Cache-Control", "no-store");

  if (cached && Date.now() - cached.updatedAt < CACHE_TTL_MS) {
    res.status(200).json(cached);
    return;
  }

  try {
    const result = await loadKnownMints();
    cached = result;
    res.status(200).json(result);
  } catch (e) {
    console.error("api/ledger/known-asset-mints: load failed:", e);
    res.status(503).json({ error: "The known-asset-mint list is temporarily unavailable." });
  }
}
