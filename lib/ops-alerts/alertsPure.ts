// DEC-0261: pure parts of the ops alert pipeline (lib/ops-alerts/alerts.ts) --
// what counts as an alert, how repeats are grouped, and how a Telegram
// message reads. No I/O here so tests can pin every rule.

export type AlertSource = "app" | "chain" | "keeper";

export interface AlertEvent {
  source: AlertSource;
  /** Short machine step, e.g. "mint", "redeem", "launch", "settlement". */
  step: string;
  message: string;
  reserve?: string | null;
  ticker?: string | null;
  wallet?: string | null;
  signature?: string | null;
  page?: string | null;
}

export const STEP_TITLES: Record<string, string> = {
  mint: "Mint failed",
  redeem: "Redeem failed",
  create: "Reserve creation failed",
  "create-resume": "Reserve creation resume failed",
  launch: "Liquidity launch failed",
  liquidity: "Liquidity action failed",
  rebalance: "Rebalance failed",
  manage: "Manage action failed",
  "on-chain": "Transaction failed on-chain",
  settlement: "Keeper: fee settlement failed",
  accrual: "Keeper: fee accrual failed",
  "transfer-fees": "Keeper: transfer fee sweep failed",
  "basket-feed": "Keeper: basket feed failed",
  "keeper-balance": "Keeper wallet low on SOL",
  "keeper-config": "Keeper not running",
};

const MAX_FIELD = 600;

/** Wallet cancellations are the user's choice, not a fault: logged nowhere, never alerted. */
export function isUserCancel(message: string): boolean {
  const m = message.toLowerCase();
  return m.includes("user rejected") || m.includes("rejected the request") || m.includes("user declined")
    || m.includes("transaction cancelled") || m.includes("approval denied") || m.includes("cancelled in wallet");
}

/** RPC hiccups that the next hourly keeper run retries on its own (DEC-0262): logged in the run result, never alerted. */
export function isTransientRpcError(message: string): boolean {
  const m = message.toLowerCase();
  return m.includes("block not available") || m.includes("failed to get block time") || /\b429\b/.test(m) || m.includes("too many requests")
    || m.includes("fetch failed") || m.includes("econnreset") || m.includes("etimedout") || m.includes("socket hang up")
    || m.includes("blockhash not found") || m.includes("block height exceeded") || m.includes("503 service unavailable") || m.includes("502 bad gateway");
}

/** Strip what varies between otherwise identical failures (numbers, addresses, signatures) so repeats group together. */
export function normalizeMessage(message: string): string {
  return message
    .replace(/[1-9A-HJ-NP-Za-km-z]{32,88}/g, "<addr>")
    // Error codes (custom program error: 0x1771) identify the failure, so hex stays; other numbers vary per attempt.
    .replace(/\b0x[0-9a-f]+\b|\d+(\.\d+)?/gi, (m) => (m.toLowerCase().startsWith("0x") ? m : "#"))
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
}

export function fingerprint(e: AlertEvent): string {
  return `${e.source}|${e.step}|${normalizeMessage(e.message)}`;
}

export function clip(s: string | null | undefined, n = MAX_FIELD): string | null {
  if (s == null) return null;
  const t = String(s).trim();
  return t ? (t.length > n ? `${t.slice(0, n - 1)}…` : t) : null;
}

/** Wallets and signatures are shown by their LAST characters only. */
export function tail(s: string | null | undefined, n = 6): string | null {
  return s ? `…${s.slice(-n)}` : null;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Telegram HTML message. `repeats` = how many times this exact failure happened since the last message about it. */
export function formatAlert(e: AlertEvent, opts: { site: string; repeats: number }): string {
  const title = STEP_TITLES[e.step] ?? `${e.step} failed`;
  const lines = [`🔴 <b>${esc(title)}</b>${opts.repeats > 1 ? ` (×${opts.repeats} since last alert)` : ""} · ${esc(opts.site)}`];
  if (e.ticker || e.reserve) lines.push(`Reserve: ${esc([e.ticker, tail(e.reserve)].filter(Boolean).join(" "))}`);
  lines.push(`Error: <code>${esc(clip(e.message, 500) ?? "")}</code>`);
  if (e.wallet) lines.push(`Wallet: ${esc(tail(e.wallet) ?? "")}`);
  if (e.signature) lines.push(`Tx: <a href="https://solscan.io/tx/${encodeURIComponent(e.signature)}">${esc(tail(e.signature, 8) ?? "")}</a>`);
  if (e.page) lines.push(`Page: ${esc(clip(e.page, 120) ?? "")}`);
  return lines.join("\n");
}

/** Client-sent report body -> event, or an error string. Only fields we show; everything clipped. */
export function parseClientReport(body: unknown): { ok: true; value: AlertEvent } | { ok: false; error: string } {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const str = (k: string, n: number) => (typeof b[k] === "string" ? clip(b[k] as string, n) : null);
  const step = str("step", 40);
  const message = str("message", MAX_FIELD);
  if (!step || !/^[a-z-]+$/.test(step) || !STEP_TITLES[step]) return { ok: false, error: "Unknown step." };
  if (!message) return { ok: false, error: "Missing message." };
  const key = (k: string) => { const v = str(k, 100); return v && /^[1-9A-HJ-NP-Za-km-z]{32,88}$/.test(v) ? v : null; };
  return { ok: true, value: { source: "app", step, message, reserve: key("reserve"), wallet: key("wallet"), signature: key("signature"), ticker: str("ticker", 16), page: str("page", 200) } };
}

/** Helius "raw" webhook payload (array of getTransaction-shaped objects) -> one event per failed transaction. */
export function parseHeliusFailures(payload: unknown): AlertEvent[] {
  const txs = Array.isArray(payload) ? payload : [];
  const out: AlertEvent[] = [];
  for (const tx of txs as any[]) {
    const err = tx?.meta?.err;
    if (!err) continue;
    const logs: string[] = Array.isArray(tx?.meta?.logMessages) ? tx.meta.logMessages : [];
    const keys = tx?.transaction?.message?.accountKeys;
    const payer = Array.isArray(keys) ? (typeof keys[0] === "string" ? keys[0] : keys[0]?.pubkey) : null;
    const ix = [...logs].reverse().find((l) => l.startsWith("Program log: Instruction: "))?.slice(26) ?? null;
    const anchor = logs.find((l) => l.includes("Error Message:") || l.includes("AnchorError"));
    const failed = [...logs].reverse().find((l) => / failed: /.test(l));
    const reason = anchor ? anchor.replace(/^Program log: /, "") : failed ?? JSON.stringify(err);
    out.push({
      source: "chain",
      step: "on-chain",
      message: `${ix ? `${ix}: ` : ""}${reason}`,
      wallet: typeof payer === "string" ? payer : null,
      signature: Array.isArray(tx?.transaction?.signatures) ? tx.transaction.signatures[0] ?? null : null,
    });
  }
  return out;
}

/** Keeper SOL below this pages the team (it pays settlement fees and first-use token-account rent). */
export const KEEPER_LOW_SOL = 0.05;
