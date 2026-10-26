// POST /api/mainnet/alert-helius -- Helius webhook for FAILED transactions
// that touch the SSR program (8hTW...); each one is logged and alerted by
// lib/ops-alerts (DEC-0261). Webhook: type "raw", txnStatus "failed",
// authHeader = HELIUS_ALERT_WEBHOOK_SECRET (scripts/ops_alert_webhook.ts).
// Machine-to-machine, so middleware.ts lets it past the site gate and this
// handler checks the secret itself.
import { createHash, timingSafeEqual } from "node:crypto";
import { type ApiRequest, type ApiResponse } from "../devnet/_lib/apiTypes";
import { recordAlert } from "../../lib/ops-alerts/alerts";
import { parseHeliusFailures } from "../../lib/ops-alerts/alertsPure";

export default async function handler(req: ApiRequest, res: ApiResponse) {
  if (req.method !== "POST") { res.status(405).json({ error: "Method not allowed." }); return; }
  const secret = process.env.HELIUS_ALERT_WEBHOOK_SECRET;
  const auth = req.headers.authorization;
  if (!secret || !sameSecret(String((Array.isArray(auth) ? auth[0] : auth) ?? ""), secret)) { res.status(401).json({ error: "Unauthorized." }); return; }
  const events = parseHeliusFailures(req.body);
  let alerted = 0;
  for (const e of events.slice(0, 50)) if (await recordAlert(e)) alerted++;
  res.status(200).json({ ok: true, failed: events.length, alerted });
}

/** Constant-time compare (DEC-0263); hashing first keeps both sides the same length. */
function sameSecret(given: string, secret: string): boolean {
  const h = (v: string) => createHash("sha256").update(v).digest();
  return timingSafeEqual(h(given), h(secret));
}
