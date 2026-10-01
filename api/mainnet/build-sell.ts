// POST /api/mainnet/build-sell -- builds EVERY unsigned transaction a
// USDC-settled multi-asset Sell needs in one request (see
// lib/mainnet/buildSell.ts). The browser signs them all in one wallet prompt
// and submits; src/merge/lib/multiAssetSellClient.ts is the only caller.
//
// Body: { reserve, wallet, reserveTokensToRedeem, slippageBps?, assetMints?,
//         legsOnly?, redeemDone?, taxOnly?, taxBaseUsdcRaw? }
//   taxOnly=true + taxBaseUsdcRaw: rebuild ONLY the Sell-tax transaction
//   (DEC-0198) on the base the original build reported (its blockhash
//   expired after the swaps landed); rate + destinations re-read live.
// 200:  BuildSellResult; 4xx/5xx: { error, ...extra }
import { Connection, PublicKey } from "@solana/web3.js";
import { buildReadOnlyProgram } from "@ssr/sdk";
import { checkRateWindow } from "../devnet/_lib/rateLimit";
import { type ApiRequest, type ApiResponse, parseJsonBody } from "../devnet/_lib/apiTypes";
import { resolveRpcUrl, redactRpcSecrets } from "./_lib/rpc";
import { lookupReserveAlt, lookupTradeTax } from "./build-buy";
import { BASE58_RE, DEFAULT_SLIPPAGE_BPS, MAX_SLIPPAGE_BPS, U64_MAX, buildJupiterSwapInstructionsWithRetry, buildJupiterSwapTransactionWithRetry, fetchJupiterQuoteWithRetry } from "../../lib/mainnet/jupiter";
import { BuildError, serializeBuildResult } from "../../lib/mainnet/buildCommon";
import { buildSellTransactions } from "../../lib/mainnet/buildSell";

interface ApiResponseWithHeaders extends ApiResponse {
  setHeader?(name: string, value: string): void;
}

const PROGRAM_ID = new PublicKey("8hTW7fHwn8t8hcgTVeyAhHMiCTHGUP3783NWUTBBFwH9");

function clientIp(req: ApiRequest): string {
  const fwd = req.headers["x-forwarded-for"];
  const raw = Array.isArray(fwd) ? fwd[0] : fwd;
  return (raw ?? "unknown").split(",")[0].trim();
}

export default async function handler(req: ApiRequest, res: ApiResponseWithHeaders) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }
  if (!checkRateWindow(`mainnet-build-sell:${clientIp(req)}`, 60_000, 30)) {
    res.setHeader?.("Retry-After", "10");
    res.status(429).json({ error: "Too many sale builds from this client -- wait a moment and try again." });
    return;
  }

  const body = parseJsonBody(req);
  const reserve = typeof body.reserve === "string" ? body.reserve : "";
  const wallet = typeof body.wallet === "string" ? body.wallet : "";
  const toRedeemRaw = typeof body.reserveTokensToRedeem === "string" ? body.reserveTokensToRedeem : "";
  const slippageBps = typeof body.slippageBps === "number" && Number.isFinite(body.slippageBps) ? Math.round(body.slippageBps) : DEFAULT_SLIPPAGE_BPS;
  const assetMintsRaw = Array.isArray(body.assetMints) ? (body.assetMints as unknown[]) : null;
  const legsOnlyRaw = Array.isArray(body.legsOnly) ? (body.legsOnly as unknown[]) : null;
  const redeemDone = body.redeemDone === true;
  const taxOnly = body.taxOnly === true;
  const taxBaseRaw = typeof body.taxBaseUsdcRaw === "string" ? body.taxBaseUsdcRaw : "";

  if (!BASE58_RE.test(reserve) || !BASE58_RE.test(wallet)) {
    res.status(400).json({ error: "reserve and wallet must be valid base58 addresses." });
    return;
  }
  let reserveTokensToRedeem: bigint;
  try {
    reserveTokensToRedeem = BigInt(toRedeemRaw);
  } catch {
    res.status(400).json({ error: "Invalid reserveTokensToRedeem." });
    return;
  }
  if (reserveTokensToRedeem <= 0n || reserveTokensToRedeem > U64_MAX) {
    res.status(400).json({ error: "reserveTokensToRedeem must be a positive integer." });
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
  let taxOnlyInput: { baseUsdcRaw: bigint } | null = null;
  if (taxOnly) {
    try {
      const base = BigInt(taxBaseRaw);
      if (base <= 0n || base > U64_MAX) throw new Error("range");
      taxOnlyInput = { baseUsdcRaw: base };
    } catch {
      res.status(400).json({ error: "taxOnly needs a positive taxBaseUsdcRaw." });
      return;
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
    const result = await buildSellTransactions(
      {
        connection,
        program,
        ssrProgramId: PROGRAM_ID,
        jupiterApiKey: apiKey,
        jupiterQuote: fetchJupiterQuoteWithRetry,
        jupiterBuildTransaction: buildJupiterSwapTransactionWithRetry,
        jupiterBuildInstructions: buildJupiterSwapInstructionsWithRetry,
        lookupReserveAlt,
        lookupTradeTax,
        simulate: async (tx) => {
          const sim = await connection.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true });
          return { err: sim.value.err, logs: sim.value.logs ?? null };
        },
      },
      {
        reserve: new PublicKey(reserve),
        wallet: new PublicKey(wallet),
        reserveTokensToRedeem,
        slippageBps,
        assetMints: assetMintsRaw ? (assetMintsRaw as string[]).map((m) => new PublicKey(m)) : null,
        legsOnly: legsOnlyRaw ? (legsOnlyRaw as string[]) : null,
        redeemDone,
        taxOnly: taxOnlyInput,
      },
    );
    res.status(200).json(serializeBuildResult(result));
  } catch (e) {
    if (e instanceof BuildError) {
      if (e.retryAfterSeconds) res.setHeader?.("Retry-After", String(e.retryAfterSeconds));
      res.status(e.status).json({ error: e.message, ...(e.extra ?? {}) });
      return;
    }
    const message = e instanceof Error ? e.message : String(e);
    console.error("api/mainnet/build-sell failed:", redactRpcSecrets(message));
    res.status(500).json({ error: `Could not build this sale right now: ${redactRpcSecrets(message)}` });
  }
}
