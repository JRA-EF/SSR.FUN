// DEC-0261: ops alerts. Every failure reported by the app, the keeper or the
// Helius failed-transaction webhook is logged in Neon (ops_alert_events) and
// posted to the team's Telegram group, with repeats of the same failure
// grouped: at most one message per failure kind per quiet window (default 10
// minutes), carrying the count since the previous message.
//
// Env: TELEGRAM_ALERT_BOT_TOKEN, TELEGRAM_ALERT_CHAT_ID (never in the repo --
// it is public). Without them events are still logged. Never throws: an alert
// failing must not break the flow that reported it.
import { neon, type NeonQueryFunction } from "@neondatabase/serverless";
import { fingerprint, formatAlert, isUserCancel, type AlertEvent } from "./alertsPure";

let _sql: NeonQueryFunction<false, false> | null = null;
let _schemaReady = false;

function getSql(): NeonQueryFunction<false, false> {
  if (!_sql) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not configured.");
    _sql = neon(url);
  }
  return _sql;
}

/** Test seam. */
export function setSqlForTests(fn: NeonQueryFunction<false, false> | null): void {
  _sql = fn;
  _schemaReady = false;
}

async function ensureSchema(sql: NeonQueryFunction<false, false>): Promise<void> {
  if (_schemaReady) return;
  await sql`CREATE TABLE IF NOT EXISTS ops_alerts (
    fingerprint text PRIMARY KEY, source text NOT NULL, step text NOT NULL,
    first_seen timestamptz NOT NULL DEFAULT now(), last_seen timestamptz NOT NULL DEFAULT now(),
    count integer NOT NULL DEFAULT 0, unsent integer NOT NULL DEFAULT 0, last_sent_at timestamptz)`;
  await sql`CREATE TABLE IF NOT EXISTS ops_alert_events (
    id bigserial PRIMARY KEY, at timestamptz NOT NULL DEFAULT now(), fingerprint text NOT NULL,
    source text NOT NULL, step text NOT NULL, message text NOT NULL, site text,
    reserve text, ticker text, wallet text, signature text, page text)`;
  await sql`CREATE INDEX IF NOT EXISTS ops_alert_events_at ON ops_alert_events (at)`;
  _schemaReady = true;
}

/** The site this deployment serves (ssr.fun vs the staging domain), shown on every message. */
export function siteLabel(): string {
  return process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL || "local";
}

export async function sendTelegram(html: string): Promise<boolean> {
  const token = process.env.TELEGRAM_ALERT_BOT_TOKEN;
  const chat = process.env.TELEGRAM_ALERT_CHAT_ID;
  if (!token || !chat) return false;
  const post = (chatId: string) => fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: html, parse_mode: "HTML", disable_web_page_preview: true }),
    signal: AbortSignal.timeout(5_000),
  }).then((r) => r.json() as Promise<{ ok: boolean; description?: string; parameters?: { migrate_to_chat_id?: number } }>);
  try {
    let r = await post(chat);
    // A group upgraded to a supergroup gets a new id; follow it once and say so in the logs.
    if (!r.ok && r.parameters?.migrate_to_chat_id) {
      console.error(`[ops-alerts] Telegram group moved: set TELEGRAM_ALERT_CHAT_ID=${r.parameters.migrate_to_chat_id}`);
      r = await post(String(r.parameters.migrate_to_chat_id));
    }
    if (!r.ok) console.error("[ops-alerts] Telegram refused the alert:", r.description);
    return r.ok;
  } catch (e) {
    console.error("[ops-alerts] Telegram unreachable:", e instanceof Error ? e.message : e);
    return false;
  }
}

// Last resort when Neon is down: per-instance grouping so a storm is still one message.
const memoryLastSent = new Map<string, number>();

/**
 * Logs one failure and alerts unless the same failure was already alerted
 * within `quietMinutes`. Returns whether a Telegram message went out.
 */
export async function recordAlert(event: AlertEvent, opts: { quietMinutes?: number } = {}): Promise<boolean> {
  if (isUserCancel(event.message)) return false;
  const quiet = Math.max(1, opts.quietMinutes ?? 10);
  const fp = fingerprint(event);
  const site = siteLabel();
  try {
    const sql = getSql();
    await ensureSchema(sql);
    await sql`INSERT INTO ops_alert_events (fingerprint, source, step, message, site, reserve, ticker, wallet, signature, page)
      VALUES (${fp}, ${event.source}, ${event.step}, ${event.message}, ${site}, ${event.reserve ?? null}, ${event.ticker ?? null}, ${event.wallet ?? null}, ${event.signature ?? null}, ${event.page ?? null})`;
    const [row] = (await sql`INSERT INTO ops_alerts (fingerprint, source, step, count, unsent)
      VALUES (${fp}, ${event.source}, ${event.step}, 1, 1)
      ON CONFLICT (fingerprint) DO UPDATE SET count = ops_alerts.count + 1, unsent = ops_alerts.unsent + 1, last_seen = now()
      RETURNING unsent`) as { unsent: number }[];
    // Claim the send atomically so two instances never both post the same burst.
    const claimed = (await sql`UPDATE ops_alerts SET last_sent_at = now(), unsent = 0
      WHERE fingerprint = ${fp} AND (last_sent_at IS NULL OR last_sent_at < now() - make_interval(mins => ${quiet}))
      RETURNING fingerprint`) as unknown[];
    if (Math.random() < 0.01) await sql`DELETE FROM ops_alert_events WHERE at < now() - interval '90 days'`;
    if (claimed.length === 0) return false;
    return await sendTelegram(formatAlert(event, { site, repeats: row?.unsent ?? 1 }));
  } catch (e) {
    console.error("[ops-alerts] log failed, alerting without grouping store:", e instanceof Error ? e.message : e);
    const last = memoryLastSent.get(fp) ?? 0;
    if (Date.now() - last < quiet * 60_000) return false;
    memoryLastSent.set(fp, Date.now());
    return await sendTelegram(formatAlert(event, { site, repeats: 1 }));
  }
}
