// GET /api/mainnet/campaign-refresh-cron -- keeps the Beta Campaign leaderboard
// fresh (DEC-0279). Every 30 minutes WHILE the campaign is live (plus 2 hours
// after close, to catch the last trades): tops up every Reserve's activity log
// (mints/redeems, same bounded sweep as the nightly kpis-backfill-cron) and
// indexes new Raydium pool swaps (same sweep as the daily dex-volume-cron).
// Outside that window it returns immediately, so it costs nothing.
//
// Cron security as the other crons: `Authorization: Bearer $CRON_SECRET`.
import { Connection } from "@solana/web3.js";
import { type ApiRequest, type ApiResponse } from "../devnet/_lib/apiTypes";
import { redactRpcSecrets } from "../devnet/_lib/rpc";
import { resolveRpcUrl } from "./_lib/rpc";
import { backfillAllReserveActivity } from "../../lib/reserve-activity/backfillAll";
import { buildClusterTargets } from "../../lib/reserve-activity/clusters";
import { sweepDexVolume } from "../../lib/dex-volume/indexer";
import { fetchJupiterPrices } from "./asset-prices";
import { campaignConfig } from "../../lib/campaign/rules";

const AFTER_CLOSE_S = 2 * 60 * 60;

function getHeader(req: ApiRequest, name: string): string | undefined {
  const value = req.headers[name] ?? req.headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

export default async function handler(req: ApiRequest, res: ApiResponse) {
  const expected = process.env.CRON_SECRET;
  if (!expected) { res.status(500).json({ error: "CRON_SECRET is not configured on this deployment." }); return; }
  if (getHeader(req, "authorization") !== `Bearer ${expected}`) { res.status(401).json({ error: "Unauthorized." }); return; }

  const cfg = campaignConfig();
  const now = Math.floor(Date.now() / 1000);
  if (cfg.startTs === null || cfg.endTs === null || now < cfg.startTs || now > cfg.endTs + AFTER_CLOSE_S) {
    res.status(200).json({ skipped: true, reason: "campaign not running" });
    return;
  }
  const out: Record<string, unknown> = {};
  try {
    out.activity = await backfillAllReserveActivity(buildClusterTargets(["mainnet-beta"], { fetchPricesUsd: fetchJupiterPrices }), { budgetMs: 35_000, maxStepsPerReserve: 1 });
  } catch (e) {
    out.activityError = redactRpcSecrets(e instanceof Error ? e.message : String(e));
  }
  try {
    out.dex = await sweepDexVolume(new Connection(resolveRpcUrl(), "confirmed"), 15_000);
  } catch (e) {
    out.dexError = redactRpcSecrets(e instanceof Error ? e.message : String(e));
  }
  res.status(200).json(out);
}
