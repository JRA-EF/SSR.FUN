<!--
  SSR Ledger: acquisition-grade business-data layer.
  Source code: lib/ledger/*.ts, api/ledger/*.ts, lib/ledger/schema.sql.
  This document is the canonical reference for everything about it --
  event taxonomy, data dictionary, ingestion architecture, backfill,
  daily export format, retention, privacy, security exclusions,
  reconciliation, disaster recovery, and acquisition/due-diligence
  reporting. See docs/project/DECISION_LOG.md for the confirmed decision
  this implements and the full list of what's built vs. designed-only.
-->

# SSR Ledger Architecture

## 0. Why this exists, and what it is not

Creator asked for a complete, acquisition-grade Mainnet data and analytics
system, replacing a CSV export that was too thin to answer real business
questions (only 56 rows, every one of them with a null amount field, no
structured revenue/volume/USD data, no daily partitioning). This document
covers the **SSR Ledger** -- `lib/ledger/`, `api/ledger/`, and the
`ledger_*` Postgres tables -- built to close that gap.

**What the Ledger is:** a durable, normalized, queryable index of
everything material that happens through SSR.fun -- on-chain events,
structured lifecycle steps, and (where wired up) product/operational
signals -- derived from chain data and this project's own operational
history.

**What the Ledger is NOT:**
- **Not a source of truth.** Solana remains the sole source of truth for
  on-chain state (principle 1). Every `ledger_*` table is a derived,
  rebuildable index. If a Ledger row and the chain ever disagree, the chain
  is right and the Ledger row is a bug to fix, never the reverse.
- **Not authoritative for protocol behavior.** No instruction, no
  transaction-building code, and no fee/eligibility decision anywhere in
  this codebase reads from `ledger_*` tables (principle 3). A Ledger outage
  degrades reporting, never the protocol itself.
- **Not a replacement for `reserve_activity_log`** (`lib/reserve-activity/`).
  That table keeps powering ManageDTR.tsx's per-Reserve Activity tab and
  `/internal/kpis` exactly as before -- see section 3 below for why both
  exist.

## 1. Entity relationships (ERD, text form)

```
ledger_deployments (A)              ledger_reserves (B) ----< ledger_reserve_delegates
  [one row per program                  |  ^                     (current delegate state)
   deploy/upgrade,                      |  |
   off-chain-sourced]                   |  +--- derived/upserted from ledger_events
                                         |       (event_type = reserveCreated, etc.)
                                         v
ledger_asset_catalogue (C) ----< ledger_jupiter_snapshot_mints >---- ledger_jupiter_snapshots
  [current state per mint]              (per-snapshot mint rows)      [one row per UTC week]

ledger_events (D + E)  <--------- the core table. Every row optionally
  |                                references a `reserve` (text address,
  |                                not a foreign key -- Reserves are
  |                                identified by their on-chain address,
  |                                which predates any row existing for them).
  +--> derives ledger_reserves' current state (a sync job reads ledger_events'
  |    history + live discovery to keep ledger_reserves accurate)
  +--> derives ledger_daily_rollups (a daily job aggregates the day's rows)
  +--> feeds lib/ledger/reconciliation.ts's data-quality checks

ledger_product_events (F)           ledger_incidents (H)
  [independent -- session/wallet       [independent -- manually/semi-
   funnel signals, never joined         automatically recorded incidents,
   to ledger_events by foreign key,     never individual tx failures --
   only by shared `wallet`/`reserve`    those are ledger_events rows with
   text values for reporting joins]     status='failed']

ledger_ingestion_cursors            ledger_reconciliation_runs
  [backfill/replay progress             [audit log of every data-quality
   per cluster+program+source]           check ever run, pass or fail]
```

None of these are Postgres foreign keys to on-chain addresses (Reserve,
mint, wallet) -- those are plain `text` columns, matching the reality that
the authoritative record for "does this Reserve exist" is the chain, not
this database. `ledger_jupiter_snapshot_mints.snapshot_id` IS a real
foreign key to `ledger_jupiter_snapshots.id`, since both sides are
Ledger-native records with no chain equivalent.

## 2. Source-of-truth rules

1. **On-chain account state and confirmed transactions** are authoritative
   for protocol facts (a Reserve's manager, its Reserve Token supply, its
   lifecycle status). `ledger_reserves`/`ledger_asset_catalogue` are
   caches of this, refreshed by sync jobs, safe to fully truncate and
   rebuild at any time.
2. **`ledger_events`** is authoritative for *the Ledger's own historical
   record of what it has observed* -- it is append-only in practice
   (rows are only ever inserted, via `on conflict (event_id) do nothing`,
   never updated in place by ingestion) but it is itself a derived index
   of chain data, re-derivable from a full backfill.
3. **Off-chain-only facts** (deployment records, product analytics,
   operational incidents) have no on-chain equivalent at all -- the Ledger
   IS their source of truth, sourced from this project's own operational
   history (deploy logs, `DECISION_LOG.md`, frontend instrumentation).
4. **A Ledger row's `summary` field is never authoritative for a business
   fact already present in a structured column.** `summary` exists for
   human readability only (requirement 5's "must never require parsing the
   free-text summary to reconstruct business facts").

## 3. Why `reserve_activity_log` AND `ledger_events` both exist

| | `reserve_activity_log` (`lib/reserve-activity/`) | `ledger_events` (`lib/ledger/`) |
|---|---|---|
| Purpose | Per-Reserve Activity tab (ManageDTR.tsx) + `/internal/kpis` | Protocol-wide acquisition/due-diligence reporting + CSV export |
| Scope | One Reserve's `getSignaturesForAddress` feed | The whole program's `getSignaturesForAddress` feed |
| Schema | `kind`/`summary` + 4 bolt-on amount columns | Full normalized schema (slot, instruction index, actor role, USD valuation, compute units, fee, confirmation status, ...) |
| Cluster-aware | No (implicitly DevNet) | Yes, explicit `cluster` column on every row |
| Failed transactions | Skipped | Recorded (`status='failed'`) |

They are **not** merged into one table because merging would force
ManageDTR.tsx's simple, already-shipped Activity tab to either adopt the
full Ledger schema (unnecessary complexity for a UI that only needs
kind/summary/actor/amount) or force the Ledger to inherit
`reserve_activity_log`'s per-Reserve-only walk (which cannot answer
protocol-wide questions). Both tables decode the SAME underlying events via
the SAME `summarizeActivityEvent` (`packages/sdk/src/activityLog.ts`), so
they never disagree about what an event *means* -- only about what else
gets recorded alongside it.

## 4. Event taxonomy

### 4.1 On-chain events (`category = 'onchain'`)

Every one of `ssr_protocol`'s 30 Anchor events (`programs/ssr_protocol/src/events.rs`),
decoded by `summarizeActivityEvent`. As of this pass, 28 of 30 are handled
(`ProtocolInitialized`/`ProtocolConfigUpdated` are Protocol-wide, not tied
to any Reserve PDA, and structurally never appear in a program-scoped
`getSignaturesForAddress` walk in the first place -- they need a SEPARATE,
not-yet-built ingestion path keyed on the `ProtocolConfig` account
specifically; see section 11's gap list).

| `event_type` | What it represents | `amount_kind` |
|---|---|---|
| `reserveCreated` | A Reserve account initialized | -- |
| `reserveAssetInitialized` | A Reserve Asset registered at creation | -- |
| `reserveSeeded` | Initial mint (creator's first deposit) | `mintVolume` |
| `reserveTokensMinted` | A Buy (mint) | `mintVolume` |
| `reserveTokensRedeemed` | A Sell (redemption) | `redeemVolume` |
| `protocolMintFeeTransferred` | Instant Protocol fee transfer (post-DEC-0101 path) | `protocolFee` |
| `tvlFeeSettled` | Weekly TVL fee settlement (two-sided: protocol + manager) | `protocolFee` + `managerFee` |
| `managerFeeRecipientsConfigured` | Fee-routing change | -- |
| `managerFeeShareAccrued` | Manager fee accrual (revenue realized) | `managerFee` |
| `managerFeeShareCollected` | Manager fee claim (NOT new revenue -- see below) | `managerFeeClaimed` |
| `feesAccrued` | Legacy combined accrual (pre-multi-recipient path) | `managerFee` + `protocolFee` |
| `delegateAdded` / `delegatePermissionsUpdated` / `delegateRemoved` | Co-Manager lifecycle | -- |
| `targetsUpdated` | Target-weight change | -- |
| `reserveAssetAdded` / `reserveAssetFunded` / `reserveAssetRemoved` | Composition management | -- |
| `windDownInitiated` / `reserveClosed` | Terminal lifecycle | -- |
| `reservePaused` / `reserveUnpaused` | Emergency pause | -- |
| `feesCollected` | Legacy pre-DEC-0094 fee collection | -- |
| `rebalanceRecorded` / `rebalanceLegExecuted` | Rebalance activity | -- |
| `metadataUpdated` | Reserve metadata change | -- |
| `reserveManagerTransferred` | Manager transfer | -- |
| `protocolFeeCollected` | Legacy manual Protocol fee collection | `protocolFee` |

**`managerFeeShareCollected` is deliberately tagged `managerFeeClaimed`, not
`managerFee`** -- collecting an already-accrued balance moves it into a
wallet, it is not NEW revenue. Counting both would double-count real
revenue in every report. Similarly, `protocolMintFeeTransferred` /
`tvlFeeSettled` / `protocolFeeCollected` are all tagged `protocolFee`
despite covering different code paths (instant-transfer vs. legacy manual
collection), because a given Reserve is only ever on ONE of those paths at
a time -- no double count is possible there.

### 4.2 Lifecycle events (`category = 'lifecycle'`)

Structured, off-chain-originated steps that never emit their own on-chain
event (a multi-step Create-Reserve flow's individual steps happen entirely
client-side/server-side before or between transactions). **Schema and
`buildEventId` support for this category are implemented; the actual
INGESTION calls (the frontend/API code that would call
`buildEventId({kind:'lifecycle', ...})` at each step) are NOT wired up in
this pass** -- see section 11.

| `event_type` | Represents |
|---|---|
| `launchStarted` | Create Reserve flow entered |
| `launchStepStarted` / `launchStepCompleted` | Each step of the create/seed flow |
| `launchResumed` | Resume Deployment clicked (reuses `createReserveResume.ts`'s existing, already-tested `determineDeploymentResumePoint`/`classifyCreateReserveError`) |
| `launchCompleted` / `launchFailed` | Terminal launch outcome |
| `deploymentAbandoned` | "Cancel Deploy" clicked (DEC-0107) |

### 4.3 Operational events (`category = 'operational'`)

Ingestion/infrastructure-level facts. **Schema implemented; automated
population NOT wired up** (would need webhook/RPC-provider integration --
see section 11).

| `event_type` | Represents |
|---|---|
| `webhookDeliveryFailed` | A Helius webhook delivery failed (if/when webhooks are adopted -- see section 11) |
| `rpcRequestFailed` | An RPC call exhausted retries |
| `backfillSweepCompleted` | A `ingestProgramEvents`/`runWeeklyJupiterSnapshot` run finished (currently returned as the cron's JSON response, not yet also written as a `ledger_events` row) |

## 5. Data dictionary -- `ledger_events` (the core table)

See `lib/ledger/schema.sql` for the authoritative column list with SQL
types/constraints. Field-by-field notes for anything non-obvious:

| Column | Notes |
|---|---|
| `event_id` | Deterministic (`lib/ledger/eventId.ts`) -- see section 6 |
| `cluster` | `'devnet'` \| `'mainnet-beta'` -- never inferred, always explicit |
| `slot`, `block_time_unix` | Raw chain values, straight from `getTransaction()` |
| `event_ts_utc`, `event_date_utc` | Derived from `block_time_unix`; `event_date_utc` is what every date filter/export operates on |
| `instruction_index`, `inner_instruction_index`, `event_index` | Together make an event within one transaction uniquely orderable -- `event_index` specifically disambiguates multiple events of the type within one instruction (e.g. a batched Rebalance) |
| `status` | `'confirmed'` \| `'failed'` -- a failed TRANSACTION's events are still recorded, tagged failed, never silently dropped |
| `actor_role` | Best-effort classification (`lib/ledger/amounts.ts`'s `classifyActorRole`) -- `'unknown'` is an honest gap, never guessed |
| `amount_raw` | Decimal STRING, never a JS `number` -- real u64 amounts exceed `Number.MAX_SAFE_INTEGER` |
| `amount_kind` | One of `mintVolume` \| `redeemVolume` \| `protocolFee` \| `managerFee` \| `managerFeeClaimed`, or null |
| `usd_price_source` | One of `devnet-fixed-test-price` \| `pyth` \| `reserve-token-nav-approximation` \| `unavailable` -- `unavailable` means every USD field is null, NEVER a fabricated number |
| `ingestion_source` | `'rpc-poll'` \| `'helius-webhook'` \| `'backfill'` \| `'manual'` -- data lineage, per requirement 8 |
| `decoder_version` | Bumped whenever `summarizeActivityEvent`'s decoding logic changes in a way that could affect already-ingested rows -- lets a future reconciliation pass find and re-decode stale rows (see section 9's "amount backfill" note) |

## 6. Deterministic event IDs (`lib/ledger/eventId.ts`)

`event_id` for an on-chain event is the plain string:

```
onchain:<cluster>:<signature>:<eventType>:<instructionIndex>:<innerInstructionIndex>:<eventIndex>
```

Deliberately a readable concatenation, not a hash -- every input that makes
two events distinct is already visible in the ID. Re-decoding the exact
same signature+event always produces the exact same ID, which is what
makes `insert ... on conflict (event_id) do nothing` (in
`lib/ledger/ingest.ts`) naturally idempotent: replaying a webhook,
re-running a backfill sweep, or receiving the same event from two
different ingestion sources all collapse to one row. Tested in
`tests/phase_ledger.ts`.

## 7. Ingestion architecture

```
Solana RPC (getSignaturesForAddress + getTransaction)
        |
        v
lib/ledger/ingest.ts (ingestProgramEvents)
  -- walks the PROGRAM's own transaction history (getSignaturesForAddress
     against the program ID itself returns every tx that invoked it),
     decodes every event via the SAME EventParser + summarizeActivityEvent
     packages/sdk/src/activityLog.ts already uses, enriches with
     slot/blockTime/computeUnits/fee via lib/ledger/decodeEvent.ts,
     upserts into ledger_events.
  -- Bounded per call (never one unbounded scan), resumable via
     ledger_ingestion_cursors (mirrors lib/reserve-activity's proven
     per-Reserve cursor pattern, generalized to program-wide scope).
  -- Walks BOTH successful and FAILED transactions (unlike
     reserve_activity_log's indexer, which skips failed ones) -- failed
     attempts are exactly what sections E/H need.
        |
        v
api/ledger/ingest-cron.ts -- scheduled daily sweep (vercel.json's crons),
  CRON_SECRET-gated like accrue-fees-cron.ts/kpis-backfill-cron.ts.
```

**Data collection never blocks or alters an on-chain transaction**
(principle 4) -- `ingestProgramEvents` only ever READS confirmed chain
state via RPC; it has no code path that could affect what a user's wallet
signs or what the program executes.

**Not yet wired up in this pass:** a Helius webhook receiver (would let
ingestion react to new transactions in near-real-time instead of only via
the daily cron poll) and LaserStream. The schema (`ingestion_source =
'helius-webhook'`) and the idempotent-by-event-ID design already
anticipate this -- adding it later is additive, not a redesign. See
section 11.

## 8. Backfill process

`api/ledger/ingest-cron.ts?dryRun=true` (or the scheduled cron itself) can
be called repeatedly; each call resumes from `ledger_ingestion_cursors`
rather than re-walking already-indexed history. A full backfill of a
program's ENTIRE history is simply "keep calling this until
`backfill_complete` is true" -- the exact same resumable-sweep philosophy
`lib/reserve-activity/backfillAll.ts` already validated in production
(DEC-0107).

**Mainnet backfill, specifically:** requirement 11 asks for backfill "from
the Mainnet program's deployment slot onward." `ingestProgramEvents`
currently walks backward from the newest transaction with no slot floor --
for Mainnet, add a `backfill_from_slot` check (the column already exists
on `ledger_ingestion_cursors` for this) so the sweep stops exactly at the
deployment slot rather than walking past it into nonexistent pre-deployment
history. This is a small, well-scoped addition once a real Mainnet
deployment slot exists to backfill from -- not built yet, since no Mainnet
deployment exists yet.

**DevNet and Mainnet are never mixed.** Every table has an explicit
`cluster` column; every query in `lib/ledger/query.ts` and
`lib/ledger/reconciliation.ts` takes `cluster` as a required parameter,
never a default that could silently blend the two. DevNet's existing
history remains permanently queryable (`cluster='devnet'`) as testing/
operational evidence, unaffected by Mainnet's eventual onboarding.

## 9. Daily export format (requirement 5)

`GET /api/ledger/export?cluster=<devnet|mainnet-beta>` plus one of:

- `&date=YYYY-MM-DD` -- exact UTC calendar date
- `&from=YYYY-MM-DD&to=YYYY-MM-DD` -- inclusive UTC date range
- (neither) -- complete historical export for that cluster

Returns CSV, streamed (never buffers the whole export in memory), one row
per structured event (never one row per free-text summary), with the
stable 44-column header defined in `lib/ledger/csv.ts`'s
`LEDGER_EVENT_CSV_COLUMNS` (append-only -- a column is never removed or
reordered once shipped). `event_date_utc` is a dedicated column on every
row. Sort order is always deterministic: `slot, signature,
instruction_index, event_index` (requirement 5's explicit sort spec).

**Known current limitation, honestly stated:** the schema/decoder amount
fields were only added this session (DEC-0107/this pass) -- rows ingested
under an OLDER `decoder_version` before a given field existed will show
that field as null even though the event TYPE is one this decoder now
knows how to enrich. `ON CONFLICT DO NOTHING` means re-running ingestion
does not retroactively fill these in. A one-time "re-decode rows below the
current `decoder_version`" backfill pass is a designed-but-not-yet-built
follow-up (tracked via the `decoder_version` column existing specifically
to make that pass targeted rather than a full re-scan).

## 10. Reporting views / queries (requirement 6)

Implemented as on-demand SQL in `lib/ledger/query.ts`
(`getDailyTotals`) and `lib/ledger/reconciliation.ts`, rather than a fixed
set of pre-built dashboard pages -- the KPI dashboard (`/internal/kpis`,
DEC-0107) already covers protocol-wide volume/fees/lifecycle/leaderboard
reporting from `reserve_activity_log`; extending it (or building a
parallel `/internal/ledger` page) to read from `ledger_events` instead,
once it's populated with real Mainnet history, is a small follow-up, not a
new design. The queries requirement 6 lists (active-wallet cohorts,
funnel conversion, retention, concentration, cohort analysis) are
achievable as further SQL against `ledger_events` +
`ledger_product_events` once product-event ingestion (section 11's gap) is
actually collecting session/wallet data to query.

## 11. What is implemented vs. designed vs. requires a Creator decision

**Implemented and tested this pass:**
- Full normalized schema (12 tables, `lib/ledger/schema.sql`)
- Deterministic event IDs, idempotent upsert
- Enriched on-chain event decoding (slot, instruction index, compute
  units, network fee, actor role, decimals, USD-valuation framework)
- Program-wide (not just per-Reserve) ingestion walker, including FAILED
  transactions
- Daily/range/complete CSV export, streamed, stable columns
- Data-quality/reconciliation checks (duplicates, amount-field
  consistency, actor presence, ingestion lag, date-gap detection)
- Jupiter weekly-snapshot fetch/diff/store logic
- Privacy allowlist enforcement for product-event metadata
- This documentation

**Designed (schema + code path exist) but NOT actively running / not yet
producing real data:**
- Lifecycle event ingestion (section 4.2) -- no frontend/API call sites
  wired up yet to actually call `buildEventId({kind:'lifecycle', ...})`
  at each Create-Reserve step
- Product/user-funnel analytics (section F) -- `ledger_product_events`
  schema + the privacy allowlist exist; no frontend instrumentation
  (session tracking, wallet-connect events, funnel-step events) has been
  added to any page yet
- Operational incident logging (section H) -- schema exists; no automatic
  population (would need RPC-provider/webhook health monitoring)
- `ledger_daily_rollups` -- schema exists; no daily computation job yet
  (today's totals are always computable live via `getDailyTotals`;
  ROLLING that into a locked historical snapshot needs the job)
- Treasury reconciliation against real on-chain balances (part of
  requirement G) -- needs a live balance-reading job comparing
  `ledger_events`' computed revenue against the actual treasury wallet's
  on-chain SPL token balance
- RPC/infrastructure cost tracking (part of requirement H) -- needs a
  provider billing API integration (Helius), not built

**Requires a Creator decision or credential before it can run:**
1. **`JUPITER_API_KEY`** -- Jupiter Tokens API V2 requires an `x-api-key`
   header (obtained from portal.jup.ag). Without it,
   `runWeeklyJupiterSnapshot()`/`api/ledger/jupiter-snapshot-cron.ts`
   throws a clear, explicit error (never silently returns an empty
   catalogue) -- see `.env.example`'s new entry.
2. **A real Mainnet deployment** -- `ledger_deployments`, the Mainnet
   backfill-from-slot logic, and `api/ledger/ingest-cron.ts`'s program-ID
   resolution all currently target DevNet's already-deployed program (the
   only one that exists). Pointing this at Mainnet is a config/small-code
   change once a Mainnet program ID and IDL exist, not a redesign.
3. **A real USD price feed (Pyth or similar)** -- already a documented,
   pre-existing Mainnet-readiness gap (see `docs/project/PROJECT_STATUS.md`'s
   Mainnet-Readiness Gaps). Until wired up, every Mainnet event's
   `usd_price_source` will correctly read `'unavailable'` rather than a
   fabricated number.
4. **Whether/how to adopt a Helius webhook or LaserStream** in addition to
   (or instead of) the cron-poll ingestion model -- a genuine architecture
   choice with cost/latency tradeoffs, not something to decide unilaterally
   on Creator's behalf.

## 12. Privacy and retention policy (requirements 7, 8)

**Never logged, anywhere in the Ledger, enforced in code
(`lib/ledger/privacy.ts`), not just documented:**
private keys, seed phrases, wallet-signing payload secrets, API keys,
authorization headers, session secrets, sensitive environment variables,
complete/raw RPC responses. `sanitizeProductEventMetadata` is an
ALLOWLIST (not a denylist) for the one place a caller could otherwise
stuff arbitrary data into the Ledger (`ledger_product_events.metadata`,
a `jsonb` column) -- an unrecognized key is dropped by default, the safer
failure mode. `containsForbiddenContent` additionally pattern-matches
free-text fields (`summary`, `error_message`) as a second layer.

**Off-chain analytics retention** (`RETENTION_POLICY` in
`lib/ledger/privacy.ts`, a checked constant, not just prose):
- Raw `ledger_product_events` session-level rows: retained 400 days.
- **IP addresses and device identifiers are never stored at all** -- there
  is no such column anywhere in the schema. Adding one later requires a
  separate, explicitly-scoped decision, never a silent addition.
- Wallet addresses and public transaction data ARE recorded where
  necessary (they are already public on-chain) -- this is not
  "off-chain information" under this policy.
- A page refresh or anonymous page view is never treated as a unique
  wallet/session for cohort purposes -- only an actual wallet-connect
  event counts (requirement F's explicit instruction; enforced at the
  ingestion-call-site level once product-event ingestion is wired up,
  since it depends on what the caller passes, not something the schema
  alone can force).

**On-chain data (`ledger_events`) has no retention limit** -- it mirrors
permanent, already-public chain state.

## 13. Reconciliation (requirement 7)

`lib/ledger/reconciliation.ts`'s checks, runnable via
`GET /api/ledger/reconciliation?cluster=<cluster>`:

| Check | What it verifies |
|---|---|
| `no_duplicate_event_ids` | The `unique (event_id)` constraint genuinely holds |
| `amount_field_consistency` | Any row with `amount_raw` set also has `amount_kind`/`amount_decimals` set (a partial amount row indicates a decoder bug) |
| `actor_presence` | Every row has an actor UNLESS its event type is a documented actor-less exception (e.g. a keeper-triggered settlement) |
| `ingestion_lag` | The newest row isn't suspiciously old (a stalled cron) |
| `date_gaps` | Finds UTC dates with zero rows between a cluster's first and last activity, for manual review (a genuine quiet day is not itself a failure, but an unreviewed gap should never go unnoticed) |

Every run is logged to `ledger_reconciliation_runs` -- "was this ever
checked, and when" is answerable from the data itself, not just a claim.

## 14. Disaster recovery

- **`ledger_events` is fully rebuildable from chain** -- `TRUNCATE` + a
  full re-run of `ingestProgramEvents` from the program's genesis
  reproduces it exactly (deterministic event IDs mean the rebuild is
  byte-for-byte reproducible in content, if not row-insertion order).
- **`ledger_reserves`/`ledger_asset_catalogue`** are caches -- safe to
  truncate and re-derive from live discovery + `ledger_events` at any
  time.
- **`ledger_jupiter_snapshots`/`ledger_jupiter_snapshot_mints`** are NOT
  rebuildable once a week passes -- Jupiter's API only reflects the
  CURRENT catalogue, not history. This is the one genuinely
  irreplaceable table in this schema; back it up accordingly (standard
  Neon point-in-time recovery covers this the same way it covers every
  other table -- no extra process needed beyond Neon's own backup
  retention, which Creator's existing Neon plan already provides).
- **Underlying storage:** Neon Postgres, already provisioned
  (`DATABASE_URL`, in production use since DEC-00xx's `reserve_activity_log`/
  `road-to-mainnet` features). See section 15 for why no new storage
  provider is needed.

## 15. Storage architecture decision (requirement 10)

**A suitable durable, Mainnet-capable data store already exists in this
repository: Neon Postgres**, already provisioned (`DATABASE_URL`) and
already serving two production features (`lib/road-to-mainnet/`,
`lib/reserve-activity/`). Per requirement 10's own instruction ("if a
suitable durable data store already exists, extend it") this pass
**extends it via a new, additive migration** (`lib/ledger/schema.sql`,
`scripts/migrate-ledger.mjs`) rather than introducing a second storage
provider. No new paid service was provisioned or recommended (matching the
explicit restriction on this pass).

**Estimated initial scale:** at realistic early-Mainnet volume (dozens of
Reserves, hundreds to low thousands of transactions per week),
`ledger_events` is expected to stay in the tens-of-thousands-of-rows range
for at least the first several months -- trivial for Neon's existing plan
tier (the same one already comfortably running two other features against
this database). The one line item worth monitoring over time is
`ledger_jupiter_snapshot_mints` (potentially several thousand rows per
weekly snapshot, since Jupiter's verified list itself runs into the
thousands of mints) -- still well within a standard Postgres plan's normal
operating range, not a scaling concern for the foreseeable future.

## 16. Acquisition/due-diligence reporting guide

For a due-diligence reviewer or acquirer, the fastest path to a complete
picture:

1. **`GET /api/ledger/export?cluster=mainnet-beta`** (once Mainnet exists
   and has been backfilled) -- the complete, structured, one-row-per-event
   historical record, openable directly in any spreadsheet tool.
2. **This document** for what each field means and how it was derived.
3. **`docs/project/DECISION_LOG.md`** for every material product/technical/
   security decision made along the way, in full context (why, not just
   what).
4. **`GET /api/ledger/reconciliation?cluster=mainnet-beta`** for a live
   data-quality attestation at the moment of review.
5. **Section 11 above**, read literally: it is the single list of exactly
   what is real/running today versus designed-but-pending versus blocked
   on a specific, named credential or decision -- written so a reviewer
   never has to guess which category a claim falls into.
