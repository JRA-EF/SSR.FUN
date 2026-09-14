-- Reserve NAV History: the server-side, shared price history behind every
-- Reserve's Price History chart, 24h/7d/all-time performance figures, and
-- the all-time P&L shown next to Token Price (docs/project/DECISION_LOG.md's
-- entry for this pass). Root cause it fixes: a Reserve's priceHistory used
-- to live only in each browser (and on Mainnet was never even persisted
-- across reloads), so every visitor's chart started flat at the current NAV
-- and "All" / all-time performance sat at +0.00% forever -- even for a
-- Reserve whose underlying assets were up >1000% (the 2026-08-28 DELTA
-- report, and the 2026-09-14 BETA report that triggered this pass).
--
-- One row per recorded NAV observation per Reserve, appended by
-- api/mainnet/warm-cache-cron.ts on its ~15s self-warming refresh, throttled
-- (see lib/reserve-nav-history/navMath.ts's shouldRecordNavPoint) so a
-- quiet Reserve records one point per NAV_RECORD_MIN_INTERVAL and a moving
-- one records every genuine move. NAV = (sum of vault balances x validated
-- USD price) / Reserve Token supply -- exactly the Token Price the app
-- displays (there is no secondary market; Token Price IS NAV). Never
-- client-supplied: the cron prices every asset itself through the same
-- Jupiter/Pyth layer the snapshot uses. Applied via
-- scripts/migrate-nav-history.mjs. Idempotent (IF NOT EXISTS).

create table if not exists reserve_nav_history (
  id       bigserial primary key,
  cluster  text not null,
  reserve  text not null,
  t        timestamptz not null,
  nav_usd  double precision not null,
  source   text not null default 'warm-cache-cron'
);

create index if not exists reserve_nav_history_cluster_reserve_t_idx
  on reserve_nav_history (cluster, reserve, t);
