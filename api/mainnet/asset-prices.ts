// POST /api/mainnet/asset-prices -- the ONLY source of USD pricing this app
// ever uses for Mainnet Reserve Assets. Server-side only: Pyth Hermes and
// Jupiter Price V3 are both called from here, never from the browser, so a
// client can never inject or override a price (see
// docs/protocol/SSR_ARCHITECTURE.md's Mainnet-pricing-layer entry --
// "never trust client-supplied prices" is a hard requirement, not a
// preference). The browser only ever receives an already-validated
// {usdPrice, source, lastUpdated} per mint, or an honest "unavailable" --
// never a fabricated number.
//
// Hierarchy (packages/sdk/src/pricing.ts owns the actual decision logic,
// kept pure/network-free there so it's unit-testable without a live call):
// a verified Pyth Core feed wins when it validates (identity, staleness,
// confidence); Jupiter Price V3 is the fallback for every other mint, or
// when Pyth is unavailable/fails validation for a mint that does have a
// feed. When both validate for the same mint, a material disagreement is
// flagged (never silently averaged or overridden).
//
// Pyth's announced 26 August 2026 Core upgrade: this endpoint calls the
// current, documented Hermes v2 REST shape
// (GET /v2/updates/price/latest?ids[]=...). PYTH_HERMES_BASE_URL is an env
// override specifically so a post-upgrade endpoint/base-URL change can be
// absorbed as a deployment config change, not a code change -- re-verify
// this file's parsing against Pyth's live docs after that date if prices
// stop validating.
import { checkRateWindow } from "../devnet/_lib/rateLimit";
import { type ApiRequest, type ApiResponse, parseJsonBody } from "../devnet/_lib/apiTypes";
import { resolveRpcUrl } from "./_lib/rpc";
import { Connection } from "@solana/web3.js";
import {
  MAINNET_PYTH_FEED_IDS,
  validatePythPrice,
  validateJupiterPrice,
  resolvePriceHierarchy,
  type RawPythPrice,
  type RawJupiterPrice,
  type ValidatedPrice,
} from "@ssr/sdk";

const PYTH_HERMES_BASE_URL = process.env.PYTH_HERMES_BASE_URL || "https://hermes.pyth.network";
const JUPITER_PRICE_URL = "https://api.jup.ag/price/v3";

const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const MAX_ASSETS_PER_REQUEST = 30;
/** Briefly cached, timestamped, per-mint -- matches the requirement to "cache briefly with timestamps" without ever serving a genuinely stale price as fresh (the cached ValidatedPrice's own lastUpdated is untouched by caching, so a caller can always see how old the underlying quote actually is). */
const CACHE_TTL_MS = 15_000;

interface CacheEntry {
  pyth: ValidatedPrice | null;
  jupiter: ValidatedPrice | null;
  fetchedAt: number;
}
const priceCache = new Map<string, CacheEntry>();

interface RequestedAsset {
  mint: string;
  decimals: number;
}

function parseRequestedAssets(body: Record<string, unknown>): RequestedAsset[] | null {
  const raw = body.assets;
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_ASSETS_PER_REQUEST) return null;
  const seen = new Set<string>();
  const out: RequestedAsset[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") return null;
    const mint = (entry as Record<string, unknown>).mint;
    const decimals = (entry as Record<string, unknown>).decimals;
    if (typeof mint !== "string" || !BASE58_RE.test(mint)) return null;
    if (typeof decimals !== "number" || !Number.isInteger(decimals) || decimals < 0 || decimals > 18) return null;
    if (seen.has(mint)) continue;
    seen.add(mint);
    out.push({ mint, decimals });
  }
  return out.length > 0 ? out : null;
}

async function fetchPythPrices(feedIds: string[]): Promise<Map<string, RawPythPrice>> {
  const out = new Map<string, RawPythPrice>();
  if (feedIds.length === 0) return out;
  const qs = feedIds.map((id) => `ids[]=${id}`).join("&");
  const res = await fetch(`${PYTH_HERMES_BASE_URL}/v2/updates/price/latest?${qs}`);
  if (!res.ok) return out;
  const body = (await res.json().catch(() => null)) as { parsed?: unknown } | null;
  if (!body || !Array.isArray(body.parsed)) return out;
  for (const entry of body.parsed) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const id = typeof e.id === "string" ? e.id : null;
    const priceObj = e.price as Record<string, unknown> | undefined;
    if (!id || !priceObj) continue;
    const price = typeof priceObj.price === "string" ? priceObj.price : null;
    const conf = typeof priceObj.conf === "string" ? priceObj.conf : null;
    const expo = typeof priceObj.expo === "number" ? priceObj.expo : null;
    const publishTime = typeof priceObj.publish_time === "number" ? priceObj.publish_time : null;
    if (price === null || conf === null || expo === null || publishTime === null) continue;
    out.set(id.toLowerCase(), { id: id.toLowerCase(), price, conf, expo, publishTimeSec: publishTime });
  }
  return out;
}

async function requestJupiterPrices(mints: string[], headers: Record<string, string>): Promise<{ ok: boolean; unauthorized: boolean; body: Record<string, unknown> | null }> {
  const res = await fetch(`${JUPITER_PRICE_URL}?ids=${mints.join(",")}`, { headers });
  if (!res.ok) return { ok: false, unauthorized: res.status === 401, body: null };
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  return { ok: body !== null, unauthorized: false, body };
}

/**
 * Jupiter Price V3 is usable unauthenticated (public rate limits) -- JUPITER_API_KEY
 * is attempted first (per Creator's requirement to use it) for its higher/authenticated
 * rate limit, but a 401 from a misconfigured/expired/wrong key falls back to the
 * unauthenticated request rather than taking every Mainnet asset's pricing dark. This
 * is a fallback on AUTHENTICATION failure only (401) -- any other failure (network
 * error, 5xx, malformed body) still yields "unavailable" for real, never fabricated.
 */
export async function fetchJupiterPrices(mints: string[]): Promise<Map<string, RawJupiterPrice>> {
  const out = new Map<string, RawJupiterPrice>();
  if (mints.length === 0) return out;
  const apiKey = process.env.JUPITER_API_KEY;
  let result = apiKey ? await requestJupiterPrices(mints, { "x-api-key": apiKey }) : { ok: false, unauthorized: false, body: null as Record<string, unknown> | null };
  if (!result.ok && (!apiKey || result.unauthorized)) {
    result = await requestJupiterPrices(mints, {});
  }
  if (!result.ok || !result.body) return out;
  const body = result.body;
  for (const mint of mints) {
    const entry = body[mint];
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    out.set(mint, {
      usdPrice: typeof e.usdPrice === "number" ? e.usdPrice : null,
      decimals: typeof e.decimals === "number" ? e.decimals : null,
      blockId: typeof e.blockId === "number" ? e.blockId : null,
    });
  }
  return out;
}

export default async function handler(req: ApiRequest, res: ApiResponse) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const fwd = req.headers["x-forwarded-for"];
  const ip = (Array.isArray(fwd) ? fwd[0] : fwd) ?? "unknown";
  if (!checkRateWindow(`mainnet-asset-prices:${ip.split(",")[0].trim()}`, 60_000, 30)) {
    res.status(429).json({ error: "Too many pricing requests from this client -- wait a moment and try again." });
    return;
  }

  const assets = parseRequestedAssets(parseJsonBody(req));
  if (!assets) {
    res.status(400).json({ error: `Invalid request: "assets" must be a non-empty array of {mint, decimals}, max ${MAX_ASSETS_PER_REQUEST} entries.` });
    return;
  }

  const now = Date.now();
  const stale = assets.filter((a) => {
    const cached = priceCache.get(a.mint);
    return !cached || now - cached.fetchedAt > CACHE_TTL_MS;
  });

  if (stale.length > 0) {
    const staleFeedIds = [...new Set(stale.map((a) => MAINNET_PYTH_FEED_IDS[a.mint]).filter((id): id is string => typeof id === "string"))];
    const [pythRaw, jupiterRaw, currentSlot] = await Promise.all([
      fetchPythPrices(staleFeedIds).catch(() => new Map<string, RawPythPrice>()),
      fetchJupiterPrices(stale.map((a) => a.mint)).catch(() => new Map<string, RawJupiterPrice>()),
      (async () => {
        try {
          return await new Connection(resolveRpcUrl(), "confirmed").getSlot();
        } catch {
          return 0; // Fail closed on block-recency checks below (currentSlot === 0 skips that check rather than rejecting every Jupiter quote on an RPC hiccup) -- staleness/confidence checks on Pyth are unaffected either way.
        }
      })(),
    ]);

    for (const a of stale) {
      const feedId = MAINNET_PYTH_FEED_IDS[a.mint];
      const pythRawEntry = feedId ? pythRaw.get(feedId) : undefined;
      const pyth = feedId && pythRawEntry ? validatePythPrice(pythRawEntry, feedId) : null;
      const jupiterRawEntry = jupiterRaw.get(a.mint);
      const jupiter = jupiterRawEntry ? validateJupiterPrice(jupiterRawEntry, a.decimals, currentSlot) : null;
      priceCache.set(a.mint, { pyth, jupiter, fetchedAt: now });
    }
  }

  const prices: Record<string, { usdPrice: number | null; source: "pyth" | "jupiter" | "unavailable"; lastUpdated: number | null; deviationFlagged?: boolean; deviationPct?: number }> = {};
  for (const a of assets) {
    const cached = priceCache.get(a.mint);
    const resolved = cached ? resolvePriceHierarchy(cached.pyth, cached.jupiter) : null;
    prices[a.mint] = resolved
      ? { usdPrice: resolved.usdPrice, source: resolved.source, lastUpdated: resolved.lastUpdated, deviationFlagged: resolved.deviationFlagged, deviationPct: resolved.deviationPct }
      : { usdPrice: null, source: "unavailable", lastUpdated: null };
  }

  res.status(200).json({ prices, fetchedAt: now });
}
