// POST /api/mainnet/alert-report -- the app reports a failed Mint, Redeem,
// create, launch or manage action (src/merge/lib/opsAlert.ts); logged and
// posted to the team's Telegram group by lib/ops-alerts (DEC-0261).
//
// Behind the site gate like every app API (only visitors with a redeemed key
// reach it), and capped per IP so one broken client cannot flood the group.
import { type ApiRequest, type ApiResponse, parseJsonBody } from "../devnet/_lib/apiTypes";
import { recordAlert } from "../../lib/ops-alerts/alerts";
import { parseClientReport } from "../../lib/ops-alerts/alertsPure";
import { checkDurableRateWindow } from "../../lib/rate-limit/durableRateWindow";
import { getSql } from "../../lib/rate-limit/db";

const IP_WINDOW_MS = 10 * 60_000;
const IP_MAX = 20;

export default async function handler(req: ApiRequest, res: ApiResponse) {
  if (req.method !== "POST") { res.status(405).json({ error: "Method not allowed." }); return; }
  const parsed = parseClientReport(parseJsonBody(req));
  if (parsed.ok === false) { res.status(400).json({ error: parsed.error }); return; }
  const fwd = req.headers["x-forwarded-for"];
  const ip = (Array.isArray(fwd) ? fwd[0] : fwd ?? "").split(",")[0].trim() || "unknown";
  const verdict = await checkDurableRateWindow(getSql() as never, `ops-alert:${ip}`, IP_WINDOW_MS, IP_MAX);
  if (!verdict.allowed) { res.status(429).json({ error: "Too many reports." }); return; }
  const alerted = await recordAlert(parsed.value);
  res.status(202).json({ ok: true, alerted });
}
