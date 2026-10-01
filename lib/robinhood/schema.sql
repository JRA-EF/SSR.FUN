-- Robinhood Chain asset catalogue (lib/robinhood/catalogue.ts). Applied by
-- scripts/migrate-robinhood-catalogue.mjs (idempotent). Same Neon database
-- as everything else (DATABASE_URL).

-- Every Uniswap v3 pool on Robinhood Chain that pairs a token with USDG or
-- WETH, from the factory's PoolCreated logs. `quote` names the side the
-- token is priced in; `token` is the other side.
create table if not exists robinhood_catalogue_pools (
  pool            text primary key,
  token           text not null,
  quote           text not null check (quote in ('USDG', 'WETH')),
  fee             integer not null,
  created_block   bigint not null,
  liquidity       numeric,
  quote_balance   numeric,
  sqrt_price_x96  text,
  updated_at      timestamptz
);
create index if not exists robinhood_catalogue_pools_token_idx on robinhood_catalogue_pools (token);

-- One row per token ever seen in such a pool, with its classification
-- (lib/robinhood/catalogueRules.ts) and the pool it is priced and bought
-- through. `eligible` is what api/robinhood/asset-catalogue.ts serves.
create table if not exists robinhood_asset_catalogue (
  address            text primary key,
  name               text,
  symbol             text,
  display_name       text,
  decimals           integer,
  code_hash          text,
  issuer             text check (issuer in ('robinhood')),
  pool_address       text,
  pool_fee           integer,
  pool_quote         text check (pool_quote in ('USDG', 'WETH')),
  depth_usd          numeric,
  price_usd          numeric,
  eligible           boolean not null default false,
  ineligible_reason  text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create index if not exists robinhood_asset_catalogue_eligible_idx on robinhood_asset_catalogue (eligible);

-- Where the scan is up to, and the last ETH/USD mark (singleton row).
create table if not exists robinhood_catalogue_state (
  id                  integer primary key check (id = 1),
  last_scanned_block  bigint not null,
  weth_usd            numeric,
  updated_at          timestamptz not null default now()
);
