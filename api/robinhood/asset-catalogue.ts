// GET /api/robinhood/asset-catalogue -- the assets a Reserve can hold on
// Robinhood Chain, for the Launch form's Basket Composition step
// (src/merge/components/robinhood/RobinhoodCreateForm.tsx) and the
// Rebalance picker later. Served from Postgres (lib/robinhood/catalogue.ts,
// refreshed daily by api/robinhood/catalogue-refresh-cron.ts); this route
// never touches the chain.
//
// Public, read-only, no secrets -- the same convention as
// api/ledger/asset-catalogue.ts on the Solana side (an ordinary visitor
// composing a Reserve needs it), and it is listed in middleware.ts's
// PUBLIC_READ_API_PATHS for the same reason the metadata GETs are.
//
// Each token carries the Uniswap v3 pool it is priced and bought through,
// so the Launch flow does not have to probe four fee tiers per asset at
// launch time, and `issuer: "robinhood"` is proven by the token's code, not
// its name (see lib/robinhood/catalogueRules.ts).
import { getSql } from "../../lib/robinhood/db";
import { loadRobinhoodCatalogue } from "../../lib/robinhood/catalogue";
import type { RobinhoodCatalogueToken } from "../../lib/robinhood/catalogueRules";

interface ApiRequest {
  method?: string;
}

interface ApiResponse {
  status(code: number): ApiResponse;
  setHeader?(name: string, value: string): void;
  json(body: unknown): void;
}

export interface RobinhoodCatalogueResponse {
  tokens: RobinhoodCatalogueToken[];
  /** When the catalogue job last ran (ISO), or null before the first run. */
  refreshedAt: string | null;
  updatedAt: number;
}

const CACHE_TTL_MS = 5 * 60 * 1000;
let cached: RobinhoodCatalogueResponse | null = null;

export default async function handler(req: ApiRequest, res: ApiResponse) {
  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }
  res.setHeader?.("Cache-Control", "no-store");
  if (cached && Date.now() - cached.updatedAt < CACHE_TTL_MS) {
    res.status(200).json(cached);
    return;
  }
  try {
    const { tokens, updatedAt } = await loadRobinhoodCatalogue(getSql());
    cached = { tokens, refreshedAt: updatedAt, updatedAt: Date.now() };
    res.status(200).json(cached);
  } catch (e) {
    // Never echo the driver's message (it can carry connection details).
    console.error("api/robinhood/asset-catalogue: load failed:", e);
    res.status(503).json({ error: "The Robinhood Chain asset catalogue is temporarily unavailable." });
  }
}
