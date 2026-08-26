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
//
// DEC-0158 correction: the ledger is no longer the ONLY source. The Mainnet
// ledger had ingested ZERO events (its ingest cron still points at DevNet),
// so this endpoint returned an empty list -- leaving every non-USDC Mainnet
// Reserve's assets unresolvable on a fresh client and invisible to
// landing-stats. The chain itself is the authority: one getProgramAccounts
// discriminator scan enumerates every ReserveAsset account's mint
// (packages/sdk's enumerateReserveAssetMintsOnChain -- works on the paid
// Mainnet RPC; the DevNet public-RPC 403 that originally forced the
// ledger-hint design doesn't apply here). Ledger rows are still unioned in
// as a secondary source so neither source's outage empties the list.
import { Connection } from "@solana/web3.js";
import { enumerateReserveAssetMintsOnChain } from "@ssr/sdk";
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

async function loadLedgerMints(): Promise<string[]> {
  const sql = getSql();
  const rows = (await sql`
    select distinct reserve_asset_mint as mint
    from ledger_events
    where cluster = 'mainnet-beta'
      and reserve_asset_mint is not null
      and status = 'confirmed'
    limit ${MAX_MINTS}
  `) as { mint: string }[];
  return rows.map((r) => r.mint);
}

async function loadOnChainMints(): Promise<string[]> {
  const rpcUrl = process.env.HELIUS_MAINNET_RPC_URL || process.env.MAINNET_RPC_URL;
  // No RPC configured is a FAILURE of this source, never an empty answer --
  // both sources failing must surface as the endpoint's 503, not as "no
  // mints exist" (which would silently blank every non-USDC Reserve).
  if (!rpcUrl) throw new Error("No Mainnet RPC URL is configured for on-chain mint enumeration.");
  return enumerateReserveAssetMintsOnChain(new Connection(rpcUrl, "confirmed"));
}

async function loadKnownMints(): Promise<{ mints: string[]; updatedAt: number }> {
  // Each source is independently best-effort; both failing IS an error
  // (handled by the caller) -- an empty union from real failures must not
  // masquerade as "no mints exist".
  const [ledgerResult, onChainResult] = await Promise.allSettled([loadLedgerMints(), loadOnChainMints()]);
  if (ledgerResult.status === "rejected" && onChainResult.status === "rejected") {
    throw new Error(`Both mint sources failed -- ledger: ${String(ledgerResult.reason)}; on-chain: ${String(onChainResult.reason)}`);
  }
  const mints = new Set<string>([
    ...(ledgerResult.status === "fulfilled" ? ledgerResult.value : []),
    ...(onChainResult.status === "fulfilled" ? onChainResult.value : []),
  ]);
  return { mints: [...mints].slice(0, MAX_MINTS), updatedAt: Date.now() };
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
