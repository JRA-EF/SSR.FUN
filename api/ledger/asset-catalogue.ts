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
  tokenProgram: string | null;
}

export interface CatalogueToken {
  mint: string;
  symbol: string;
  name: string;
  decimals: number;
  /**
   * The token program that owns this mint (DEC-0201). Carried all the way to
   * the instruction builders, which create the vault and derive every ATA
   * under it. Rows captured before this column existed report classic SPL
   * Token, which is what they are.
   */
  tokenProgram: string;
}

/**
 * The Token-2022 program's real, canonical Mainnet address.
 *
 * These mints were excluded from the picker entirely until 2026-09-11,
 * because every client-side instruction builder hardcoded the classic SPL
 * Token program and would have built a transaction with the wrong program
 * account. That exclusion cost far more than it looked: measured against the
 * live catalogue, 1,587 of 3,224 Jupiter-verified mints are Token-2022 --
 * 49% of the tradable universe, including most pump.fun-era tokens and PUMP
 * itself, which is what surfaced it.
 *
 * The on-chain program was never the blocker: asset legs are InterfaceAccounts,
 * each ReserveAsset records its own token_program, and the CPI uses whichever
 * program the caller passes. DEC-0201 made the CLIENT pass it, so the
 * exclusion below is gone and these mints are selectable.
 */
export const TOKEN_2022_PROGRAM_ID = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

/**
 * Pure -- unit-testable without a live database. Keeps at most one entry per
 * symbol (the highest organic-score mint), excludes the reserved "USDC"
 * symbol, and returns entries sorted by score (nulls last) then symbol.
 *
 * Token-2022 mints are NO LONGER excluded (DEC-0201): each entry now carries
 * its own token program through to the builders. A null/unknown tokenProgram
 * reports classic SPL Token, which is what those rows are.
 */
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
    .map((r) => ({
      mint: r.mint,
      symbol: r.symbol,
      name: r.name || r.symbol,
      decimals: r.decimals,
      tokenProgram: r.tokenProgram === TOKEN_2022_PROGRAM_ID ? TOKEN_2022_PROGRAM_ID : SPL_TOKEN_PROGRAM_ID,
    }));
}

/** The classic SPL Token program -- the default for any row without a positively-confirmed Token-2022 owner. */
export const SPL_TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

const CACHE_TTL_MS = 5 * 60 * 1000;
// Both limits must comfortably exceed Jupiter's real verified-list size
// (~2,600 as of 2026-08-20) -- a lower cap here silently hides any
// verified, legitimately-catalogued token whose organic score (a trading-
// activity ranking, not a safety signal) happens to be low, which is
// exactly what made a newer verified token unfindable even via the picker's
// own search box (organic score only affects sort ORDER below, never
// inclusion). See docs/project/DECISION_LOG.md's entry for this fix.
const MAX_RAW_ROWS = 6000;
const MAX_RESPONSE_TOKENS = 5000;

let cached: { tokens: CatalogueToken[]; updatedAt: number } | null = null;

async function loadCatalogue(): Promise<{ tokens: CatalogueToken[]; updatedAt: number }> {
  const sql = getSql();
  const rows = (await sql`
    select mint, symbol, name, decimals, jupiter_organic_score as "organicScore", token_program as "tokenProgram"
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
