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
const JUPITER_SWAP_INSTRUCTIONS_URL = "https://api.jup.ag/swap/v1/swap-instructions";

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
  // mode "instructions" (DEC-0156): return Jupiter's raw instruction set +
  // address-lookup-table addresses instead of a fully-built transaction, so
  // the client can compose ALL of a purchase's swaps and the final mint
  // into ONE wallet-signed atomic transaction.
  const mode = body.mode === "instructions" ? "instructions" : "transaction";
  // `receiveWrappedSol` is accepted for compatibility but no longer changes
  // anything: EVERY swap this endpoint builds now sets wrapAndUnwrapSol:
  // false (see the swap-build body below). CONFIRMED LIVE why this must be
  // universal, not per-leg (2026-08-26, signature n6JMY9xFfG7...): a
  // USDC->SSR swap whose route hopped through SOL used the buyer's own wSOL
  // ATA as an intermediate, and Jupiter's default cleanup then CLOSED that
  // ATA -- sweeping the buyer's ENTIRE wSOL balance (including another
  // leg's just-acquired wrapped-SOL deposit) into native SOL, so the mint
  // 8 seconds later failed with SPL Token InsufficientFunds. No flow served
  // by this endpoint ever wants a native-SOL output: swap outputs are
  // Reserve assets, and a wrapped-SOL output must STAY wrapped for the
  // in-kind deposit. Jupiter's own setup instructions still create any ATA
  // a route needs (idempotently); nothing is ever unwrapped or closed.
  void body.receiveWrappedSol;

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
  // Bounded to the u64 range the upstream Jupiter quote API actually accepts
  // -- forwarding anything above this produces a raw upstream Rust parser
  // error (ParseIntError { kind: PosOverflow }), which this route would
  // otherwise relay verbatim as an unhandled-looking 502 instead of the
  // same clean 400 every other invalid-amount case returns.
  const U64_MAX = 18446744073709551615n;
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
  // Re-bound to a definitely-string local: TS control-flow narrowing from
  // the guard above doesn't carry into the nested attemptQuote() closure
  // below, even for a const.
  const jupiterApiKey: string = apiKey;

  // Bounded retry (3 attempts, short backoff) around ONLY the two failure
  // shapes that indicate a transient upstream hiccup rather than Jupiter's
  // own genuine answer: the fetch() call itself throwing (network-level
  // failure), or a non-OK response whose body isn't parseable JSON with a
  // real `.error` string (Jupiter's normal shape for a genuine "no
  // route"/"not tradable" answer IS parseable JSON with a specific message
  // -- see the real observed shape, {"error":"...","errorCode":"..."} --
  // so an unparseable body here means something upstream broke, not that
  // Jupiter deliberately said no). Confirmed live (2026-08-25): a real
  // 10-asset Mainnet Reserve ("DELTA") hit exactly this generic fallback
  // message during Resume, yet a direct, independent read-only check of
  // every one of its assets against Jupiter's own public quote API moments
  // later found EVERY asset had a real, healthy, low-price-impact route --
  // proving the failure was transient (this endpoint's own upstream call,
  // not a genuine lack of liquidity), and retrying does, in fact, resolve
  // it -- exactly the class of failure a bare retry should already recover
  // from before ever reaching the Creator as an error at all.
  // Result of one quote attempt: the real quote, a genuine/specific Jupiter
  // error to report as-is (never retried), or "transient" (worth retrying).
  // A transient result carries the failing status plus an optional
  // Retry-After-derived delay: Jupiter's API gateway rate-limits PER KEY
  // and answers 429 with a `{"message":...}` body (no `.error` field, so
  // the specific-error branch never matches it) -- and a Resume for a
  // many-asset Reserve legitimately fires several quote requests within a
  // couple of seconds, exactly the burst shape that trips a per-key RPM
  // cap. Retrying a 429 after only 400/800ms usually lands INSIDE the same
  // rate window and fails all bounded attempts (live-observed 2026-08-25:
  // a Resume failed with the generic quote-unavailable message while a
  // manual reproduction of the identical request succeeded in 0.4s moments
  // later). A 429 now waits Retry-After (capped) or a full 2s per attempt.
  type QuoteAttemptResult =
    | { kind: "ok"; quote: JupiterQuote }
    | { kind: "specific-error"; message: string }
    | { kind: "transient"; status: number | null; retryAfterMs: number | null };
  function retryAfterMsFrom(res: { headers?: { get(name: string): string | null } }): number | null {
    try {
      const raw = res.headers?.get("retry-after");
      if (!raw) return null;
      const seconds = Number(raw);
      if (!Number.isFinite(seconds) || seconds <= 0) return null;
      return Math.min(seconds, 5) * 1000; // capped -- never stall a user-facing request longer than a few seconds
    } catch {
      return null;
    }
  }
  async function attemptQuote(): Promise<QuoteAttemptResult> {
    try {
      const quoteUrl = `${JUPITER_QUOTE_URL}?inputMint=${MAINNET_USDC_MINT}&outputMint=${outputMint}&amount=${amount.toString()}&slippageBps=${slippageBps}&swapMode=ExactIn`;
      const quoteRes = await fetch(quoteUrl, { headers: { "x-api-key": jupiterApiKey } });
      if (!quoteRes.ok) {
        // Read the RAW text once (never .json() directly) so a genuinely
        // non-JSON response (an HTML error page, an empty body, a gateway
        // error) is still visible in server logs instead of silently
        // vanishing into a `.json().catch(() => null)` -- this endpoint's
        // "transient" classification was previously unauditable: every
        // failure reason was discarded before ever reaching a log line.
        const rawText = await quoteRes.text().catch(() => "<unreadable body>");
        let errBody: { error?: unknown } | null = null;
        try {
          errBody = JSON.parse(rawText);
        } catch {
          errBody = null;
        }
        console.error(`[jupiter-swap] quote non-OK: status=${quoteRes.status} outputMint=${outputMint} body=${rawText.slice(0, 500)}`);
        if (quoteRes.status !== 429 && errBody && typeof errBody.error === "string") return { kind: "specific-error", message: errBody.error };
        return { kind: "transient", status: quoteRes.status, retryAfterMs: retryAfterMsFrom(quoteRes) };
      }
      return { kind: "ok", quote: (await quoteRes.json()) as JupiterQuote };
    } catch (e) {
      console.error(`[jupiter-swap] quote fetch threw: outputMint=${outputMint} error=${e instanceof Error ? e.stack || e.message : String(e)}`);
      return { kind: "transient", status: null, retryAfterMs: null };
    }
  }

  let quote: JupiterQuote | null = null;
  let lastTransientStatus: number | null = null;
  const MAX_QUOTE_ATTEMPTS = 3;
  for (let attempt = 0; attempt < MAX_QUOTE_ATTEMPTS && !quote; attempt++) {
    const result = await attemptQuote();
    if (result.kind === "ok") {
      quote = result.quote;
    } else if (result.kind === "specific-error") {
      // Jupiter's own genuine, specific answer (e.g. "not tradable") -- its
      // normal shape for a real "no route" verdict IS parseable JSON with
      // a message like this; likely stable, so report it as-is rather than
      // retrying further.
      res.status(502).json({ error: result.message });
      return;
    } else {
      lastTransientStatus = result.status;
      if (attempt < MAX_QUOTE_ATTEMPTS - 1) {
        const delayMs = result.status === 429 ? (result.retryAfterMs ?? 2_000) : 400 * (attempt + 1);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }
  if (!quote) {
    // Every attempt either threw or came back rate-limited/unparseable --
    // a real transient condition, never Jupiter's own specific "no route"
    // answer (that path already returned above, on the first occurrence).
    // Wording matters: both messages contain phrases classifyCreateReserveError
    // (createReserveResume.ts) already recognizes as retryable ("too many
    // ... requests" / "network error") -- consistent with every other
    // transient-failure message in this app.
    if (lastTransientStatus === 429) {
      res.status(429).json({ error: "Jupiter's API answered with too many requests for this key right now (a burst of quotes in quick succession) -- wait a few seconds and try again." });
    } else {
      res.status(502).json({ error: "Jupiter's swap-quote service had a network error and is temporarily unavailable for this asset -- wait a moment and try again." });
    }
    return;
  }

  const priceImpactPct = Number(quote.priceImpactPct);
  if (Number.isFinite(priceImpactPct) && priceImpactPct > MAX_PRICE_IMPACT_PCT) {
    res.status(422).json({ error: `This swap's price impact (${priceImpactPct.toFixed(1)}%) is too high to execute automatically -- this asset's on-chain liquidity is too thin right now.` });
    return;
  }

  // Same bounded-retry/genuine-vs-transient treatment as the quote step
  // above, applied to Jupiter's OTHER real call this endpoint makes.
  // Confirmed live (2026-08-25, real Mainnet Reserve "DELTA", immediately
  // after the quote step's own equivalent fix shipped): the exact same
  // failure SHAPE -- a non-OK/malformed response with no usable `.error`
  // string, or a thrown fetch() -- was unhandled here, producing the
  // identical "sounds permanent, isn't" experience one call later in the
  // same request. A genuine, parseable Jupiter error from THIS endpoint
  // (e.g. a real problem with the built transaction) is still reported
  // immediately, unretried -- only an unparseable/thrown failure, which
  // indicates something upstream broke rather than Jupiter deliberately
  // rejecting the request, is retried.
  type SwapBuildResult =
    | { kind: "ok"; payload: Record<string, unknown> }
    | { kind: "specific-error"; message: string }
    | { kind: "transient"; status: number | null; retryAfterMs: number | null };
  async function attemptBuildSwap(): Promise<SwapBuildResult> {
    try {
      const swapRes = await fetch(mode === "instructions" ? JUPITER_SWAP_INSTRUCTIONS_URL : JUPITER_SWAP_URL, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": jupiterApiKey },
        // dynamicSlippage: Jupiter computes its own volatility/route-aware
        // slippage bound (bounded by MAX_SLIPPAGE_BPS's spirit -- Jupiter's
        // own heuristic ceiling in practice) instead of a single fixed
        // client-supplied value, which is what a fixed 150bps default was too
        // tight for on a real low-liquidity/volatile token (see
        // docs/project/DECISION_LOG.md's entry for this pass) -- it can go
        // both tighter (no wasted slippage budget on a stable route) and
        // wider (survives real short-term volatility) than a static number.
        //
        // wrapAndUnwrapSol: false, ALWAYS -- see the long note where
        // `mode` is parsed above (the live 2026-08-26 wSOL-ATA sweep).
        body: JSON.stringify({ quoteResponse: quote, userPublicKey, dynamicComputeUnitLimit: true, dynamicSlippage: true, wrapAndUnwrapSol: false }),
      });
      const rawText = await swapRes.text().catch(() => "<unreadable body>");
      let swapBody: { swapTransaction?: unknown; lastValidBlockHeight?: unknown; swapInstruction?: unknown; error?: unknown } | null = null;
      try {
        swapBody = JSON.parse(rawText);
      } catch {
        swapBody = null;
      }
      if (mode === "transaction" && swapRes.ok && swapBody && typeof swapBody.swapTransaction === "string" && typeof swapBody.lastValidBlockHeight === "number") {
        return { kind: "ok", payload: { swapTransaction: swapBody.swapTransaction, lastValidBlockHeight: swapBody.lastValidBlockHeight } };
      }
      if (mode === "instructions" && swapRes.ok && swapBody && typeof swapBody.swapInstruction === "object" && swapBody.swapInstruction !== null) {
        const b = swapBody as Record<string, unknown>;
        return {
          kind: "ok",
          payload: {
            setupInstructions: Array.isArray(b.setupInstructions) ? b.setupInstructions : [],
            swapInstruction: b.swapInstruction,
            // cleanupInstruction is passed through for transparency; with
            // wrapAndUnwrapSol: false Jupiter emits none, and the client
            // composer never includes one regardless (it would close the
            // buyer's wSOL ATA -- the exact live failure this fixes).
            cleanupInstruction: b.cleanupInstruction ?? null,
            addressLookupTableAddresses: Array.isArray(b.addressLookupTableAddresses) ? b.addressLookupTableAddresses : [],
          },
        };
      }
      // Logged on every non-success outcome (not just a thrown exception) --
      // this is what was completely invisible before: a real Jupiter
      // response (status + body) that failed this endpoint's own shape
      // check, discarded with no trace. See attemptQuote's identical
      // rationale above.
      console.error(`[jupiter-swap] swap-build non-OK/malformed: status=${swapRes.status} outputMint=${outputMint} body=${rawText.slice(0, 500)}`);
      // Same 429 handling as attemptQuote -- Jupiter's per-key rate limit
      // answers with a `{"message":...}` body the specific-error branch
      // never matches, and needs a real (Retry-After-honoring) pause, not a
      // sub-second one.
      if (swapRes.status !== 429 && swapBody && typeof swapBody.error === "string") return { kind: "specific-error", message: swapBody.error };
      return { kind: "transient", status: swapRes.status, retryAfterMs: retryAfterMsFrom(swapRes) };
    } catch (e) {
      console.error(`[jupiter-swap] swap-build fetch threw: outputMint=${outputMint} error=${e instanceof Error ? e.stack || e.message : String(e)}`);
      return { kind: "transient", status: null, retryAfterMs: null };
    }
  }

  let built: Record<string, unknown> | null = null;
  let lastBuildTransientStatus: number | null = null;
  const MAX_SWAP_BUILD_ATTEMPTS = 3;
  for (let attempt = 0; attempt < MAX_SWAP_BUILD_ATTEMPTS && !built; attempt++) {
    const result = await attemptBuildSwap();
    if (result.kind === "ok") {
      built = result.payload;
    } else if (result.kind === "specific-error") {
      res.status(502).json({ error: result.message });
      return;
    } else {
      lastBuildTransientStatus = result.status;
      if (attempt < MAX_SWAP_BUILD_ATTEMPTS - 1) {
        const delayMs = result.status === 429 ? (result.retryAfterMs ?? 2_000) : 400 * (attempt + 1);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }
  if (!built) {
    if (lastBuildTransientStatus === 429) {
      res.status(429).json({ error: "Jupiter's API answered with too many requests for this key right now (a burst of quotes in quick succession) -- wait a few seconds and try again." });
    } else {
      res.status(502).json({ error: "Jupiter's swap-transaction service had a network error and is temporarily unavailable -- wait a moment and try again." });
    }
    return;
  }

  res.status(200).json({
    ...built,
    inAmount: quote.inAmount,
    outAmount: quote.outAmount,
    priceImpactPct: quote.priceImpactPct,
  });
}
