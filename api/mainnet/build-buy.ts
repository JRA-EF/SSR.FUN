// POST /api/mainnet/build-buy -- builds EVERY unsigned transaction a
// multi-asset Buy needs in one request (see lib/mainnet/buildBuy.ts for the
// design: server-built, sign-many, everything parallel, server signs
// nothing). The browser then signs them all in one wallet prompt and
// submits; src/merge/lib/multiAssetBuyClient.ts is the only caller.
//
// Body: { reserve, wallet, reserveTokensRequested, slippageBps?, assetMints?,
//         acquiredRawByMint?, legsOnly?, mintOnly? }
// 200:  BuildBuyResult (mode, transactions[], plan, reserveAlt, altToRegister,
//       blockhash, lastValidBlockHeight, timings)
// 4xx/5xx: { error, ...extra }
import { Connection, PublicKey } from "@solana/web3.js";
import { buildReadOnlyProgram } from "@ssr/sdk";
import { checkRateWindow } from "../devnet/_lib/rateLimit";
import { type ApiRequest, type ApiResponse, parseJsonBody } from "../devnet/_lib/apiTypes";
import { resolveRpcUrl, redactRpcSecrets } from "./_lib/rpc";
import { fetchJupiterPrices } from "./asset-prices";
import { getSql } from "../../lib/reserve-metadata/db";
import {
  BASE58_RE,
  DEFAULT_SLIPPAGE_BPS,
  MAX_SLIPPAGE_BPS,
  U64_MAX,
  buildJupiterSwapInstructionsWithRetry,
  buildJupiterSwapTransactionWithRetry,
  fetchJupiterQuoteWithRetry,
} from "../../lib/mainnet/jupiter";
import { BuildBuyError, buildBuyTransactions, serializeBuildBuyResult } from "../../lib/mainnet/buildBuy";

interface ApiResponseWithHeaders extends ApiResponse {
  setHeader?(name: string, value: string): void;
}

const PROGRAM_ID = new PublicKey("8hTW7fHwn8t8hcgTVeyAhHMiCTHGUP3783NWUTBBFwH9");

function clientIp(req: ApiRequest): string {
  const fwd = req.headers["x-forwarded-for"];
  const raw = Array.isArray(fwd) ? fwd[0] : fwd;
  return (raw ?? "unknown").split(",")[0].trim();
}

/** The Reserve's registered trading lookup table, straight from the registry (same table api/mainnet/reserve-alt.ts serves). */
export async function lookupReserveAlt(reserve: string): Promise<string | null> {
  const sql = getSql();
  await sql`create table if not exists reserve_alts (reserve text primary key, alt text not null, updated_at timestamptz not null default now())`;
  const rows = (await sql`select alt from reserve_alts where reserve = ${reserve}`) as { alt: string }[];
  return rows[0]?.alt ?? null;
}

export default async function handler(req: ApiRequest, res: ApiResponseWithHeaders) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }
  // 30/min per IP: one build per Buy plus at most a couple of legsOnly /
  // mintOnly rebuilds -- a hammering client is blunted, a real purchase never is.
  if (!checkRateWindow(`mainnet-build-buy:${clientIp(req)}`, 60_000, 30)) {
    res.setHeader?.("Retry-After", "10");
    res.status(429).json({ error: "Too many purchase builds from this client -- wait a moment and try again." });
    return;
  }

  const body = parseJsonBody(req);
  const reserve = typeof body.reserve === "string" ? body.reserve : "";
  const wallet = typeof body.wallet === "string" ? body.wallet : "";
  const requestedRaw = typeof body.reserveTokensRequested === "string" ? body.reserveTokensRequested : "";
  const slippageBps = typeof body.slippageBps === "number" && Number.isFinite(body.slippageBps) ? Math.round(body.slippageBps) : DEFAULT_SLIPPAGE_BPS;
  const assetMintsRaw = Array.isArray(body.assetMints) ? (body.assetMints as unknown[]) : null;
  const acquiredRaw = body.acquiredRawByMint && typeof body.acquiredRawByMint === "object" ? (body.acquiredRawByMint as Record<string, unknown>) : {};
  const legsOnlyRaw = Array.isArray(body.legsOnly) ? (body.legsOnly as unknown[]) : null;
  const mintOnly = body.mintOnly === true;

  if (!BASE58_RE.test(reserve) || !BASE58_RE.test(wallet)) {
    res.status(400).json({ error: "reserve and wallet must be valid base58 addresses." });
    return;
  }
  let reserveTokensRequested: bigint;
  try {
    reserveTokensRequested = BigInt(requestedRaw);
  } catch {
    res.status(400).json({ error: "Invalid reserveTokensRequested." });
    return;
  }
  if (reserveTokensRequested <= 0n || reserveTokensRequested > U64_MAX) {
    res.status(400).json({ error: "reserveTokensRequested must be a positive integer." });
    return;
  }
  if (slippageBps < 1 || slippageBps > MAX_SLIPPAGE_BPS) {
    res.status(400).json({ error: `slippageBps must be between 1 and ${MAX_SLIPPAGE_BPS}.` });
    return;
  }
  if (assetMintsRaw && (assetMintsRaw.length > 12 || assetMintsRaw.some((m) => typeof m !== "string" || !BASE58_RE.test(m)))) {
    res.status(400).json({ error: "assetMints must be up to 12 valid base58 mint addresses." });
    return;
  }
  if (legsOnlyRaw && legsOnlyRaw.some((m) => typeof m !== "string" || !BASE58_RE.test(m))) {
    res.status(400).json({ error: "legsOnly must be valid base58 mint addresses." });
    return;
  }
  const acquiredRawByMint: Record<string, bigint> = {};
  for (const [mint, v] of Object.entries(acquiredRaw)) {
    if (!BASE58_RE.test(mint) || typeof v !== "string") continue;
    try {
      const n = BigInt(v);
      if (n > 0n) acquiredRawByMint[mint] = n;
    } catch {
      // ignore malformed entries -- the plan simply counts nothing for them
    }
  }

  const apiKey = process.env.JUPITER_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: "Jupiter swap is not configured on this deployment." });
    return;
  }

  const connection = new Connection(resolveRpcUrl(), "confirmed");
  const program = buildReadOnlyProgram(connection) as any;
  try {
    const result = await buildBuyTransactions(
      {
        connection,
        program,
        ssrProgramId: PROGRAM_ID,
        jupiterApiKey: apiKey,
        fetchPrices: fetchJupiterPrices,
        jupiterQuote: fetchJupiterQuoteWithRetry,
        jupiterBuildTransaction: buildJupiterSwapTransactionWithRetry,
        jupiterBuildInstructions: buildJupiterSwapInstructionsWithRetry,
        lookupReserveAlt,
        simulate: async (tx) => {
          const sim = await connection.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true });
          return { err: sim.value.err, logs: sim.value.logs ?? null };
        },
      },
      {
        reserve: new PublicKey(reserve),
        wallet: new PublicKey(wallet),
        reserveTokensRequested,
        slippageBps,
        assetMints: assetMintsRaw ? (assetMintsRaw as string[]).map((m) => new PublicKey(m)) : null,
        acquiredRawByMint,
        legsOnly: legsOnlyRaw ? (legsOnlyRaw as string[]) : null,
        mintOnly,
      },
    );
    res.status(200).json(serializeBuildBuyResult(result));
  } catch (e) {
    if (e instanceof BuildBuyError) {
      if (e.retryAfterSeconds) res.setHeader?.("Retry-After", String(e.retryAfterSeconds));
      res.status(e.status).json({ error: e.message, ...(e.extra ?? {}) });
      return;
    }
    const message = e instanceof Error ? e.message : String(e);
    console.error("api/mainnet/build-buy failed:", redactRpcSecrets(message));
    res.status(500).json({ error: `Could not build this purchase right now: ${redactRpcSecrets(message)}` });
  }
}
