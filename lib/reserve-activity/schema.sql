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

-- Per-event identity + frozen USD valuation (DEC-0176). event_index is the
-- 0-based ordinal of an event among SAME-KIND events within one transaction:
-- one transaction genuinely emits the same kind several times (live-proven
-- on Mainnet: 5x ReserveAssetInitialized per create-Reserve transaction),
-- and the original (reserve, signature, kind) uniqueness silently collapsed
-- them (83 real events -> 25 rows). The old 3-column constraint is replaced
-- by the 4-column unique index below; pre-existing rows keep event_index 0
-- (each was the first-of-kind row the old dedup kept, re-walks fill in the
-- rest idempotently). amount_usd/amount_usd_2 are the USD value of
-- amount_raw/amount_raw_2 AT INDEXING TIME -- written once, never re-priced
-- (see indexer.ts's on-conflict), null when genuinely unpriceable.
alter table reserve_activity_log add column if not exists event_index integer not null default 0;
alter table reserve_activity_log add column if not exists amount_usd double precision;
alter table reserve_activity_log add column if not exists amount_usd_2 double precision;
alter table reserve_activity_log drop constraint if exists reserve_activity_log_reserve_signature_kind_key;
create unique index if not exists reserve_activity_log_reserve_sig_kind_ordinal_key
  on reserve_activity_log (reserve, signature, kind, event_index);

-- Per-recipient USDC fee payouts (DEC-0206). A feeUsdcDistributed event
-- pays several Manager fee recipients in ONE transaction; amount_usd_2 only
-- holds the Manager-side total, so the Manage page could not show what each
-- recipient actually received. `payouts` stores the event's own
-- managerRecipients/managerAmounts as [{"wallet": <base58>, "usdcRaw":
-- <u64 string>}] -- exact on-chain USDC, never derived from the routing
-- split (which can change between payouts). Null for every other kind and
-- for feeUsdcDistributed rows indexed before this column existed; those are
-- healed lazily by lib/reserve-activity/feePayouts.ts from the stored
-- signature, never by re-walking a Reserve's history.
alter table reserve_activity_log add column if not exists payouts jsonb;

create index if not exists reserve_activity_log_fee_payouts_idx
  on reserve_activity_log (reserve, cluster) where kind = 'feeUsdcDistributed';
