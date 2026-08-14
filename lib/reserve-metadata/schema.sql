-- Reserve Metadata Store: permanent off-chain storage for a Reserve's
-- name/ticker/description/category/buyTaxPct/sellTaxPct JSON payload, so
-- Create Reserve can submit a short, permanent HTTPS URL on-chain
-- (Reserve.metadata_uri) instead of embedding the JSON directly -- which
-- routinely exceeded the on-chain MAX_METADATA_URI_LEN (200 bytes),
-- producing SsrError::MetadataUriTooLong. See
-- docs/project/DECISION_LOG.md's entry for this fix. Applied via
-- scripts/migrate-reserve-metadata.mjs. Idempotent (IF NOT EXISTS) so it is
-- safe to re-run against Development/Preview/Production alike.
--
-- `id` is a deterministic content hash (see
-- lib/reserve-metadata/payload.ts's computeMetadataId) -- identical
-- metadata content always reuses the same row/URL, so a retried upload
-- (a network hiccup mid-submit, or a resumed Reserve-creation attempt) can
-- never create a duplicate row or a different URL for the same content;
-- the insert itself is `on conflict (id) do nothing`.

create table if not exists reserve_metadata (
  id          text primary key,
  payload     jsonb not null,
  created_at  timestamptz not null default now()
);
