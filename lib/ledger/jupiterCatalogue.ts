// Jupiter Tokens API V2 verified-list catalogue: server-side fetch, cache,
// weekly historical snapshot -- see requirement 9. Requires JUPITER_API_KEY
// (server-only env var, never VITE_-prefixed / never sent to the browser --
// Jupiter's Tokens API V2 requires an `x-api-key` header, obtained from
// portal.jup.ag). NOT YET RUNNABLE without that key configured -- see
// docs/protocol/LEDGER_ARCHITECTURE.md's "Required Creator action" section.
import { getSql } from "./db";

const JUPITER_VERIFIED_TAG_URL = "https://api.jup.ag/tokens/v2/tag?query=verified";

interface JupiterTokenV2 {
  id: string; // mint address
  symbol?: string;
  name?: string;
  decimals?: number;
  tokenProgram?: string;
  tags?: string[];
  organicScore?: number;
  isVerified?: boolean;
}

export interface JupiterFetchResult {
  fetchedAt: string;
  mintCount: number;
  tokens: JupiterTokenV2[];
}

/** Network call -- requires JUPITER_API_KEY. Throws with a clear message (never silently returns an empty/fabricated list) if the key is missing or the request fails, so a caller never mistakes "couldn't fetch" for "genuinely zero verified tokens." */
export async function fetchJupiterVerifiedList(): Promise<JupiterFetchResult> {
  const apiKey = process.env.JUPITER_API_KEY;
  if (!apiKey) {
    throw new Error("JUPITER_API_KEY is not configured -- required to call Jupiter Tokens API V2. See docs/protocol/LEDGER_ARCHITECTURE.md.");
  }
  const res = await fetch(JUPITER_VERIFIED_TAG_URL, { headers: { "x-api-key": apiKey } });
  if (!res.ok) {
    throw new Error(`Jupiter Tokens API V2 request failed: HTTP ${res.status}`);
  }
  const tokens = (await res.json()) as JupiterTokenV2[];
  return { fetchedAt: new Date().toISOString(), mintCount: tokens.length, tokens };
}

/** Pure: given a freshly-fetched token list, decides what a weekly snapshot INSERT + the ledger_asset_catalogue upserts should contain. Split from the DB-writing function below so the shaping logic is unit-testable without a live fetch or database. */
export function shapeSnapshotRows(result: JupiterFetchResult): { mint: string; symbol: string | null; organicScore: number | null; verified: boolean }[] {
  return result.tokens.map((t) => ({
    mint: t.id,
    symbol: t.symbol ?? null,
    organicScore: t.organicScore ?? null,
    verified: t.isVerified ?? true, // every entry returned BY the verified-tag query is, by construction, verified -- explicit fallback only in case a future API revision omits the field
  }));
}

export interface CatalogueDiff {
  added: string[];
  removed: string[];
}

/** Pure: compares two mint sets (this week's fetch vs. the prior snapshot) -- the historical "which mints were added/removed" record the task requires. */
export function diffCatalogue(previousMints: string[], currentMints: string[]): CatalogueDiff {
  const prevSet = new Set(previousMints);
  const currSet = new Set(currentMints);
  return {
    added: currentMints.filter((m) => !prevSet.has(m)),
    removed: previousMints.filter((m) => !currSet.has(m)),
  };
}

export function todayUtcDateString(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Fetches, stores a new weekly snapshot (idempotent per calendar date -- a second call the same UTC day updates nothing new), and upserts ledger_asset_catalogue's current-state rows. Returns the diff against the immediately prior snapshot, or null if this is the first snapshot ever taken. */
export async function runWeeklyJupiterSnapshot(): Promise<{ snapshotDate: string; mintCount: number; diff: CatalogueDiff | null; skipped: boolean }> {
  const sql = getSql();
  const today = todayUtcDateString();

  const existing = await sql`select id from ledger_jupiter_snapshots where snapshot_date_utc = ${today}`;
  if (existing.length > 0) {
    return { snapshotDate: today, mintCount: 0, diff: null, skipped: true };
  }

  const result = await fetchJupiterVerifiedList();
  const rows = shapeSnapshotRows(result);

  const priorRows = await sql`
    select mint from ledger_jupiter_snapshot_mints
    where snapshot_id = (select id from ledger_jupiter_snapshots order by snapshot_date_utc desc limit 1)
  `;
  const previousMints = (priorRows as { mint: string }[]).map((r) => r.mint);
  const diff = priorRows.length > 0 ? diffCatalogue(previousMints, rows.map((r) => r.mint)) : null;

  const [snapshotRow] = await sql`
    insert into ledger_jupiter_snapshots (snapshot_date_utc, source_url, mint_count)
    values (${today}, ${JUPITER_VERIFIED_TAG_URL}, ${rows.length})
    returning id
  `;
  const snapshotId = (snapshotRow as { id: number }).id;

  for (const r of rows) {
    await sql`
      insert into ledger_jupiter_snapshot_mints (snapshot_id, mint, symbol, organic_score, verified)
      values (${snapshotId}, ${r.mint}, ${r.symbol}, ${r.organicScore}, ${r.verified})
      on conflict (snapshot_id, mint) do nothing
    `;
    await sql`
      insert into ledger_asset_catalogue (mint, symbol, jupiter_verified, jupiter_organic_score, added_to_catalogue_at, first_seen_snapshot_id, last_seen_snapshot_id, updated_at)
      values (${r.mint}, ${r.symbol}, ${r.verified}, ${r.organicScore}, now(), ${snapshotId}, ${snapshotId}, now())
      on conflict (mint) do update set
        symbol = coalesce(${r.symbol}, ledger_asset_catalogue.symbol),
        jupiter_verified = ${r.verified},
        jupiter_organic_score = ${r.organicScore},
        last_seen_snapshot_id = ${snapshotId},
        updated_at = now()
    `;
  }

  if (diff) {
    for (const removedMint of diff.removed) {
      await sql`update ledger_asset_catalogue set removed_from_catalogue_at = now(), updated_at = now() where mint = ${removedMint} and removed_from_catalogue_at is null`;
    }
  }

  return { snapshotDate: today, mintCount: rows.length, diff, skipped: false };
}
