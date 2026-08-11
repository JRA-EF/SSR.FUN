-- Road to Mainnet: collaborative DevNet-acceptance checklist persistence.
-- Applied via scripts/migrate-road-to-mainnet.mjs. Idempotent (IF NOT EXISTS)
-- so it is safe to re-run against Development/Preview/Production alike.
--
-- One row per checklist control / gap-analysis row / approval gate / hero
-- meta field, each with its own `version` for optimistic concurrency
-- (UPDATE ... WHERE version = $expected). rtm_revisions is an append-only
-- audit log of every write, giving recoverable history independent of the
-- live tables.

create table if not exists rtm_controls (
  control_id   text primary key,
  status       text not null default 'Not tested',
  evidence     text not null default '',
  environment  text not null default '',
  tester       text not null default '',
  notes        text not null default '',
  version      integer not null default 1,
  updated_at   timestamptz not null default now(),
  updated_by   text
);

create table if not exists rtm_gap_rows (
  row_index    integer primary key,
  cells        jsonb not null,
  version      integer not null default 1,
  updated_at   timestamptz not null default now(),
  updated_by   text
);

create table if not exists rtm_gates (
  gate_index   integer primary key,
  decision     text not null default 'Not reviewed',
  approver     text not null default '',
  notes        text not null default '',
  version      integer not null default 1,
  updated_at   timestamptz not null default now(),
  updated_by   text
);

create table if not exists rtm_meta (
  key          text primary key,
  value        text not null default '',
  version      integer not null default 1,
  updated_at   timestamptz not null default now(),
  updated_by   text
);

create table if not exists rtm_revisions (
  id           bigserial primary key,
  entity_type  text not null,
  entity_id    text not null,
  before_value jsonb,
  after_value  jsonb not null,
  changed_by   text,
  changed_at   timestamptz not null default now()
);

create index if not exists rtm_revisions_entity_idx
  on rtm_revisions (entity_type, entity_id, changed_at desc);

-- Append-only discussion thread per entity, separate from (and never
-- overwriting) the mutable status/evidence/notes fields above. Grouped into
-- numbered "passes": every comment belongs to exactly one pass, and once a
-- pass is locked (locked_at set), every comment in it becomes permanently
-- read-only track record -- a new comment always starts (or continues) the
-- next open pass instead. See api/road-to-mainnet/comments.ts.
create table if not exists rtm_comments (
  id           bigserial primary key,
  entity_type  text not null,
  entity_id    text not null,
  pass         integer not null,
  author       text not null default 'Unknown',
  body         text not null,
  created_at   timestamptz not null default now(),
  locked_at    timestamptz
);

create index if not exists rtm_comments_entity_idx
  on rtm_comments (entity_type, entity_id, pass, created_at);
