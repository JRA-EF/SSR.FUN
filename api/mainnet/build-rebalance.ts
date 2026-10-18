// POST /api/mainnet/build-rebalance (DEC-0250): builds every transaction a
// real rebalance needs -- targets, one co-signed swap per leg, removal of
// emptied assets -- for the Manager's wallet to sign in one approval. See
// lib/mainnet/buildRebalance.ts. Nothing moves without that signature.
import { Connection, PublicKey } from "@solana/web3.js";
import { buildReadOnlyProgram } from "@ssr/sdk";
import { checkRateWindow } from "../devnet/_lib/rateLimit";
import { type ApiRequest, type ApiResponse, parseJsonBody } from "../devnet/_lib/apiTypes";
import { resolveRpcUrl, redactRpcSecrets } from "./_lib/rpc";
import { fetchJupiterPrices } from "./asset-prices";
import { BASE58_RE, buildJupiterSwapInstructionsWithRetry, fetchJupiterQuoteWithRetry } from "../../lib/mainnet/jupiter";
import { BuildError, serializeBuildResult } from "../../lib/mainnet/buildCommon";
import { buildRebalanceTransactions, isRebalanceSwapLive } from "../../lib/mainnet/buildRebalance";
import { MAINNET_TREASURY_VAULT } from "../../lib/mainnet/buildCommon";
import { loadFeeQuoteSigner } from "../../lib/mainnet/usdcMintFee";
import { lookupReserveAlt } from "./build-buy";

interface ApiResponseWithHeaders extends ApiResponse {
  setHeader?(name: string, value: string): void;
}

const PROGRAM_ID = new PublicKey("8hTW7fHwn8t8hcgTVeyAhHMiCTHGUP3783NWUTBBFwH9");

export function parseRebalanceRequest(body: Record<string, unknown>): { reserve: string; signer: string; targets: { mint: string; targetBps: number }[] } {
  const reserve = typeof body.reserve === "string" ? body.reserve : "";
  const signer = typeof body.signer === "string" ? body.signer : "";
  if (!BASE58_RE.test(reserve) || !BASE58_RE.test(signer)) throw new Error("reserve and signer must be valid addresses.");
  const raw = Array.isArray(body.targets) ? body.targets : [];
  if (raw.length < 1 || raw.length > 24) throw new Error("targets must list 1 to 24 assets.");
  const targets = raw.map((t) => {
    const x = (t ?? {}) as Record<string, unknown>;
    if (typeof x.mint !== "string" || !BASE58_RE.test(x.mint)) throw new Error("Each target needs a valid mint.");
    if (!Number.isInteger(x.targetBps) || (x.targetBps as number) < 0 || (x.targetBps as number) > 10_000) throw new Error("Each target weight must be a whole number of basis points from 0 to 10000.");
    return { mint: x.mint, targetBps: x.targetBps as number };
  });
  return { reserve, signer, targets };
}

export default async function handler(req: ApiRequest, res: ApiResponseWithHeaders) {
  res.setHeader?.("Cache-Control", "no-store");
  // GET: is the real rebalance available on the deployed program yet?
  if (req.method === "GET") {
    const connection = new Connection(resolveRpcUrl(), "confirmed");
    try {
      const live = await isRebalanceSwapLive(
        async (tx) => ({ err: (await connection.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true })).value.err }),
        new PublicKey(MAINNET_TREASURY_VAULT),
        PROGRAM_ID,
      );
      res.setHeader?.("Cache-Control", "public, s-maxage=60");
      res.status(200).json({ live });
    } catch {
      res.status(200).json({ live: false });
    }
    return;
  }
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }
  const fwd = req.headers["x-forwarded-for"];
  const ip = (Array.isArray(fwd) ? fwd[0] : fwd ?? "unknown").split(",")[0].trim();
  if (!checkRateWindow(`mainnet-build-rebalance:${ip}`, 60_000, 6)) {
    res.setHeader?.("Retry-After", "15");
    res.status(429).json({ error: "Too many rebalance builds from this client -- wait a moment and try again." });
    return;
  }
  let input;
  try {
    input = parseRebalanceRequest(parseJsonBody(req));
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : "Invalid rebalance request." });
    return;
  }
  const apiKey = process.env.JUPITER_API_KEY ?? "";
  const connection = new Connection(resolveRpcUrl(), "confirmed");
  const program = buildReadOnlyProgram(connection) as any;
  try {
    const result = await buildRebalanceTransactions(
      {
        connection,
        program,
        ssrProgramId: PROGRAM_ID,
        lookupReserveAlt,
        fetchPrices: fetchJupiterPrices,
        feeQuoteSigner: process.env.SSR_FEE_SETTLEMENT_KEEPER_SECRET ? loadFeeQuoteSigner() : null,
        jupiterQuote: (p) => fetchJupiterQuoteWithRetry({ ...p, apiKey }),
        jupiterInstructions: (quote, userPublicKey) => buildJupiterSwapInstructionsWithRetry({ quote, userPublicKey, apiKey, dynamicSlippage: false }),
        simulate: async (tx) => {
          const sim = await connection.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true });
          return { err: sim.value.err, logs: sim.value.logs ?? null };
        },
      },
      { reserve: new PublicKey(input.reserve), signer: new PublicKey(input.signer), targets: input.targets },
    );
    res.status(200).json(serializeBuildResult(result));
  } catch (e) {
    if (e instanceof BuildError) {
      if (e.retryAfterSeconds) res.setHeader?.("Retry-After", String(e.retryAfterSeconds));
      res.status(e.status).json({ error: e.message, ...(e.extra ?? {}) });
      return;
    }
    res.status(502).json({ error: redactRpcSecrets(`Could not build the rebalance: ${e instanceof Error ? e.message : String(e)}`) });
  }
}
