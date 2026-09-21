// GET /api/ledger/launchpad-classify-cron -- daily keeper (vercel.json
// `crons`) that classifies catalogue mints by launchpad provenance on-chain
// (lib/ledger/launchpadClassification.ts, packages/sdk/src/launchpads.ts):
// Pump.fun / LetsBONK.fun / Bags.fm, bonding vs graduated, and the venue.
// Bounded per run (never-checked mints first, then bonding-stage re-checks,
// then a slow full re-check), so the whole catalogue converges over a few
// runs and stays fresh afterwards. Requires CRON_SECRET like the other
// ledger crons, and the server-side Mainnet RPC URL (HELIUS_MAINNET_RPC_URL,
// never exposed to the browser). `?dryRun=1` runs without the secret and
// writes nothing; `?limit=<n>` caps the batch.
//
// The result is purely a label: api/ledger/asset-catalogue.ts's eligibility
// gates are untouched by anything this cron writes.
import { runLaunchpadClassification, DEFAULT_BATCH_LIMIT } from "../../lib/ledger/launchpadClassification";

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
  if (process.env.LAUNCHPAD_DETECTION_ENABLED === "false") {
    res.status(200).json({ skipped: true, reason: "LAUNCHPAD_DETECTION_ENABLED=false" });
    return;
  }
  const rpcUrl = process.env.HELIUS_MAINNET_RPC_URL;
  if (!rpcUrl) {
    res.status(503).json({ error: "HELIUS_MAINNET_RPC_URL is not configured -- launchpad classification needs a server-side Mainnet RPC." });
    return;
  }
  const limitRaw = Number(queryValue(req, "limit"));
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(Math.floor(limitRaw), 2000) : DEFAULT_BATCH_LIMIT;
  try {
    if (dryRun) {
      // Classify a small sample without writing: injects a classify that runs the real detector but the job's writes are skipped by using limit 0 on the DB side.
      const { classifyMintsBatch } = await import("../../packages/sdk/src/launchpads");
      const { Connection, PublicKey } = await import("@solana/web3.js");
      const sampleMints = ["BpdHpqznEgYPXZNrJVRZvBhdWoafYLVVuLxTQo34pump", "Dz9mQ9NzkBcCsuGPFJ3r1bS4wgqKMHBPiVuniW8Mbonk", "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"];
      const out = await classifyMintsBatch(new Connection(rpcUrl, "confirmed"), sampleMints.map((m) => new PublicKey(m)));
      res.status(200).json({ dryRun: true, sample: Object.fromEntries([...out.entries()].map(([k, v]) => [k, v.error ?? v.provenance])) });
      return;
    }
    const result = await runLaunchpadClassification({ rpcUrl, limit });
    res.status(200).json(result);
  } catch (e) {
    console.error("api/ledger/launchpad-classify-cron failed:", e);
    res.status(503).json({ error: e instanceof Error ? e.message : "Launchpad classification failed." });
  }
}
