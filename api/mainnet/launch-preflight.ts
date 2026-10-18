// POST /api/mainnet/launch-preflight -- DEC-0249. Read-only route check for
// Create Reserve: for each selected asset and the USDC that will be swapped
// into it, can Jupiter route the swap, how thin is it, and can it be swapped
// back? See lib/mainnet/launchPreflight.ts. Quotes only; never builds,
// signs or submits anything.
import { type ApiRequest, type ApiResponse, parseJsonBody } from "../devnet/_lib/apiTypes";
import { checkRateWindow } from "../devnet/_lib/rateLimit";
import { BASE58_RE, U64_MAX } from "../../lib/mainnet/jupiter";
import { PREFLIGHT_MAX_ASSETS, jupiterPreflightDeps, runLaunchPreflight, type PreflightAssetInput } from "../../lib/mainnet/launchPreflight";

export function parsePreflightRequest(body: Record<string, unknown>): PreflightAssetInput[] {
  const raw = body.assets;
  if (!Array.isArray(raw) || raw.length === 0) throw new Error("Select at least one asset.");
  if (raw.length > PREFLIGHT_MAX_ASSETS) throw new Error(`At most ${PREFLIGHT_MAX_ASSETS} assets can be checked at once.`);
  const seen = new Set<string>();
  return raw.map((a) => {
    const item = (a ?? {}) as Record<string, unknown>;
    const mint = typeof item.mint === "string" ? item.mint : "";
    if (!BASE58_RE.test(mint)) throw new Error("Invalid asset mint.");
    if (seen.has(mint)) throw new Error("Each asset can be listed once.");
    seen.add(mint);
    const budget = typeof item.usdcBudgetRaw === "string" && /^\d{1,20}$/.test(item.usdcBudgetRaw) ? BigInt(item.usdcBudgetRaw) : -1n;
    if (budget <= 0n || budget > U64_MAX) throw new Error("Each asset needs a positive USDC amount.");
    return { mint, usdcBudgetRaw: budget };
  });
}

export default async function handler(req: ApiRequest, res: ApiResponse & { setHeader?(name: string, value: string): void }) {
  res.setHeader?.("Cache-Control", "no-store");
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }
  const fwd = req.headers["x-forwarded-for"];
  const ip = (Array.isArray(fwd) ? fwd[0] : fwd ?? "unknown").split(",")[0].trim();
  if (!checkRateWindow(`mainnet-launch-preflight:${ip}`, 60_000, 12)) {
    res.setHeader?.("Retry-After", "15");
    res.status(429).json({ error: "Too many route checks from this client -- wait a moment and try again." });
    return;
  }
  let assets: PreflightAssetInput[];
  try {
    assets = parsePreflightRequest(parseJsonBody(req));
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : "Invalid route check request." });
    return;
  }
  const apiKey = process.env.JUPITER_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: "Jupiter is not configured on this deployment." });
    return;
  }
  const results = await runLaunchPreflight(jupiterPreflightDeps(apiKey), assets);
  res.status(200).json({ checkedAt: Date.now(), results });
}
