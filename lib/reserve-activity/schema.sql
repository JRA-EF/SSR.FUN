-- Reserve Activity Log: persistent index of every governance/management
-- event a Reserve has ever emitted on-chain, so ManageDTR.tsx's Activity
-- tab can read from Postgres instead of walking live RPC on every view
-- (see docs/project/DECISION_LOG.md's entry for this pass). Applied via
-- scripts/migrate-reserve-activity.mjs. Idempotent (IF NOT EXISTS) so it is
-- safe to re-run against Development/Preview/Production alike.
--
-- One row per decoded event (a single transaction can emit several, e.g.
-- Submit Rebalance's batched add_reserve_asset_active x N + update_targets),
-- deduped by (reserve, signature, kind). reserve_activity_cursor tracks
-- per-Reserve indexing progress so backfill is resumable across requests --
-- a single request never scans a Reserve's full history in one call.

create table if not exists reserve_activity_log (
  id          bigserial primary key,
  reserve     text not null,
  signature   text not null,
  kind        text not null,
  ts          bigint not null,
  actor       text,
  summary     text not null,
  indexed_at  timestamptz not null default now(),
  unique (reserve, signature, kind)
);

create index if not exists reserve_activity_log_reserve_ts_idx
  on reserve_activity_log (reserve, ts desc);

create table if not exists reserve_activity_cursor (
  reserve                   text primary key,
  newest_signature_indexed  text,
  oldest_signature_indexed  text,
  backfill_complete         boolean not null default false,
  updated_at                timestamptz not null default now()
);
