// DEC-0261: report a failed user action to the team's Telegram alerts
// (api/mainnet/alert-report.ts -> lib/ops-alerts). Fire-and-forget: never
// throws, never delays the UI. Wallet cancellations are not failures and are
// never sent. Mainnet only -- callers report from their Mainnet paths.
import { isWalletRejectionError } from "./createReserveResume";

export type OpsAlertStep = "mint" | "redeem" | "create" | "create-resume" | "launch" | "liquidity" | "rebalance" | "manage";

interface OpsAlertContext {
  reserve?: string | null;
  ticker?: string | null;
  wallet?: string | null;
  signature?: string | null;
}

const recent = new Map<string, number>();

export function reportFailure(step: OpsAlertStep, error: unknown, ctx: OpsAlertContext = {}): void {
  try {
    if (isWalletRejectionError(error)) return;
    const message = (error instanceof Error ? error.message : typeof error === "string" ? error : JSON.stringify(error) ?? "Unknown error").slice(0, 600);
    // The same failure retried in a loop on one page is one report a minute.
    const key = `${step}|${ctx.reserve ?? ""}|${message}`;
    const now = Date.now();
    if (now - (recent.get(key) ?? 0) < 60_000) return;
    recent.set(key, now);
    const page = typeof window !== "undefined" ? `${window.location.pathname}${window.location.hash}` : null;
    void fetch("/api/mainnet/alert-report", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ step, message, page, ...ctx }),
      keepalive: true,
    }).catch(() => undefined);
  } catch {
    // Reporting must never break the flow that failed.
  }
}
