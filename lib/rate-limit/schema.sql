-- Durable, cross-instance rate-limit counter.
--
-- Why this exists: the in-memory limiter in api/devnet/_lib/rateLimit.ts is a
-- module-scope Map, so on Vercel it is per-warm-instance and resets on cold
-- start. That is fine as a cheap L1 (it blunts a single client hammering ONE
-- instance) but it can NOT enforce a genuinely global limit -- e.g. the
-- sendTransaction "global" budget, which a burst spread across N instances
-- silently multiplies by N. This table gives those specific, low-volume,
-- must-be-global limits a shared backend without adding any new infra
-- dependency (reuses DATABASE_URL / @neondatabase/serverless).
--
-- NOT used for the hot per-request read path -- a DB round-trip on every RPC
-- read would be an anti-pattern. Read-volume protection belongs at the edge
-- (Vercel WAF) and at Helius's own API-key-scoped quota.
CREATE TABLE IF NOT EXISTS rate_limit_window (
  key           text   PRIMARY KEY,
  window_start  bigint NOT NULL,   -- epoch millis at which the current window opened
  count         integer NOT NULL   -- requests recorded in the current window
);
