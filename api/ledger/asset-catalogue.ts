// GET /api/ledger/asset-catalogue -- serves the current Jupiter Tokens API V2
// verified-token catalogue (see lib/ledger/jupiterCatalogue.ts's weekly
// snapshot, api/ledger/jupiter-snapshot-cron.ts) for the Mainnet Reserve
// Asset selector (src/merge/pages/CreateDTR.tsx). Public, read-only, no
// dashboard auth (same convention as api/devnet/reserve-metadata.ts/
// landing-stats.ts -- ordinary site visitors need this to compose a
// Reserve), no secrets (JUPITER_API_KEY never leaves the weekly cron that
// fetches Jupiter directly; this endpoint only ever reads Postgres).
//
// Deliberately reuses lib/ledger's existing catalogue table rather than
// calling Jupiter's API directly per request -- the weekly snapshot IS the
// "verified list," and hitting Jupiter on every page load would be both
// wasteful and a second place the API key would need to be threaded.
//
// Symbol de-duplication: Jupiter's verified tag still contains multiple
// mints sharing a symbol (bridged/wrapped variants, occasional squatters).
// This app's asset picker keys selectable assets BY SYMBOL
// (REAL_ASSET_BY_SYMBOL in CreateDTR.tsx), so returning more than one mint
// per symbol would let a symbol collision silently resolve to the wrong
// mint. `dedupeBySymbolPreferOrganicScore` keeps only the highest
// organic-score mint per symbol -- Jupiter's own ranking signal, not an
// invented one. "USDC" itself is excluded entirely: this app already pins
// the canonical Circle USDC mint as a hardcoded constant
// (MAINNET_USDC_MINT), so no catalogue-sourced "USDC" entry can ever shadow
// it.
import { getSql } from "../../lib/ledger/db";

interface ApiRequest {
  method?: string;
}

interface ApiResponse {
  status(code: number): ApiResponse;
  setHeader?(name: string, value: string): void;
  json(body: unknown): void;
}

export interface CatalogueRow {
  mint: string;
  symbol: string;
  name: string | null;
  decimals: number;
  organicScore: number | null;
}

export interface CatalogueToken {
  mint: string;
  symbol: string;
  name: string;
  decimals: number;
}

/** Pure -- unit-testable without a live database. Keeps at most one entry per symbol (the highest organic-score mint), excludes the reserved "USDC" symbol entirely, and returns entries sorted by score (nulls last) then symbol. */
export function dedupeBySymbolPreferOrganicScore(rows: CatalogueRow[]): CatalogueToken[] {
  const bestBySymbol = new Map<string, CatalogueRow>();
  for (const row of rows) {
    if (!row.symbol || row.symbol.toUpperCase() === "USDC") continue;
    const existing = bestBySymbol.get(row.symbol);
    const rowScore = row.organicScore ?? -Infinity;
    const existingScore = existing ? existing.organicScore ?? -Infinity : -Infinity;
    if (!existing || rowScore > existingScore) bestBySymbol.set(row.symbol, row);
  }
  return [...bestBySymbol.values()]
    .sort((a, b) => (b.organicScore ?? -Infinity) - (a.organicScore ?? -Infinity) || a.symbol.localeCompare(b.symbol))
    .map((r) => ({ mint: r.mint, symbol: r.symbol, name: r.name || r.symbol, decimals: r.decimals }));
}

const CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_RAW_ROWS = 2000;
const MAX_RESPONSE_TOKENS = 500;

let cached: { tokens: CatalogueToken[]; updatedAt: number } | null = null;

async function loadCatalogue(): Promise<{ tokens: CatalogueToken[]; updatedAt: number }> {
  const sql = getSql();
  const rows = (await sql`
    select mint, symbol, name, decimals, jupiter_organic_score as "organicScore"
    from ledger_asset_catalogue
    where jupiter_verified = true
      and decimals is not null
      and symbol is not null
      and ssr_status not in ('disabled', 'blocklisted')
      and removed_from_catalogue_at is null
    order by jupiter_organic_score desc nulls last, symbol asc
    limit ${MAX_RAW_ROWS}
  `) as CatalogueRow[];
  const tokens = dedupeBySymbolPreferOrganicScore(rows).slice(0, MAX_RESPONSE_TOKENS);
  return { tokens, updatedAt: Date.now() };
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
    const result = await loadCatalogue();
    cached = result;
    res.status(200).json(result);
  } catch (e) {
    // Never echo the raw driver/exception message to the client (it can
    // include connection details) -- log full detail server-side only.
    console.error("api/ledger/asset-catalogue: load failed:", e);
    res.status(503).json({ error: "The asset catalogue is temporarily unavailable." });
  }
}
