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

export interface CatalogueSnapshotRow {
  mint: string;
  symbol: string | null;
  organicScore: number | null;
  verified: boolean;
  decimals: number | null;
  tokenProgram: string | null;
}

/** Pure: given a freshly-fetched token list, decides what a weekly snapshot INSERT + the ledger_asset_catalogue upserts should contain. Split from the DB-writing function below so the shaping logic is unit-testable without a live fetch or database. `decimals`/`tokenProgram` are needed downstream by api/ledger/asset-catalogue.ts (the Mainnet Reserve Asset picker can't safely offer a mint whose decimals aren't known) -- carried through here rather than re-fetched per-mint later. */
export function shapeSnapshotRows(result: JupiterFetchResult): CatalogueSnapshotRow[] {
  return result.tokens.map((t) => ({
    mint: t.id,
    symbol: t.symbol ?? null,
    organicScore: t.organicScore ?? null,
    verified: t.isVerified ?? true, // every entry returned BY the verified-tag query is, by construction, verified -- explicit fallback only in case a future API revision omits the field
    decimals: typeof t.decimals === "number" ? t.decimals : null,
    tokenProgram: t.tokenProgram ?? null,
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

/**
 * Fetches, stores a new weekly snapshot (idempotent per calendar date -- a
 * second call the same UTC day is a no-op UNLESS `force` is set), and
 * upserts ledger_asset_catalogue's current-state rows. Returns the diff
 * against the most recent PRIOR (strictly earlier-dated) snapshot, or null
 * if none exists yet.
 *
 * `force`: re-runs the full fetch+upsert even if today's snapshot already
 * exists, reusing that same snapshot row (never inserts a second row for
 * the same date -- `ledger_jupiter_snapshots.snapshot_date_utc` is unique)
 * -- see api/ledger/jupiter-snapshot-cron.ts's `?force=1`. Exists for
 * exactly one legitimate case: backfilling a column added to
 * ledger_asset_catalogue (like `decimals`/`token_program` below) after an
 * already-run snapshot for today didn't populate it. Not for routine use --
 * the weekly cron never passes it.
 */
export async function runWeeklyJupiterSnapshot(options?: { force?: boolean }): Promise<{ snapshotDate: string; mintCount: number; diff: CatalogueDiff | null; skipped: boolean }> {
  const sql = getSql();
  const today = todayUtcDateString();
  const force = options?.force ?? false;

  const existing = await sql`select id from ledger_jupiter_snapshots where snapshot_date_utc = ${today}`;
  if (existing.length > 0 && !force) {
    return { snapshotDate: today, mintCount: 0, diff: null, skipped: true };
  }

  const result = await fetchJupiterVerifiedList();
  const rows = shapeSnapshotRows(result);

  const priorRows = await sql`
    select mint from ledger_jupiter_snapshot_mints
    where snapshot_id = (select id from ledger_jupiter_snapshots where snapshot_date_utc < ${today} order by snapshot_date_utc desc limit 1)
  `;
  const previousMints = (priorRows as { mint: string }[]).map((r) => r.mint);
  const diff = priorRows.length > 0 ? diffCatalogue(previousMints, rows.map((r) => r.mint)) : null;

  let snapshotId: number;
  if (existing.length > 0) {
    // force=true, re-running the same UTC day -- reuse today's row rather
    // than violating the (snapshot_date_utc) unique constraint.
    snapshotId = (existing[0] as { id: number }).id;
    await sql`update ledger_jupiter_snapshots set mint_count = ${rows.length}, fetched_at_utc = now() where id = ${snapshotId}`;
  } else {
    const [snapshotRow] = await sql`
      insert into ledger_jupiter_snapshots (snapshot_date_utc, source_url, mint_count)
      values (${today}, ${JUPITER_VERIFIED_TAG_URL}, ${rows.length})
      returning id
    `;
    snapshotId = (snapshotRow as { id: number }).id;
  }

  for (const r of rows) {
    await sql`
      insert into ledger_jupiter_snapshot_mints (snapshot_id, mint, symbol, organic_score, verified)
      values (${snapshotId}, ${r.mint}, ${r.symbol}, ${r.organicScore}, ${r.verified})
      on conflict (snapshot_id, mint) do nothing
    `;
    await sql`
      insert into ledger_asset_catalogue (mint, symbol, decimals, token_program, jupiter_verified, jupiter_organic_score, added_to_catalogue_at, first_seen_snapshot_id, last_seen_snapshot_id, updated_at)
      values (${r.mint}, ${r.symbol}, ${r.decimals}, ${r.tokenProgram}, ${r.verified}, ${r.organicScore}, now(), ${snapshotId}, ${snapshotId}, now())
      on conflict (mint) do update set
        symbol = coalesce(${r.symbol}, ledger_asset_catalogue.symbol),
        decimals = coalesce(${r.decimals}, ledger_asset_catalogue.decimals),
        token_program = coalesce(${r.tokenProgram}, ledger_asset_catalogue.token_program),
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
