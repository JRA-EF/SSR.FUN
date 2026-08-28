-- Reserve Image Store: permanent off-chain storage for a Reserve's profile
-- picture, referenced from the Reserve Metadata Store payload's `imageUrl`
-- field (lib/reserve-metadata/payload.ts) -- the picture itself never goes
-- on-chain or into the metadata JSON (MAX_PAYLOAD_JSON_BYTES = 4000 could
-- never hold one). Applied via scripts/migrate-reserve-image.mjs.
-- Idempotent (IF NOT EXISTS) so it is safe to re-run against
-- Development/Preview/Production alike.
--
-- `id` is a deterministic content hash (see lib/reserve-image/payload.ts's
-- computeImageId) -- identical image bytes always reuse the same row/URL,
-- so a retried upload can never create a duplicate row or a different URL
-- for the same content; the insert itself is `on conflict (id) do nothing`.
-- `data_base64` is text, not bytea: the Neon HTTP driver speaks JSON, and
-- the API decodes to real bytes only when serving.

create table if not exists reserve_image (
  id            text primary key,
  content_type  text not null,
  data_base64   text not null,
  created_at    timestamptz not null default now()
);

-- Mutable pointer from a Reserve's on-chain address to the reserve_image
-- row currently shown as its profile picture. This is what makes picture
-- changes possible WITHOUT an on-chain update_metadata transaction (no
-- wallet signature): the stored images stay content-addressed and
-- immutable; only this pointer moves. Cluster-agnostic like reserve_image
-- itself -- a DevNet and a Mainnet Reserve can never share an address, so
-- one table serves both route pairs.
create table if not exists reserve_image_pointer (
  reserve     text primary key,
  image_id    text not null,
  updated_at  timestamptz not null default now()
);
