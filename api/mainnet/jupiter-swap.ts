// POST /api/mainnet/jupiter-swap -- the ONLY route to Jupiter's paid Swap
// API (JUPITER_API_KEY, server-only secret, never sent to the browser).
// Restricted to USDC-in swaps only (the app's own real Circle USDC mint,
// MAINNET_USDC_MINT) -- this is not a general-purpose swap proxy, it exists
// solely to let CreateDTR.tsx acquire a non-USDC Reserve Asset for seeding
// (see docs/project/DECISION_LOG.md's entry for this pass).
//
// Never custodies funds: this endpoint only builds an UNSIGNED transaction
// (Jupiter's own Swap API response) for the caller's OWN wallet to sign and
// submit itself -- exactly the same "server never signs, wallet always
// signs" model every other Mainnet write path in this app already follows
// (see api/mainnet/rpc-proxy.ts's header). A caller who never gets a wallet
// signature never moves anything.
import { checkRateWindow } from "../devnet/_lib/rateLimit";

interface ApiRequest {
  method?: string;
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
}

interface ApiResponse {
  status(code: number): ApiResponse;
  json(body: unknown): void;
}

const MAINNET_USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const JUPITER_QUOTE_URL = "https://api.jup.ag/swap/v1/quote";
const JUPITER_SWAP_URL = "https://api.jup.ag/swap/v1/swap";

const DEFAULT_SLIPPAGE_BPS = 150; // 1.5% -- generous enough for thinner-liquidity pump.fun-style tokens without being reckless.
const MAX_SLIPPAGE_BPS = 500; // 5% hard ceiling -- a caller cannot ask for more.
// Server-side backstop against an egregious trade landing even if a client
// somehow skips its own price-impact check -- CreateDTR.tsx additionally
// warns/blocks well below this.
const MAX_PRICE_IMPACT_PCT = 15;

const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

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

interface JupiterQuote {
  inAmount: string;
  outAmount: string;
  priceImpactPct: string;
  [key: string]: unknown;
}

export default async function handler(req: ApiRequest, res: ApiResponse) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const ip = clientIp(req);
  if (!checkRateWindow(`mainnet-jupiter-swap:${ip}`, 60_000, 12)) {
    res.status(429).json({ error: "Too many swap requests from this client -- wait a moment and try again." });
    return;
  }

  // Input is validated before checking configuration/hitting the network --
  // fail fast on a malformed request regardless of deployment state.
  const body = parseBody(req);
  const outputMint = typeof body.outputMint === "string" ? body.outputMint : "";
  const amountRaw = typeof body.amountRaw === "string" ? body.amountRaw : "";
  const userPublicKey = typeof body.userPublicKey === "string" ? body.userPublicKey : "";
  const slippageBps = typeof body.slippageBps === "number" && Number.isFinite(body.slippageBps) ? Math.round(body.slippageBps) : DEFAULT_SLIPPAGE_BPS;

  if (!BASE58_RE.test(outputMint) || outputMint === MAINNET_USDC_MINT) {
    res.status(400).json({ error: "Invalid or unsupported outputMint." });
    return;
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
  if (amount <= 0n) {
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

  let quote: JupiterQuote;
  try {
    const quoteUrl = `${JUPITER_QUOTE_URL}?inputMint=${MAINNET_USDC_MINT}&outputMint=${outputMint}&amount=${amount.toString()}&slippageBps=${slippageBps}&swapMode=ExactIn`;
    const quoteRes = await fetch(quoteUrl, { headers: { "x-api-key": apiKey } });
    if (!quoteRes.ok) {
      const errBody = await quoteRes.json().catch(() => null);
      res.status(502).json({ error: (errBody && typeof errBody.error === "string" && errBody.error) || "No Jupiter swap route is currently available for this asset." });
      return;
    }
    quote = (await quoteRes.json()) as JupiterQuote;
  } catch {
    res.status(502).json({ error: "Jupiter quote request failed." });
    return;
  }

  const priceImpactPct = Number(quote.priceImpactPct);
  if (Number.isFinite(priceImpactPct) && priceImpactPct > MAX_PRICE_IMPACT_PCT) {
    res.status(422).json({ error: `This swap's price impact (${priceImpactPct.toFixed(1)}%) is too high to execute automatically -- this asset's on-chain liquidity is too thin right now.` });
    return;
  }

  try {
    const swapRes = await fetch(JUPITER_SWAP_URL, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": apiKey },
      body: JSON.stringify({ quoteResponse: quote, userPublicKey, dynamicComputeUnitLimit: true }),
    });
    const swapBody = await swapRes.json().catch(() => null);
    if (!swapRes.ok || !swapBody || typeof swapBody.swapTransaction !== "string" || typeof swapBody.lastValidBlockHeight !== "number") {
      res.status(502).json({ error: (swapBody && typeof swapBody.error === "string" && swapBody.error) || "Failed to build the Jupiter swap transaction." });
      return;
    }
    res.status(200).json({
      swapTransaction: swapBody.swapTransaction,
      lastValidBlockHeight: swapBody.lastValidBlockHeight,
      inAmount: quote.inAmount,
      outAmount: quote.outAmount,
      priceImpactPct: quote.priceImpactPct,
    });
  } catch {
    res.status(502).json({ error: "Jupiter swap-transaction request failed." });
  }
}
