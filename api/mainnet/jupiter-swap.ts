// POST /api/mainnet/jupiter-swap -- per-swap proxy to Jupiter's paid Swap
// API (JUPITER_API_KEY, server-only secret, never sent to the browser).
// Restricted to USDC-SETTLED swaps only: either USDC -> asset (funding a
// Reserve leg for a launch) or asset -> USDC (converting a redeemed Reserve
// leg back into the settlement currency for a Sell, DEC-0158) -- exactly one
// side of every swap is always USDC. This is not a general-purpose swap
// proxy. The multi-asset Buy no longer goes through here one leg at a time:
// api/mainnet/build-buy.ts builds every leg server-side in parallel using
// the same core (lib/mainnet/jupiter.ts).
//
// Never custodies funds: this endpoint only builds an UNSIGNED transaction
// (Jupiter's own Swap API response) for the caller's OWN wallet to sign and
// submit itself -- exactly the same "server never signs, wallet always
// signs" model every other Mainnet write path in this app already follows
// (see api/mainnet/rpc-proxy.ts's header). A caller who never gets a wallet
// signature never moves anything.
import { checkRateWindow } from "../devnet/_lib/rateLimit";
import {
  BASE58_RE,
  DEFAULT_SLIPPAGE_BPS,
  MAINNET_USDC_MINT,
  MAX_PRICE_IMPACT_PCT,
  MAX_SLIPPAGE_BPS,
  U64_MAX,
  buildJupiterSwapInstructionsWithRetry,
  describeSwapFailure,
  routeLabelsOf,
  buildJupiterSwapTransactionWithRetry,
  fetchJupiterQuoteWithRetry,
  isPriceImpactAcceptable,
  jupiterExhaustedResponse,
} from "../../lib/mainnet/jupiter";

interface ApiRequest {
  method?: string;
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
}

interface ApiResponse {
  status(code: number): ApiResponse;
  json(body: unknown): void;
  setHeader(name: string, value: string): void;
}

function clientIp(req: ApiRequest): string {
  const fwd = req.headers["x-forwarded-for"];
  const raw = Array.isArray(fwd) ? fwd[0] : fwd;
  return (raw ?? "unknown").split(",")[0].trim();
}

function parseBody(req: ApiRequest): Record<string, unknown> {
  if (req.body && typeof req.body === "object") return req.body as Record<string, unknown>;
  if (typeof req.body === "string") {
    try {
      return JSON.parse(req.body);
    } catch {
      return {};
    }
  }
  return {};
}

export default async function handler(req: ApiRequest, res: ApiResponse) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const ip = clientIp(req);
  // 60/min per IP: a many-asset launch/resume still fans several quotes
  // through here; Retry-After tells the paced client (jupiterSwapClient.ts)
  // exactly how long to back off instead of guessing.
  if (!checkRateWindow(`mainnet-jupiter-swap:${ip}`, 60_000, 60)) {
    res.setHeader("Retry-After", "15");
    res.status(429).json({ error: "Too many swap requests from this client -- wait a moment and try again." });
    return;
  }

  // Input is validated before checking configuration/hitting the network --
  // fail fast on a malformed request regardless of deployment state.
  const body = parseBody(req);
  const outputMint = typeof body.outputMint === "string" ? body.outputMint : "";
  // Sell direction (DEC-0158): an explicit non-USDC inputMint sells that
  // asset INTO USDC (outputMint must then be USDC).
  const inputMint = typeof body.inputMint === "string" ? body.inputMint : MAINNET_USDC_MINT;
  const amountRaw = typeof body.amountRaw === "string" ? body.amountRaw : "";
  const userPublicKey = typeof body.userPublicKey === "string" ? body.userPublicKey : "";
  const slippageBps = typeof body.slippageBps === "number" && Number.isFinite(body.slippageBps) ? Math.round(body.slippageBps) : DEFAULT_SLIPPAGE_BPS;
  // mode "instructions" (DEC-0156): raw instruction set + lookup-table
  // addresses for composing several swaps + a redeem into ONE transaction.
  const mode = body.mode === "instructions" ? "instructions" : "transaction";
  // maxAccounts (DEC-0161): bounds how many accounts Jupiter's route may use.
  const maxAccounts =
    typeof body.maxAccounts === "number" && Number.isFinite(body.maxAccounts) ? Math.min(64, Math.max(8, Math.round(body.maxAccounts))) : null;
  // `receiveWrappedSol` is accepted for compatibility but changes nothing:
  // EVERY swap is built with wrapAndUnwrapSol:false (lib/mainnet/jupiter.ts).
  void body.receiveWrappedSol;

  if (inputMint === MAINNET_USDC_MINT) {
    if (!BASE58_RE.test(outputMint) || outputMint === MAINNET_USDC_MINT) {
      res.status(400).json({ error: "Invalid or unsupported outputMint." });
      return;
    }
  } else {
    if (!BASE58_RE.test(inputMint)) {
      res.status(400).json({ error: "Invalid inputMint." });
      return;
    }
    if (outputMint !== MAINNET_USDC_MINT) {
      res.status(400).json({ error: "A non-USDC inputMint may only swap into USDC (outputMint must be the USDC mint)." });
      return;
    }
  }
  if (!BASE58_RE.test(userPublicKey)) {
    res.status(400).json({ error: "Invalid userPublicKey." });
    return;
  }
  let amount: bigint;
  try {
    amount = BigInt(amountRaw);
  } catch {
    res.status(400).json({ error: "Invalid amountRaw." });
    return;
  }
  if (amount <= 0n || amount > U64_MAX) {
    res.status(400).json({ error: "amountRaw must be a positive integer." });
    return;
  }
  if (slippageBps < 1 || slippageBps > MAX_SLIPPAGE_BPS) {
    res.status(400).json({ error: `slippageBps must be between 1 and ${MAX_SLIPPAGE_BPS}.` });
    return;
  }

  const apiKey = process.env.JUPITER_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: "Jupiter swap is not configured on this deployment." });
    return;
  }

  const quoteResult = await fetchJupiterQuoteWithRetry({ inputMint, outputMint, amount, slippageBps, maxAccounts, apiKey });
  if (quoteResult.kind === "specific-error") {
    // DEC-0199: name the amount, the asset and the excluded venues rather
    // than passing Jupiter's bare string through with no context.
    res.status(502).json({ error: describeSwapFailure({ stage: "quote", inputMint, outputMint, amountRaw: amount, message: quoteResult.message }) });
    return;
  }
  if (quoteResult.kind === "exhausted") {
    const r = jupiterExhaustedResponse("quote", quoteResult.lastStatus);
    if (r.retryAfterSeconds) res.setHeader("Retry-After", String(r.retryAfterSeconds));
    res.status(r.status).json({ error: r.error });
    return;
  }
  const quote = quoteResult.value;

  if (!isPriceImpactAcceptable(quote)) {
    res.status(422).json({ error: `This swap's price impact (${Number(quote.priceImpactPct).toFixed(1)}%) is too high to execute automatically -- this asset's on-chain liquidity is too thin right now.` });
    return;
  }
  void MAX_PRICE_IMPACT_PCT;

  const built = mode === "instructions"
    ? await buildJupiterSwapInstructionsWithRetry({ quote, userPublicKey, apiKey })
    : await buildJupiterSwapTransactionWithRetry({ quote, userPublicKey, apiKey });
  if (built.kind === "specific-error") {
    res.status(502).json({ error: describeSwapFailure({ stage: "build", inputMint, outputMint, amountRaw: amount, quote, message: built.message }), routeLabels: routeLabelsOf(quote) });
    return;
  }
  if (built.kind === "exhausted") {
    const r = jupiterExhaustedResponse("transaction", built.lastStatus);
    if (r.retryAfterSeconds) res.setHeader("Retry-After", String(r.retryAfterSeconds));
    res.status(r.status).json({ error: r.error });
    return;
  }

  res.status(200).json({
    ...built.value,
    inAmount: quote.inAmount,
    outAmount: quote.outAmount,
    priceImpactPct: quote.priceImpactPct,
    // The venues this swap actually routes through -- surfaced so a later
    // on-chain failure can name them too (DEC-0199).
    routeLabels: routeLabelsOf(quote),
  });
}
