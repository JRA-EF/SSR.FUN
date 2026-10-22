-- DEX volume of SSR-created Raydium CPMM pools (DEC-0254). Applied via
-- scripts/migrate-dex-volume.mjs. Idempotent (IF NOT EXISTS).
--
-- Kept apart from reserve_activity_log on purpose: mint/redeem volume is
-- SSR's own primary market, swaps here are secondary-market trades between
-- holders. KPIs report them as separate figures and only the homepage adds
-- them together.

-- One row per SSR pool, refreshed by the daily sweep from the on-chain
-- LiquidityRevenue registrations (the marker that SSR created the pool).
create table if not exists dex_pools (
  pool          text primary key,
  cluster       text not null default 'mainnet-beta',
  reserve       text not null,
  reserve_mint  text not null,
  usdc_vault    text not null,
  token_vault   text not null,
  usdc_is_0     boolean not null,
  newest_signature text,
  updated_at    timestamptz not null default now()
);

-- One row per swap. usdc_raw is the USDC leg (6 decimals): the pools are all
-- USDC-paired, so it is the exact USD volume with no price lookup.
-- side: 'in' = USDC went into the pool (Reserve Tokens bought), 'out' = USDC
-- left the pool (Reserve Tokens sold).
create table if not exists dex_pool_swaps (
  pool       text not null,
  signature  text not null,
  cluster    text not null default 'mainnet-beta',
  reserve    text not null,
  ts         bigint not null,
  side       text not null,
  usdc_raw   bigint not null,
  token_raw  bigint not null,
  indexed_at timestamptz not null default now(),
  primary key (pool, signature)
);

create index if not exists dex_pool_swaps_reserve_idx on dex_pool_swaps (reserve);
create index if not exists dex_pool_swaps_ts_idx on dex_pool_swaps (ts);
