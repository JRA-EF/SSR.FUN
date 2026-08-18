// Maintains ledger_reserves' manager/creator_wallet and
// ledger_reserve_delegates' active-delegate set, and uses them to fix up
// actor_role on already-ingested ledger_events rows. Before this, ingest.ts
// always called classifyActorRole with an empty context (no manager/
// creator/delegate data existed anywhere), which is why the first
// production sweep classified 309/433 rows as the generic "holder"
// fallback and 124 as "unknown" -- a live acquisition-readiness review
// flagged this as "actor classification is unreliable."
//
// ledger_reserves is documented as a non-authoritative CACHE ("NOT
// authoritative -- the Reserve account on-chain always is", schema.sql) --
// reclassifyActorRoles below inherits that same caveat: it reflects the
// LATEST known manager/creator/delegate set, not necessarily who held that
// role at the exact historical moment of an older event (a Reserve whose
// manager changed twice would show its CURRENT manager on every historical
// row, not the manager at the time). Documented, not silently assumed.
import { getSql } from "./db";
import { classifyActorRole, type ActorRole } from "./amounts";

export interface ReserveContextEvent {
  slot: number;
  reserve: string;
  /** ledger_reserves.program_id is NOT NULL -- required on every insert, even though only reserveCreated/reserveManagerTransferred write to that table (delegate events never touch program_id, ledger_reserve_delegates has no such column). */
  programId: string;
  eventType: "reserveCreated" | "reserveManagerTransferred" | "delegateAdded" | "delegatePermissionsUpdated" | "delegateRemoved";
  manager?: string | null;
  delegate?: string | null;
  permissionsBitmask?: number | null;
  restricted?: boolean | null;
  eventTsUtc: string;
}

/**
 * Applies a batch of context-defining events to ledger_reserves /
 * ledger_reserve_delegates, in caller-supplied order -- the caller is
 * responsible for sorting `events` by true chronological order (ascending
 * slot) first, since ingestion itself walks newest-to-oldest for
 * resumability and would otherwise apply a stale manager AFTER a newer
 * one. Each write is a plain overwrite (last-applied-wins), so as long as
 * the input is sorted ascending, the final state is correct regardless of
 * the order ingestion originally discovered the underlying transactions in.
 */
export async function applyReserveContextEvents(sql: ReturnType<typeof getSql>, cluster: string, events: ReserveContextEvent[]): Promise<void> {
  const sorted = [...events].sort((a, b) => a.slot - b.slot);
  for (const ev of sorted) {
    if (ev.eventType === "reserveCreated") {
      await sql`
        insert into ledger_reserves (cluster, reserve, program_id, manager, creator_wallet, created_at_utc)
        values (${cluster}, ${ev.reserve}, ${ev.programId}, ${ev.manager ?? null}, ${ev.manager ?? null}, ${ev.eventTsUtc})
        on conflict (cluster, reserve) do update set
          manager = ${ev.manager ?? null}, creator_wallet = ${ev.manager ?? null}, created_at_utc = ${ev.eventTsUtc}
      `;
    } else if (ev.eventType === "reserveManagerTransferred") {
      await sql`
        insert into ledger_reserves (cluster, reserve, program_id, manager)
        values (${cluster}, ${ev.reserve}, ${ev.programId}, ${ev.manager ?? null})
        on conflict (cluster, reserve) do update set manager = ${ev.manager ?? null}
      `;
    } else if (ev.eventType === "delegateAdded" && ev.delegate) {
      await sql`
        insert into ledger_reserve_delegates (cluster, reserve, delegate_wallet, permissions_bitmask, restricted, active, added_at_utc, last_updated_at_utc)
        values (${cluster}, ${ev.reserve}, ${ev.delegate}, ${ev.permissionsBitmask ?? null}, ${ev.restricted ?? null}, true, ${ev.eventTsUtc}, now())
        on conflict (cluster, reserve, delegate_wallet) do update set
          permissions_bitmask = ${ev.permissionsBitmask ?? null}, restricted = ${ev.restricted ?? null}, active = true, added_at_utc = ${ev.eventTsUtc}, last_updated_at_utc = now()
      `;
    } else if (ev.eventType === "delegatePermissionsUpdated" && ev.delegate) {
      await sql`
        insert into ledger_reserve_delegates (cluster, reserve, delegate_wallet, permissions_bitmask, active, last_updated_at_utc)
        values (${cluster}, ${ev.reserve}, ${ev.delegate}, ${ev.permissionsBitmask ?? null}, true, now())
        on conflict (cluster, reserve, delegate_wallet) do update set
          permissions_bitmask = ${ev.permissionsBitmask ?? null}, last_updated_at_utc = now()
      `;
    } else if (ev.eventType === "delegateRemoved" && ev.delegate) {
      await sql`
        insert into ledger_reserve_delegates (cluster, reserve, delegate_wallet, active, removed_at_utc, last_updated_at_utc)
        values (${cluster}, ${ev.reserve}, ${ev.delegate}, false, ${ev.eventTsUtc}, now())
        on conflict (cluster, reserve, delegate_wallet) do update set
          active = false, removed_at_utc = ${ev.eventTsUtc}, last_updated_at_utc = now()
      `;
    }
  }
}

export interface ReserveActorLookup {
  getContext(reserve: string | null): { reserveManager?: string | null; reserveCreator?: string | null; knownDelegates?: string[] };
}

/** Loads the current ledger_reserves/ledger_reserve_delegates snapshot for a cluster into memory once, for cheap repeated lookups during a single ingestion sweep or reclassification pass. */
export async function loadReserveActorLookup(sql: ReturnType<typeof getSql>, cluster: string): Promise<ReserveActorLookup> {
  const reserveRows = (await sql`select reserve, manager, creator_wallet from ledger_reserves where cluster = ${cluster}`) as { reserve: string; manager: string | null; creator_wallet: string | null }[];
  const delegateRows = (await sql`select reserve, delegate_wallet from ledger_reserve_delegates where cluster = ${cluster} and active = true`) as { reserve: string; delegate_wallet: string }[];

  const managers = new Map<string, { manager: string | null; creator: string | null }>();
  for (const r of reserveRows) managers.set(r.reserve, { manager: r.manager, creator: r.creator_wallet });
  const delegates = new Map<string, string[]>();
  for (const d of delegateRows) {
    const list = delegates.get(d.reserve) ?? [];
    list.push(d.delegate_wallet);
    delegates.set(d.reserve, list);
  }

  return {
    getContext(reserve) {
      if (!reserve) return {};
      const m = managers.get(reserve);
      return { reserveManager: m?.manager ?? null, reserveCreator: m?.creator ?? null, knownDelegates: delegates.get(reserve) ?? [] };
    },
  };
}

/**
 * Recomputes actor_role for every already-ingested ledger_events row that
 * has both a reserve and an actor_wallet, using the CURRENT
 * ledger_reserves/ledger_reserve_delegates snapshot -- run this any time
 * after ingestion (or reserve-context) has moved forward, to retroactively
 * fix rows classified before their Reserve's manager/creator/delegate set
 * was known yet (unavoidable during backward/resumable ingestion -- see
 * this file's top comment). Idempotent: rows already correctly classified
 * are simply left unchanged (no-op UPDATE avoided via the WHERE clause).
 */
export async function reclassifyActorRoles(sql: ReturnType<typeof getSql>, cluster: string): Promise<{ scanned: number; updated: number }> {
  const lookup = await loadReserveActorLookup(sql, cluster);
  const rows = (await sql`
    select id, reserve, actor_wallet, actor_role from ledger_events
    where cluster = ${cluster} and actor_wallet is not null
  `) as { id: number; reserve: string | null; actor_wallet: string; actor_role: string }[];

  let updated = 0;
  for (const row of rows) {
    const newRole: ActorRole = classifyActorRole(row.actor_wallet, lookup.getContext(row.reserve));
    if (newRole !== row.actor_role) {
      await sql`update ledger_events set actor_role = ${newRole} where id = ${row.id}`;
      updated++;
    }
  }
  return { scanned: rows.length, updated };
}
