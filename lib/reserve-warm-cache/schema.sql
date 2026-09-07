-- Reserve Warm Cache: a single pre-computed snapshot of the discoverable
-- Reserve set per cluster, refreshed by a self-warming cron
-- (api/mainnet/warm-cache-cron.ts) every ~15s EVEN WITH NO USERS, so the
-- homepage/Discover page can paint instantly from one cheap DB read instead
-- of each browser running the full on-chain discovery burst (the burst that
-- self-inflicted the rpc-proxy 429s -- see ssr-review/08-DEPLOY-INCIDENTS).
-- Applied via scripts/migrate-warm-cache.mjs. Idempotent (IF NOT EXISTS).
--
-- One row per cluster ('mainnet-beta' | 'devnet'). `snapshot` is the whole
-- payload the snapshot endpoint serves verbatim: the eligible
-- DiscoveredReserve[] plus the priceByMint map and resolved per-Reserve
-- metadata the client needs to build its DTRs with ZERO further RPC. Stored
-- as jsonb (queryable if ever needed; served as-is today). generated_at lets
-- the reader surface staleness rather than trust a snapshot blindly.

create table if not exists reserve_snapshot (
  cluster      text primary key,
  snapshot     jsonb not null,
  generated_at timestamptz not null default now()
);
