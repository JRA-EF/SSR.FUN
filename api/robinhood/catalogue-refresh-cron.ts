// GET /api/robinhood/catalogue-refresh-cron -- daily keeper (vercel.json
// `crons`) that advances the Robinhood Chain asset catalogue
// (lib/robinhood/catalogue.ts): new Uniswap v3 pools since the last run,
// fresh depth/price for every live pool, classification of every token.
// Requires CRON_SECRET like the other crons. Reads the chain through
// ROBINHOOD_RPC_URL (the keyed provider, server-side only) and falls back
// to the public RPC when it is unset or refuses historical logs.
// `?dryRun=1` runs without the secret and only reports where the scan is.
//
// The first full walk of the chain is NOT done here (it is minutes of
// adaptive log scanning); run scripts/robinhood-catalogue-backfill.mts once,
// then this cron keeps up with a day of blocks per run.
import { getSql } from "../../lib/robinhood/db";
import { PUBLIC_RPC_URL, runRobinhoodCatalogueRefresh } from "../../lib/robinhood/catalogue";

interface ApiRequest {
  method?: string;
  headers: Record<string, string | string[] | undefined>;
  query?: Record<string, string | string[] | undefined>;
}

interface ApiResponse {
  status(code: number): ApiResponse;
  json(body: unknown): void;
}

function getHeader(req: ApiRequest, name: string): string | undefined {
  const value = req.headers[name] ?? req.headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

function queryValue(req: ApiRequest, name: string): string | undefined {
  const v = req.query?.[name];
  return Array.isArray(v) ? v[0] : v;
}

/** A day of Robinhood Chain is under a million blocks; two days leaves room for a missed run. */
const BLOCKS_PER_RUN = 2_000_000n;

export default async function handler(req: ApiRequest, res: ApiResponse) {
  if (req.method !== "GET" && req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }
  const dryRun = queryValue(req, "dryRun") === "1" || queryValue(req, "dryRun") === "true";
  if (!dryRun) {
    const expected = process.env.CRON_SECRET;
    const provided = getHeader(req, "authorization");
    if (!expected) {
      res.status(500).json({ error: "CRON_SECRET is not configured on this deployment." });
      return;
    }
    if (provided !== `Bearer ${expected}`) {
      res.status(401).json({ error: "Unauthorized." });
      return;
    }
  }
  const sql = getSql();
  if (dryRun) {
    const state = (await sql`select last_scanned_block::text as "lastScannedBlock", weth_usd::text as "wethUsd", updated_at::text as "updatedAt" from robinhood_catalogue_state where id = 1`) as unknown[];
    const [{ n }] = (await sql`select count(*)::int as n from robinhood_asset_catalogue where eligible = true`) as { n: number }[];
    res.status(200).json({ dryRun: true, state: state[0] ?? null, eligibleTokens: n });
    return;
  }
  try {
    const summary = await runRobinhoodCatalogueRefresh({
      sql,
      rpcUrl: process.env.ROBINHOOD_RPC_URL || PUBLIC_RPC_URL,
      maxBlocksPerRun: BLOCKS_PER_RUN,
      log: (s) => console.log("[robinhood-catalogue]", s),
    });
    res.status(200).json(summary);
  } catch (e) {
    console.error("api/robinhood/catalogue-refresh-cron failed:", e);
    res.status(500).json({ error: "Catalogue refresh failed; see the function logs." });
  }
}
