// Browser-side client for /api/mainnet/reserve-entry-prices -- the fixed
// "entry" side of the Reserve Composition card's per-asset P&L (current
// price vs. price when the asset entered the Reserve). Mainnet-only:
// DevNet's fixture prices never move, so it has no entry-price concept --
// DevNet P&L keeps comparing the fixed test table against itself (0.00%,
// honestly). The price itself is always captured SERVER-SIDE; this module
// only ever tells the server WHICH (reserve, mint) pairs exist.

export interface EntryPricePairRequest {
  reserve: string;
  mint: string;
  decimals: number;
}

/**
 * Fetches the full reserve -> (mint -> entry USD price) map. Best-effort by
 * design (same contract as fetchReserveImagePointers): any failure returns
 * an empty map, so an entry-price-service hiccup can only ever blank the
 * P&L column ("--"), never fail a discovery pass or fabricate a number.
 */
export async function fetchReserveEntryPrices(origin: string): Promise<Record<string, Record<string, number>>> {
  try {
    const response = await fetch(`${origin}/api/mainnet/reserve-entry-prices`);
    if (!response.ok) return {};
    const body = (await response.json().catch(() => null)) as { entries?: Record<string, unknown> } | null;
    if (!body || typeof body.entries !== "object" || body.entries === null) return {};
    const result: Record<string, Record<string, number>> = {};
    for (const [reserve, mints] of Object.entries(body.entries)) {
      if (typeof mints !== "object" || mints === null) continue;
      const perMint: Record<string, number> = {};
      for (const [mint, price] of Object.entries(mints)) {
        if (typeof price === "number" && Number.isFinite(price) && price > 0) perMint[mint] = price;
      }
      if (Object.keys(perMint).length > 0) result[reserve] = perMint;
    }
    return result;
  } catch {
    return {};
  }
}

/** Pairs already requested this session -- a pair whose mint the server can't price yet would otherwise be re-POSTed on every 15s discovery pass; once per session is enough (the next session, or another viewer, retries it). */
const requestedThisSession = new Set<string>();

/**
 * Asks the server to capture an entry price for every (reserve, mint) pair
 * that doesn't have one yet. Fire-and-forget/best-effort: the captured
 * prices show up in fetchReserveEntryPrices on a later discovery pass.
 */
export async function ensureReserveEntryPrices(origin: string, pairs: EntryPricePairRequest[]): Promise<void> {
  const fresh = pairs.filter((p) => !requestedThisSession.has(`${p.reserve}:${p.mint}`));
  if (fresh.length === 0) return;
  for (const p of fresh) requestedThisSession.add(`${p.reserve}:${p.mint}`);
  try {
    await fetch(`${origin}/api/mainnet/reserve-entry-prices`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pairs: fresh }),
    });
  } catch {
    // Best-effort -- a later session/viewer retries.
  }
}
