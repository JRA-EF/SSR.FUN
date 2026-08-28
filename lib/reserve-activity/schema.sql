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

-- KPI-dashboard support (docs/project/DECISION_LOG.md's entry for
-- /internal/kpis): structured amounts alongside the existing free-text
-- `summary`, so protocol-wide volume/fee aggregates can be computed with
-- real SQL instead of parsing summary strings. Nullable/additive -- every
-- row from before this migration, and every event kind with no primary
-- token amount (delegate/pause/metadata/lifecycle events), simply has
-- these as null. `amount_raw`/`amount_raw_2` are `text`, never a numeric
-- column: raw u64 Reserve Token amounts can exceed Postgres `bigint` in
-- pathological cases and must round-trip through JS as BigInt-safe decimal
-- strings, never a `number`, at every layer (see activityLog.ts's addBig).
-- See packages/sdk/src/activityLog.ts's ActivityAmountKind for the closed
-- set of values amount_kind/amount_kind_2 take.
alter table reserve_activity_log add column if not exists amount_raw text;
alter table reserve_activity_log add column if not exists amount_kind text;
alter table reserve_activity_log add column if not exists amount_raw_2 text;
alter table reserve_activity_log add column if not exists amount_kind_2 text;

create index if not exists reserve_activity_log_reserve_ts_idx
  on reserve_activity_log (reserve, ts desc);

create index if not exists reserve_activity_log_kind_ts_idx
  on reserve_activity_log (kind, ts);

create index if not exists reserve_activity_log_amount_kind_idx
  on reserve_activity_log (amount_kind) where amount_kind is not null;

create table if not exists reserve_activity_cursor (
  reserve                   text primary key,
  newest_signature_indexed  text,
  oldest_signature_indexed  text,
  backfill_complete         boolean not null default false,
  updated_at                timestamptz not null default now()
);

-- Cluster awareness (docs/project/DECISION_LOG.md DEC-0175): the activity
-- pipeline originally indexed DevNet only; the protocol has been live on
-- Mainnet since 2026-08-19 (DEC-0115), so every row now records WHICH
-- cluster it was indexed from. Additive and defaulted to 'devnet' because
-- every pre-existing row genuinely came from DevNet indexing. A Reserve
-- address exists on exactly one cluster in practice (distinct programs,
-- distinct PDAs), so the existing (reserve, signature, kind) uniqueness and
-- the reserve primary key stay correct as-is; `cluster` is a queryable tag,
-- not a new identity component. Values: 'devnet' | 'mainnet-beta'.
alter table reserve_activity_log add column if not exists cluster text not null default 'devnet';
alter table reserve_activity_cursor add column if not exists cluster text not null default 'devnet';

create index if not exists reserve_activity_log_cluster_idx
  on reserve_activity_log (cluster);
