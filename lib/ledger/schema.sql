-- SSR Ledger: acquisition-grade, normalized business-data layer.
-- Applied via scripts/migrate-ledger.mjs. Idempotent (IF NOT EXISTS) --
-- safe to re-run against Development/Preview/Production alike, and safe to
-- run before Mainnet exists at all (every table is cluster-scoped from day
-- one; DevNet rows and a future Mainnet's rows coexist in the same tables,
-- distinguished only by `cluster`, never mixed implicitly -- see
-- docs/protocol/LEDGER_ARCHITECTURE.md's "Source-of-truth rules").
--
-- This is ADDITIVE, alongside (not a replacement for) reserve_activity_log
-- (lib/reserve-activity/schema.sql), which keeps powering ManageDTR.tsx's
-- per-Reserve Activity tab and the /internal/kpis dashboard exactly as
-- before. `ledger_events` below is a separate, richer table purpose-built
-- for protocol-wide acquisition/due-diligence reporting and CSV export --
-- see docs/protocol/LEDGER_ARCHITECTURE.md for why these two tables both
-- exist rather than merging them.
--
-- Solana itself remains the sole source of truth for on-chain state
-- (principle 1 in the task this schema implements) -- every table here is
-- a DERIVED index, rebuildable from chain data (plus, for off-chain-only
-- facts like product analytics and deployment records, from this
-- project's own operational history). Nothing here is ever read by any
-- on-chain instruction or used to authorize a transaction (principle 3).

-- ============================================================================
-- A. Protocol deployments & upgrades
-- ============================================================================
-- One row per program deployment or upgrade. NOT derived from an on-chain
-- event (Solana's BPF Loader Upgradeable emits no event for this) --
-- populated from the same deployment records this project already keeps by
-- hand in docs/protocol/DEVNET_RUNBOOK.md / docs/project/DECISION_LOG.md.
-- `source='backfill'` rows were reconstructed from those documents;
-- `source='manual'` rows are entered going forward at deploy time (see
-- docs/protocol/LEDGER_ARCHITECTURE.md's "Ingestion architecture").
create table if not exists ledger_deployments (
  id                       bigserial primary key,
  cluster                  text not null,
  program_id               text not null,
  program_version          text,
  deployed_commit_hash     text,
  deployment_type          text not null check (deployment_type in ('initial', 'upgrade')),
  deploy_signature         text,
  program_data_address     text,
  data_length_bytes        bigint,
  upgrade_authority        text,
  protocol_admin_authority text,
  idl_version_hash         text,
  instruction_count        integer,
  deployed_at_utc          timestamptz not null,
  notes                    text,
  source                   text not null default 'manual' check (source in ('manual', 'ci', 'backfill')),
  recorded_at              timestamptz not null default now(),
  unique (cluster, program_id, deploy_signature)
);
create index if not exists ledger_deployments_cluster_ts_idx on ledger_deployments (cluster, deployed_at_utc desc);

-- ============================================================================
-- B. Reserves -- current normalized state, upserted by a sync job that reads
-- live on-chain discovery + ledger_events history. NOT authoritative (the
-- Reserve account on-chain always is) -- a cache/index optimized for
-- reporting, safe to fully rebuild at any time from chain + ledger_events.
-- ============================================================================
create table if not exists ledger_reserves (
  id                        bigserial primary key,
  cluster                   text not null,
  reserve                   text not null,
  reserve_id_onchain        bigint,
  program_id                text not null,
  reserve_token_mint        text,
  name                      text,
  ticker                    text,
  manager                   text,
  creator_wallet            text,
  lifecycle_status          text,
  created_at_utc            timestamptz,
  created_slot              bigint,
  create_signature          text,
  launch_completed_at_utc   timestamptz,
  wind_down_started_at_utc  timestamptz,
  closed_at_utc             timestamptz,
  last_synced_at            timestamptz not null default now(),
  last_nav_usd              numeric,
  last_aum_usd              numeric,
  last_supply_raw           text,
  last_holder_count         integer,
  last_asset_count          integer,
  total_target_weight_bps   integer,
  unique (cluster, reserve)
);
create index if not exists ledger_reserves_cluster_status_idx on ledger_reserves (cluster, lifecycle_status);
create index if not exists ledger_reserves_manager_idx on ledger_reserves (cluster, manager);

-- Delegate CURRENT state (who is a delegate on a Reserve right now, and with
-- what permissions) -- upserted from ledger_events' delegateAdded/
-- delegatePermissionsUpdated/delegateRemoved rows. Full delegate ACTIVITY
-- history lives in ledger_events itself (event_type in ('delegateAdded',
-- 'delegatePermissionsUpdated', 'delegateRemoved')), not duplicated here.
create table if not exists ledger_reserve_delegates (
  id                   bigserial primary key,
  cluster              text not null,
  reserve              text not null,
  delegate_wallet      text not null,
  permissions_bitmask  integer,
  restricted           boolean,
  active               boolean not null default true,
  added_at_utc         timestamptz,
  removed_at_utc       timestamptz,
  last_updated_at_utc  timestamptz not null default now(),
  unique (cluster, reserve, delegate_wallet)
);

-- ============================================================================
-- C. Reserve Asset catalogue -- current normalized state per mint, upserted
-- from Jupiter snapshots (see section 9 tables below) + on-chain
-- observation (whichever mints actually appear as a Reserve Asset).
-- ============================================================================
create table if not exists ledger_asset_catalogue (
  id                         bigserial primary key,
  mint                       text not null,
  symbol                     text,
  name                       text,
  decimals                   integer,
  token_program              text,
  jupiter_verified           boolean,
  jupiter_organic_score      numeric,
  jupiter_tags               text[],
  ssr_status                 text not null default 'unreviewed' check (ssr_status in ('supported', 'disabled', 'blocklisted', 'unreviewed')),
  incompatibility_reason     text,
  added_to_catalogue_at      timestamptz,
  removed_from_catalogue_at  timestamptz,
  first_seen_snapshot_id     bigint,
  last_seen_snapshot_id      bigint,
  updated_at                 timestamptz not null default now(),
  -- Launchpad provenance, verified ON-CHAIN by api/ledger/launchpad-classify-cron.ts
  -- (packages/sdk/src/launchpads.ts): where the mint was launched, whether it is
  -- still on its bonding curve, and the post-graduation venue. Informational
  -- only -- never consulted by the asset picker's eligibility gates.
  -- launchpad_checked_at null = never classified; non-null with launchpad null =
  -- verified as not from a supported launchpad. Added by scripts/migrate-launchpads.mjs.
  launchpad                  text check (launchpad in ('pump.fun', 'letsbonk.fun', 'bags.fm')),
  launchpad_stage            text check (launchpad_stage in ('bonding', 'graduated')),
  launchpad_venue            text check (launchpad_venue in ('pumpswap', 'raydium-cpmm', 'raydium-amm-v4', 'meteora-damm-v1', 'meteora-damm-v2')),
  launchpad_evidence         jsonb,
  launchpad_checked_at       timestamptz,
  -- Tokenised-asset issuer, proven ON-CHAIN by the mint's Token-2022
  -- PermanentDelegate (packages/sdk/src/issuers.ts), recorded by
  -- lib/ledger/markIncompatibleMints.ts in the same account read it already
  -- does. Informational: it labels and filters the picker, never decides
  -- eligibility. issuer_checked_at null = never classified; non-null with
  -- issuer null = verified as not from a known issuer. Added by
  -- scripts/migrate-issuers.mjs.
  issuer                     text check (issuer in ('xstocks')),
  issuer_checked_at          timestamptz,
  unique (mint)
);
create index if not exists ledger_asset_catalogue_status_idx on ledger_asset_catalogue (ssr_status);
create index if not exists ledger_asset_catalogue_launchpad_idx on ledger_asset_catalogue (launchpad);
create index if not exists ledger_asset_catalogue_issuer_idx on ledger_asset_catalogue (issuer);

-- ============================================================================
-- 9. Jupiter catalogue: weekly snapshots, so SSR can prove which assets were
-- available (and how they scored) on any given date. `raw_response_ref` is
-- a pointer (e.g. a content hash) not the full JSON payload -- Jupiter's
-- verified list can run into the thousands of mints; storing per-mint rows
-- in ledger_jupiter_snapshot_mints is the queryable form, the raw fetch is
-- not persisted verbatim in Postgres (see LEDGER_ARCHITECTURE.md's
-- reconciliation section for why, and where the raw fetch itself is kept).
-- ============================================================================
create table if not exists ledger_jupiter_snapshots (
  id                 bigserial primary key,
  snapshot_date_utc  date not null,
  fetched_at_utc     timestamptz not null default now(),
  source_url         text not null,
  mint_count         integer not null,
  raw_response_ref   text,
  unique (snapshot_date_utc)
);

create table if not exists ledger_jupiter_snapshot_mints (
  snapshot_id    bigint not null references ledger_jupiter_snapshots(id) on delete cascade,
  mint           text not null,
  symbol         text,
  organic_score  numeric,
  verified       boolean,
  primary key (snapshot_id, mint)
);
create index if not exists ledger_jupiter_snapshot_mints_mint_idx on ledger_jupiter_snapshot_mints (mint);

-- ============================================================================
-- D + E. Ledger events -- the core normalized table. One row per decoded
-- on-chain event (category='onchain') OR structured off-chain lifecycle
-- event (category='lifecycle', e.g. a multi-step Create-Reserve flow's
-- individual steps, which never emit a separate on-chain event of their
-- own) OR an operational event (category='operational', e.g. a webhook
-- failure or a deterministic-vs-transient Resume-Deployment failure
-- classification -- see createReserveResume.ts's classifyCreateReserveError,
-- already built and reused here, not reinvented).
--
-- `event_id` (see lib/ledger/eventId.ts) is DETERMINISTIC: re-decoding the
-- exact same signature+event always produces the exact same event_id, so
-- ingestion is naturally idempotent via the unique constraint below --
-- replaying, backfilling, or receiving the same webhook twice is always
-- safe (principle 5).
-- ============================================================================
create table if not exists ledger_events (
  id                        bigserial primary key,
  event_id                  text not null,
  cluster                   text not null,
  program_id                text not null,
  signature                 text,
  slot                      bigint,
  block_time_unix           bigint,
  event_ts_utc              timestamptz not null,
  event_date_utc            date not null,
  instruction_index         integer,
  inner_instruction_index   integer,
  event_index               integer,
  instruction_name          text,
  event_type                text not null,
  category                  text not null check (category in ('onchain', 'lifecycle', 'operational')),
  status                    text not null default 'confirmed' check (status in ('confirmed', 'failed', 'pending')),
  error_code                text,
  error_message             text,
  actor_wallet              text,
  actor_role                text,
  fee_payer                 text,
  reserve                   text,
  reserve_token_mint        text,
  reserve_asset_mint        text,
  source_account            text,
  destination_account       text,
  vault                     text,
  amount_raw                text,
  amount_decimals           integer,
  amount_normalized         numeric,
  amount_kind               text,
  usd_price_at_event        numeric,
  usd_price_source          text,
  usd_value_at_event        numeric,
  fee_amount_raw             text,
  fee_destination            text,
  protocol_revenue_raw       text,
  manager_revenue_raw        text,
  compute_units_consumed     bigint,
  network_fee_lamports       bigint,
  priority_fee_lamports      bigint,
  confirmation_status        text,
  summary                    text not null,
  ingestion_source           text not null check (ingestion_source in ('rpc-poll', 'helius-webhook', 'backfill', 'manual')),
  ingestion_ts               timestamptz not null default now(),
  decoder_version            integer not null default 1,
  raw_logs_ref               text,
  unique (event_id)
);
create index if not exists ledger_events_date_idx on ledger_events (cluster, event_date_utc);
create index if not exists ledger_events_reserve_idx on ledger_events (cluster, reserve, event_ts_utc);
create index if not exists ledger_events_type_idx on ledger_events (cluster, event_type);
create index if not exists ledger_events_actor_idx on ledger_events (cluster, actor_wallet) where actor_wallet is not null;
create index if not exists ledger_events_signature_idx on ledger_events (cluster, signature) where signature is not null;
create index if not exists ledger_events_sort_idx on ledger_events (cluster, slot, signature, instruction_index, event_index);
create index if not exists ledger_events_amount_kind_idx on ledger_events (amount_kind) where amount_kind is not null;
create index if not exists ledger_events_status_idx on ledger_events (cluster, status) where status <> 'confirmed';

-- ============================================================================
-- F. Product / user-funnel analytics -- privacy-conscious by construction.
-- Never stores IP addresses, device identifiers, or any browser fingerprint
-- by default (see docs/protocol/LEDGER_ARCHITECTURE.md's privacy policy) --
-- `session_id` is a random, client-generated, non-PII token; `wallet` is
-- only ever recorded once a wallet is actually connected (never a
-- fingerprint proxy for identity before that). A page refresh or an
-- anonymous page view is NEVER a `unique_wallet_session_started` row --
-- only an actual wallet-connect event counts toward wallet cohorts,
-- per the task's own explicit instruction.
-- ============================================================================
create table if not exists ledger_product_events (
  id              bigserial primary key,
  cluster         text not null,
  session_id      text not null,
  wallet          text,
  event_type      text not null,
  page            text,
  reserve         text,
  metadata        jsonb,
  occurred_at_utc timestamptz not null,
  event_date_utc  date not null,
  ingestion_ts    timestamptz not null default now(),
  unique (session_id, event_type, occurred_at_utc, page)
);
create index if not exists ledger_product_events_date_idx on ledger_product_events (cluster, event_date_utc);
create index if not exists ledger_product_events_wallet_idx on ledger_product_events (cluster, wallet) where wallet is not null;
create index if not exists ledger_product_events_session_idx on ledger_product_events (session_id);
create index if not exists ledger_product_events_type_idx on ledger_product_events (cluster, event_type);

-- ============================================================================
-- Daily rollups -- precomputed, point-in-time-accurate daily aggregates.
-- Exists because some facts (e.g. "AUM on 2026-06-01") are NOT reconstructable
-- by re-querying live chain state later -- they must be captured AS OF that
-- day. Refreshed once per UTC day (see api/ledger/rollup-cron.ts); recomputing
-- TODAY's row is always safe (upsert), recomputing a PAST day's row is only
-- ever done for an explicit, logged backfill/correction (never silently).
-- ============================================================================
create table if not exists ledger_daily_rollups (
  id                    bigserial primary key,
  cluster               text not null,
  rollup_date_utc       date not null,
  reserves_created      integer not null default 0,
  reserves_active_total integer not null default 0,
  mint_volume_raw       text not null default '0',
  redeem_volume_raw     text not null default '0',
  protocol_fee_raw      text not null default '0',
  manager_fee_raw       text not null default '0',
  tx_count              integer not null default 0,
  tx_failed_count       integer not null default 0,
  unique_wallets        integer not null default 0,
  new_wallets           integer not null default 0,
  computed_at           timestamptz not null default now(),
  is_backfilled         boolean not null default false,
  unique (cluster, rollup_date_utc)
);

-- ============================================================================
-- H. Operational incidents -- manually or semi-automatically recorded
-- (RPC outages, webhook failures, indexing-lag alerts, stale-data
-- incidents). Transaction-level failures do NOT need a separate row here --
-- they are ledger_events rows with status='failed'; this table is for
-- INCIDENTS (a bounded period of degraded service), not individual
-- failed transactions.
-- ============================================================================
create table if not exists ledger_incidents (
  id                bigserial primary key,
  cluster           text,
  incident_type     text not null,
  severity          text not null check (severity in ('low', 'medium', 'high', 'critical')),
  description       text not null,
  started_at_utc    timestamptz not null,
  resolved_at_utc   timestamptz,
  resolution_notes  text,
  affected_area     text,
  recorded_by       text,
  recorded_at       timestamptz not null default now()
);
create index if not exists ledger_incidents_open_idx on ledger_incidents (started_at_utc) where resolved_at_utc is null;

-- ============================================================================
-- Ingestion cursors -- generalized backfill/replay tracking per
-- cluster+program+source, mirroring reserve_activity_cursor's proven
-- pattern (lib/reserve-activity/schema.sql) but scoped protocol-wide
-- rather than per-Reserve, since ledger_events walks full program history,
-- not one Reserve's getSignaturesForAddress feed.
-- ============================================================================
create table if not exists ledger_ingestion_cursors (
  cluster                   text not null,
  program_id                text not null,
  source                    text not null,
  newest_signature_indexed  text,
  oldest_signature_indexed  text,
  backfill_complete         boolean not null default false,
  backfill_from_slot        bigint,
  last_run_at               timestamptz not null default now(),
  last_error                text,
  primary key (cluster, program_id, source)
);

-- ============================================================================
-- Reconciliation runs -- a log of every data-quality check execution and
-- its result, so "was this ever checked, and when" is itself answerable
-- (principle: data-quality controls must themselves be auditable).
-- ============================================================================
create table if not exists ledger_reconciliation_runs (
  id              bigserial primary key,
  cluster         text not null,
  check_name      text not null,
  run_at          timestamptz not null default now(),
  passed          boolean not null,
  details         jsonb,
  rows_checked    integer,
  issues_found    integer not null default 0
);
create index if not exists ledger_reconciliation_runs_check_idx on ledger_reconciliation_runs (cluster, check_name, run_at desc);
