// /api/mainnet/reserve-entry-prices -- the Reserve Asset Entry Price Store
// behind the Reserve Composition card's per-asset P&L (current price vs.
// price when the asset was added -- see docs/project/DECISION_LOG.md's entry
// for this change).
//
// GET  -> { entries: { <reserve>: { <mint>: <entryPriceUsd> } } } -- the
// whole map, one small request per discovery pass (RealReserveSync), same
// shape of flow as reserve-image's GET ?pointers=1.
//
// POST { pairs: [{reserve, mint, decimals}] } -> captures an entry price for
// every named (reserve, mint) pair that doesn't have one yet. THE PRICE IS
// NEVER CLIENT-SUPPLIED: this handler prices each mint itself through the
// exact same validated Pyth/Jupiter hierarchy as api/mainnet/asset-prices.ts
// ("never trust client-supplied prices" -- docs/protocol/SSR_ARCHITECTURE.md).
// Rows are write-once (`on conflict do nothing`): an entry price is a
// historical fact. A pair whose mint can't be priced this pass is simply
// skipped -- it stays missing from the map, so the client's next discovery
// pass requests it again until a validated price exists.
//
// Like the image/pointer store, this write is public and unauthenticated --
// but the only thing a caller can cause is a genuine, server-priced
// market-price snapshot for a (reserve, mint) pair at the time of their
// call, bounded by the same per-IP rate window as asset-prices. Junk pairs
// for addresses that aren't real Reserves are inert: the frontend only ever
// looks up pairs it discovered on-chain.
import { checkRateWindow } from "../devnet/_lib/rateLimit";
import { parseJsonBody } from "../devnet/_lib/apiTypes";
import { resolveRpcUrl } from "./_lib/rpc";
import { Connection } from "@solana/web3.js";
import { fetchPythPrices, fetchJupiterPrices } from "./asset-prices";
import { validateEntryPricePairs, type EntryPricePair } from "../../lib/reserve-entry-price/payload";
import { getSql } from "../../lib/reserve-entry-price/db";
import {
  MAINNET_PYTH_FEED_IDS,
  validatePythPrice,
  validateJupiterPrice,
  resolvePriceHierarchy,
  type RawPythPrice,
  type RawJupiterPrice,
} from "@ssr/sdk";

interface ApiRequest {
  method?: string;
  headers: Record<string, string | string[] | undefined>;
  url?: string;
  body?: unknown;
}

interface ApiResponse {
  status(code: number): ApiResponse;
  setHeader?(name: string, value: string): void;
  json(body: unknown): void;
}

export default async function handler(req: ApiRequest, res: ApiResponse) {
  res.setHeader?.("Cache-Control", "no-store");

  if (req.method === "GET") {
    try {
      const sql = getSql();
      const rows = (await sql`select reserve, mint, entry_price_usd from reserve_asset_entry_price`) as { reserve: string; mint: string; entry_price_usd: number }[];
      const entries: Record<string, Record<string, number>> = {};
      for (const r of rows) {
        (entries[r.reserve] ??= {})[r.mint] = r.entry_price_usd;
      }
      res.status(200).json({ entries });
    } catch (e) {
      res.status(503).json({ error: e instanceof Error ? e.message : "Failed to read the Reserve entry prices." });
    }
    return;
  }

  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const fwd = req.headers["x-forwarded-for"];
  const ip = (Array.isArray(fwd) ? fwd[0] : fwd) ?? "unknown";
  if (!checkRateWindow(`mainnet-entry-prices:${ip.split(",")[0].trim()}`, 60_000, 20)) {
    res.status(429).json({ error: "Too many entry-price requests from this client -- wait a moment and try again." });
    return;
  }

  let pairs: EntryPricePair[];
  try {
    pairs = validateEntryPricePairs(parseJsonBody(req).pairs);
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : "Invalid entry-price request." });
    return;
  }

  try {
    const sql = getSql();
    // Narrow to pairs that don't have an entry price yet -- write-once rows,
    // and no reason to price a mint whose pairs are all already captured.
    const reserves = [...new Set(pairs.map((p) => p.reserve))];
    const existing = (await sql`select reserve, mint from reserve_asset_entry_price where reserve = any(${reserves})`) as { reserve: string; mint: string }[];
    const existingKeys = new Set(existing.map((r) => `${r.reserve}:${r.mint}`));
    const missing = pairs.filter((p) => !existingKeys.has(`${p.reserve}:${p.mint}`));
    if (missing.length === 0) {
      res.status(200).json({ ok: true, captured: 0 });
      return;
    }

    // Price the distinct missing mints through the same hierarchy as
    // asset-prices.ts: verified Pyth Core feed first, Jupiter Price V3 as
    // the fallback, both validated in packages/sdk/src/pricing.ts.
    const mintDecimals = new Map<string, number>();
    for (const p of missing) if (!mintDecimals.has(p.mint)) mintDecimals.set(p.mint, p.decimals);
    const mints = [...mintDecimals.keys()];
    const feedIds = [...new Set(mints.map((m) => MAINNET_PYTH_FEED_IDS[m]).filter((id): id is string => typeof id === "string"))];
    const [pythRaw, jupiterRaw, currentSlot] = await Promise.all([
      fetchPythPrices(feedIds).catch(() => new Map<string, RawPythPrice>()),
      fetchJupiterPrices(mints).catch(() => new Map<string, RawJupiterPrice>()),
      (async () => {
        try {
          return await new Connection(resolveRpcUrl(), "confirmed").getSlot();
        } catch {
          return 0; // Same fail-open block-recency behavior as asset-prices.ts.
        }
      })(),
    ]);

    const priced = new Map<string, { usdPrice: number; source: string }>();
    for (const [mint, decimals] of mintDecimals) {
      const feedId = MAINNET_PYTH_FEED_IDS[mint];
      const pythRawEntry = feedId ? pythRaw.get(feedId) : undefined;
      const pyth = feedId && pythRawEntry ? validatePythPrice(pythRawEntry, feedId) : null;
      const jupiterRawEntry = jupiterRaw.get(mint);
      const jupiter = jupiterRawEntry ? validateJupiterPrice(jupiterRawEntry, decimals, currentSlot) : null;
      const resolved = resolvePriceHierarchy(pyth, jupiter);
      if (resolved && resolved.usdPrice !== null && resolved.usdPrice > 0) {
        priced.set(mint, { usdPrice: resolved.usdPrice, source: resolved.source });
      }
    }

    let captured = 0;
    for (const p of missing) {
      const price = priced.get(p.mint);
      if (!price) continue; // Unpriced this pass -- the client retries on a later discovery pass.
      await sql`
        insert into reserve_asset_entry_price (reserve, mint, entry_price_usd, source)
        values (${p.reserve}, ${p.mint}, ${price.usdPrice}, ${price.source})
        on conflict (reserve, mint) do nothing
      `;
      captured++;
    }
    res.status(200).json({ ok: true, captured });
  } catch (e) {
    res.status(503).json({ error: e instanceof Error ? e.message : "Failed to capture the Reserve entry prices." });
  }
}
