-- Reserve Asset Entry Price Store: the USD price each reserve asset had at
-- the moment it was first seen inside a Reserve -- the fixed "entry" side of
-- the Reserve Composition card's per-asset P&L (current price vs. price when
-- the asset was added). Captured SERVER-SIDE only (api/mainnet/
-- reserve-entry-prices.ts prices the mint itself through the same validated
-- Pyth/Jupiter hierarchy as api/mainnet/asset-prices.ts) -- a client can
-- request that a pair be captured but can never supply the price.
--
-- Rows are write-once (`on conflict do nothing`): an entry price is a
-- historical fact and never moves. A brand-new Reserve's assets are captured
-- within one discovery poll (~15s) of the Reserve first appearing, so the
-- stored price is effectively the launch-time price; an asset added later by
-- a manager is captured the same way when it first appears. Reserves that
-- predate this table get their first-observed price as a baseline.
--
-- Cluster-agnostic like reserve_image_pointer (a DevNet and a Mainnet
-- Reserve can never share an address), though only the Mainnet API writes
-- here today -- DevNet's fixture prices never move, so it has no entry-price
-- concept worth storing. Applied via scripts/migrate-entry-prices.mjs.

create table if not exists reserve_asset_entry_price (
  reserve          text not null,
  mint             text not null,
  entry_price_usd  double precision not null,
  source           text not null,
  captured_at      timestamptz not null default now(),
  primary key (reserve, mint)
);
