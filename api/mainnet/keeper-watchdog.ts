// GET /api/mainnet/keeper-watchdog -- DEC-0270. Every 15 minutes (vercel.json),
// checks that the fee keeper (api/mainnet/fee-settlement-cron.ts) completed a
// run recently and pages the team on Telegram when it did not. The keeper
// writes its heartbeat only when a run finishes, so a crash on load (the
// 2026-10-28 12:15 run), a timeout or a thrown error all show up here.
//
// Deliberately tiny and separate: it imports nothing the keeper imports except
// lib/ops-alerts, so a broken keeper bundle cannot take the watchdog down with
// it. Same CRON_SECRET bearer as every other cron; allowlisted in middleware.ts
// CRON_PATHS. `?dryRun=true` reports without alerting.
import { timingSafeEqual } from "node:crypto";
import { neon } from "@neondatabase/serverless";
import type { ApiRequest, ApiResponse } from "../devnet/_lib/apiTypes";
import { recordAlert, siteLabel } from "../../lib/ops-alerts/alerts";
import { keeperStaleMinutes, readKeeperHeartbeat, KEEPER_STALE_AFTER_MINUTES } from "../../lib/ops-alerts/keeperHeartbeat";

export const config = { maxDuration: 30 };

function authorized(req: ApiRequest): boolean {
  const expected = process.env.CRON_SECRET;
  const raw = req.headers.authorization ?? req.headers.Authorization;
  const provided = Array.isArray(raw) ? raw[0] : raw;
  if (!expected || !provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(`Bearer ${expected}`);
  return a.length === b.length && timingSafeEqual(a, b);
}

export default async function handler(req: ApiRequest, res: ApiResponse) {
  const dryRun = req.query?.dryRun === "true" || req.query?.dryRun === "1";
  if (!dryRun && !authorized(req)) {
    res.status(401).json({ error: "Unauthorized." });
    return;
  }
  const url = process.env.DATABASE_URL;
  if (!url) {
    res.status(500).json({ error: "DATABASE_URL is not configured." });
    return;
  }
  const site = siteLabel();
  try {
    const beat = await readKeeperHeartbeat(neon(url), site);
    const staleMinutes = keeperStaleMinutes(beat.lastOkAt, new Date());
    if (staleMinutes !== null && !dryRun) {
      await recordAlert(
        { source: "keeper", step: "keeper-stale", message: `No completed fee keeper run for ${staleMinutes} minutes (expected hourly at :15; alert after ${KEEPER_STALE_AFTER_MINUTES}). Last run: ${beat.summary ?? "unknown"}. Check the fee-settlement-cron logs on Vercel: settlement, TVL accruals and holder-share feeds are not running.` },
        { quietMinutes: 60 },
      );
    }
    res.status(200).json({ site, lastOkAt: beat.lastOkAt.toISOString(), lastSummary: beat.summary, staleMinutes, dryRun });
  } catch (e) {
    // The watchdog itself failing (database down) is worth a message too.
    const message = e instanceof Error ? e.message : String(e);
    if (!dryRun) await recordAlert({ source: "keeper", step: "keeper-stale", message: `Keeper watchdog could not read the heartbeat: ${message}` }, { quietMinutes: 60 });
    res.status(500).json({ error: message });
  }
}
