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
