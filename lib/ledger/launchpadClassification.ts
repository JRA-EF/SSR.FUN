// Launchpad provenance for the Reserve Asset catalogue: which catalogue
// mints were launched on Pump.fun / LetsBONK.fun / Bags.fm, whether they are
// still bonding or have graduated, and where they trade now. Detection is
// on-chain only (packages/sdk/src/launchpads.ts); this module is the
// catalogue-side job that stores the verified result on
// ledger_asset_catalogue (launchpad, launchpad_stage, launchpad_venue,
// launchpad_evidence, launchpad_checked_at) so the asset picker can label
// and filter without any per-request RPC.
//
// PROVENANCE NEVER GATES ELIGIBILITY. api/ledger/asset-catalogue.ts keeps
// its existing gates untouched (Jupiter verified list, Token-2022 exclusion,
// symbol de-duplication, ssr_status); a launchpad label is information a
// Manager sees next to an asset, nothing more.
//
// The pure helpers (selectMintsToClassify, launchpadColumnsFor) are what
// tests/phase_launchpads.ts exercises; runLaunchpadClassification is the
// DB + RPC job behind api/ledger/launchpad-classify-cron.ts.
import { Connection, PublicKey } from "@solana/web3.js";
import { classifyMintsBatch, type LaunchpadEvidence, type LaunchpadProvenance } from "../../packages/sdk/src/launchpads";
import { getSql } from "./db";

export interface LaunchpadColumns {
  launchpad: string | null;
  launchpadStage: string | null;
  launchpadVenue: string | null;
  launchpadEvidence: LaunchpadEvidence | null;
}

/** Maps a detection result to the catalogue columns. `null` provenance is stored as explicit nulls with a fresh checked_at -- "verified: not from a supported launchpad", distinct from never checked. */
export function launchpadColumnsFor(p: LaunchpadProvenance | null): LaunchpadColumns {
  if (!p) return { launchpad: null, launchpadStage: null, launchpadVenue: null, launchpadEvidence: null };
  return { launchpad: p.launchpad, launchpadStage: p.stage, launchpadVenue: p.venue, launchpadEvidence: p.evidence };
}

export interface ClassificationCandidate {
  mint: string;
  launchpadCheckedAt: string | null;
  launchpadStage: string | null;
}

export interface SelectionOptions {
  now: number;
  limit: number;
  /** A token still on its bonding curve can graduate any day -- re-check it often. */
  bondingRecheckMs: number;
  /** Everything else (graduated, or not a launchpad token) is re-checked on a slow cycle in case the on-chain state changes (e.g. a later graduation venue). */
  fullRecheckMs: number;
}

/** Pure: which catalogue mints the next run should (re)classify, most urgent first, capped at `limit`. */
export function selectMintsToClassify(rows: ClassificationCandidate[], opts: SelectionOptions): string[] {
  const never: string[] = [];
  const bondingStale: Array<[number, string]> = [];
  const stale: Array<[number, string]> = [];
  for (const r of rows) {
    if (!r.launchpadCheckedAt) {
      never.push(r.mint);
      continue;
    }
    const age = opts.now - Date.parse(r.launchpadCheckedAt);
    if (r.launchpadStage === "bonding" && age >= opts.bondingRecheckMs) bondingStale.push([age, r.mint]);
    else if (age >= opts.fullRecheckMs) stale.push([age, r.mint]);
  }
  const byAgeDesc = (a: [number, string], b: [number, string]) => b[0] - a[0];
  return [...never, ...bondingStale.sort(byAgeDesc).map((x) => x[1]), ...stale.sort(byAgeDesc).map((x) => x[1])].slice(0, opts.limit);
}

export const DEFAULT_BATCH_LIMIT = 400;
export const BONDING_RECHECK_MS = 2 * 24 * 60 * 60 * 1000;
export const FULL_RECHECK_MS = 30 * 24 * 60 * 60 * 1000;

export interface ClassificationRunResult {
  considered: number;
  selected: number;
  classified: number;
  launchpadTokens: number;
  failed: number;
  byLaunchpad: Record<string, number>;
}

/**
 * One bounded run: picks up to `limit` catalogue mints (never-checked first),
 * classifies them on-chain in one batch, and writes the result. Mints whose
 * lookups failed are left untouched (still "never checked" or stale) so a
 * transient RPC error never gets recorded as "not a launchpad token".
 * `classify` is injectable for tests.
 */
export async function runLaunchpadClassification(options: {
  rpcUrl: string;
  limit?: number;
  now?: number;
  classify?: typeof classifyMintsBatch;
}): Promise<ClassificationRunResult> {
  const sql = getSql();
  const limit = options.limit ?? DEFAULT_BATCH_LIMIT;
  const now = options.now ?? Date.now();
  const rows = (await sql`
    select mint, launchpad_checked_at as "launchpadCheckedAt", launchpad_stage as "launchpadStage"
    from ledger_asset_catalogue
    where removed_from_catalogue_at is null
  `) as ClassificationCandidate[];
  const selected = selectMintsToClassify(
    rows.map((r) => ({ ...r, launchpadCheckedAt: r.launchpadCheckedAt ? new Date(r.launchpadCheckedAt).toISOString() : null })),
    { now, limit, bondingRecheckMs: BONDING_RECHECK_MS, fullRecheckMs: FULL_RECHECK_MS },
  );
  const result: ClassificationRunResult = { considered: rows.length, selected: selected.length, classified: 0, launchpadTokens: 0, failed: 0, byLaunchpad: {} };
  if (selected.length === 0) return result;

  const connection = new Connection(options.rpcUrl, "confirmed");
  const classify = options.classify ?? classifyMintsBatch;
  const mints: PublicKey[] = [];
  for (const m of selected) {
    try {
      mints.push(new PublicKey(m));
    } catch {
      result.failed++;
    }
  }
  const results = await classify(connection, mints);
  for (const [mint, r] of results) {
    if (r.error) {
      result.failed++;
      continue;
    }
    const cols = launchpadColumnsFor(r.provenance);
    await sql`
      update ledger_asset_catalogue set
        launchpad = ${cols.launchpad},
        launchpad_stage = ${cols.launchpadStage},
        launchpad_venue = ${cols.launchpadVenue},
        launchpad_evidence = ${cols.launchpadEvidence ? JSON.stringify(cols.launchpadEvidence) : null},
        launchpad_checked_at = now(),
        updated_at = now()
      where mint = ${mint}
    `;
    result.classified++;
    if (cols.launchpad) {
      result.launchpadTokens++;
      result.byLaunchpad[cols.launchpad] = (result.byLaunchpad[cols.launchpad] ?? 0) + 1;
    }
  }
  return result;
}
