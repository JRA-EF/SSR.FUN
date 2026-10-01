// Server-side Jupiter Swap API core (JUPITER_API_KEY, server-only secret,
// never sent to the browser) -- the ONE place this app talks to
// https://api.jup.ag. Shared by api/mainnet/jupiter-swap.ts (the per-swap
// proxy the Sell/Create flows still use) and api/mainnet/build-buy.ts (the
// server-built, sign-many Buy: every leg quoted and built here IN PARALLEL,
// instead of the browser round-tripping one proxied call per leg through
// a rate-limited endpoint).
//
// Behaviour is exactly what jupiter-swap.ts shipped with (retry policy,
// 429 handling, error classification, wrapAndUnwrapSol:false always,
// dynamicSlippage) -- only factored so both endpoints share it. Uses the
// global `fetch` on purpose: the existing offline tests stub it.
export const MAINNET_USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
// JUPITER_API_BASE is an optional override for LOCAL read-only dry runs
// against Jupiter's key-less lite endpoint (https://lite-api.jup.ag) when the
// production key is not available on the machine; production never sets it.
const JUPITER_API_BASE = (process.env.JUPITER_API_BASE || "https://api.jup.ag").replace(/\/+$/, "");
export const JUPITER_QUOTE_URL = `${JUPITER_API_BASE}/swap/v1/quote`;
export const JUPITER_SWAP_URL = `${JUPITER_API_BASE}/swap/v1/swap`;
export const JUPITER_SWAP_INSTRUCTIONS_URL = `${JUPITER_API_BASE}/swap/v1/swap-instructions`;

export const DEFAULT_SLIPPAGE_BPS = 150; // 1.5% -- generous enough for thinner-liquidity pump.fun-style tokens without being reckless.
export const MAX_SLIPPAGE_BPS = 500; // 5% hard ceiling -- a caller cannot ask for more.
// Server-side backstop against an egregious trade landing even if a client
// somehow skips its own price-impact check -- CreateDTR.tsx additionally
// warns/blocks well below this.
export const MAX_PRICE_IMPACT_PCT = 15;

export const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
export const U64_MAX = 18446744073709551615n;

export interface JupiterQuote {
  inAmount: string;
  outAmount: string;
  priceImpactPct: string;
  [key: string]: unknown;
}

/** Jupiter /swap-instructions wire shape for one instruction. */
export interface JupiterInstructionJson {
  programId: string;
  accounts: { pubkey: string; isSigner: boolean; isWritable: boolean }[];
  data: string; // base64
}

export interface JupiterSwapTransactionPayload {
  swapTransaction: string;
  lastValidBlockHeight: number;
}

export interface JupiterSwapInstructionsPayload {
  setupInstructions: JupiterInstructionJson[];
  swapInstruction: JupiterInstructionJson;
  cleanupInstruction: unknown;
  addressLookupTableAddresses: string[];
}

/**
 * Result of one Jupiter call after bounded retry: the real answer, Jupiter's
 * own genuine/specific error (reported as-is, never retried), or exhaustion
 * of every attempt on transient failures (carrying the last status so the
 * caller can answer 429-with-Retry-After vs 502).
 */
export type JupiterCallResult<T> = { kind: "ok"; value: T } | { kind: "specific-error"; message: string } | { kind: "exhausted"; lastStatus: number | null };

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

type Attempt<T> = { kind: "ok"; value: T } | { kind: "specific-error"; message: string } | { kind: "transient"; status: number | null; retryAfterMs: number | null };

// Bounded retry (4 attempts, ESCALATING 429 waits 2s/4s/6s, 400ms-steps
// otherwise) around ONLY the failure shapes that indicate a transient
// upstream hiccup rather than Jupiter's own genuine answer -- see
// jupiter-swap.ts's original, live-evidenced rationale (2026-08-25/27
// "DELTA" Resume): Jupiter's gateway rate-limits PER KEY and answers 429
// with a `{"message":...}` body, and flat sub-second retries land inside the
// same window.
const MAX_ATTEMPTS = 4;
async function withJupiterRetry<T>(attempt: () => Promise<Attempt<T>>): Promise<JupiterCallResult<T>> {
  let lastStatus: number | null = null;
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    const result = await attempt();
    if (result.kind === "ok") return { kind: "ok", value: result.value };
    if (result.kind === "specific-error") return result;
    lastStatus = result.status;
    if (i < MAX_ATTEMPTS - 1) {
      const delayMs = result.status === 429 ? (result.retryAfterMs ?? 2_000 * (i + 1)) : 400 * (i + 1);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  return { kind: "exhausted", lastStatus };
}

export interface JupiterQuoteParams {
  inputMint: string;
  outputMint: string;
  amount: bigint;
  slippageBps: number;
  /** Jupiter route account budget (DEC-0161) -- omitted upstream when null. */
  maxAccounts: number | null;
  apiKey: string;
}

/**
 * DEX venues Jupiter must not route through (Jupiter `excludeDexes` labels,
 * see /swap/v1/program-id-to-label). Live 2026-09-08 on a 10-asset Buy: every
 * leg routed via "ZeroFi" (program ZERor4xh...) failed on-chain with custom
 * error 0xd after ~13k CU (6 of 6), every leg via Raydium CLMM / Orca landed
 * (2 of 2) -- a broken venue, not slippage. Same morning, the tester's GOLF
 * Buy failed inside "Quantum" (program QuaNtZsg...) with custom error 0xe at
 * ~4k CU (sig 48hDBgg3...). Override with JUPITER_EXCLUDE_DEXES
 * (comma-separated) without a deploy; empty string disables the default.
 */
export const DEFAULT_EXCLUDED_DEXES = ["ZeroFi", "Quantum"];
export function excludedDexesParam(): string {
  const raw = process.env.JUPITER_EXCLUDE_DEXES;
  const list = raw === undefined ? DEFAULT_EXCLUDED_DEXES : raw.split(",").map((s) => s.trim()).filter(Boolean);
  return list.length ? `&excludeDexes=${encodeURIComponent(list.join(","))}` : "";
}

/** ExactIn quote with the shared retry policy. */
export async function fetchJupiterQuoteWithRetry(p: JupiterQuoteParams): Promise<JupiterCallResult<JupiterQuote>> {
  return withJupiterRetry<JupiterQuote>(async () => {
    try {
      const quoteUrl = `${JUPITER_QUOTE_URL}?inputMint=${p.inputMint}&outputMint=${p.outputMint}&amount=${p.amount.toString()}&slippageBps=${p.slippageBps}&swapMode=ExactIn${p.maxAccounts !== null ? `&maxAccounts=${p.maxAccounts}` : ""}${excludedDexesParam()}`;
      const quoteRes = await fetch(quoteUrl, { headers: { "x-api-key": p.apiKey } });
      if (!quoteRes.ok) {
        // Read the RAW text once (never .json() directly) so a genuinely
        // non-JSON response is still visible in server logs.
        const rawText = await quoteRes.text().catch(() => "<unreadable body>");
        let errBody: { error?: unknown } | null = null;
        try {
          errBody = JSON.parse(rawText);
        } catch {
          errBody = null;
        }
        console.error(`[jupiter] quote non-OK: status=${quoteRes.status} outputMint=${p.outputMint} body=${rawText.slice(0, 500)}`);
        if (quoteRes.status !== 429 && errBody && typeof errBody.error === "string") return { kind: "specific-error", message: errBody.error };
        return { kind: "transient", status: quoteRes.status, retryAfterMs: retryAfterMsFrom(quoteRes) };
      }
      return { kind: "ok", value: (await quoteRes.json()) as JupiterQuote };
    } catch (e) {
      console.error(`[jupiter] quote fetch threw: outputMint=${p.outputMint} error=${e instanceof Error ? e.stack || e.message : String(e)}`);
      return { kind: "transient", status: null, retryAfterMs: null };
    }
  });
}

// --- Naming what actually failed (2026-09-11, DEC-0199) ---------------------
// A swap failure used to read "Jupiter could not build the swap for <mint>",
// which named neither the venue nor the amount, so nobody could tell a dead
// route from a too-small amount from an excluded DEX. Jupiter's quote carries
// the venues it chose (routePlan[].swapInfo.label); these helpers put them,
// the exact amount, and Jupiter's own words into one sentence.

/** Venue labels of a quote's route, in hop order (e.g. ["Meteora DLMM", "Raydium CLMM"]). Empty when the quote carries no routePlan. */
export function routeLabelsOf(quote: JupiterQuote | null | undefined): string[] {
  const plan = (quote as { routePlan?: unknown } | null | undefined)?.routePlan;
  if (!Array.isArray(plan)) return [];
  const labels: string[] = [];
  for (const hop of plan) {
    const label = (hop as { swapInfo?: { label?: unknown } })?.swapInfo?.label;
    if (typeof label === "string" && label && !labels.includes(label)) labels.push(label);
  }
  return labels;
}

/** "Meteora DLMM -> Raydium CLMM" for a multi-hop route, the bare name for one hop, "" for none. */
export function describeRoute(labels: string[]): string {
  return labels.join(" -> ");
}

/** "HgBRWf...HCpump" -- enough of a mint to recognise it without a wall of base58. */
export function shortMint(mint: string): string {
  return mint.length > 14 ? `${mint.slice(0, 6)}...${mint.slice(-6)}` : mint;
}

/** A raw USDC amount as a dollar figure with enough precision to show dust honestly ("$0.000300", "$12.50"). */
export function formatUsdcRaw(raw: bigint): string {
  const n = Number(raw) / 1e6;
  return `$${n >= 0.01 ? n.toFixed(2) : n.toFixed(6)}`;
}

export interface SwapFailureContext {
  /** "quote" = no route was found at all; "build" = a route was found but the swap transaction could not be built. */
  stage: "quote" | "build";
  inputMint: string;
  outputMint: string;
  amountRaw: bigint;
  /** The successful quote, when there is one (stage "build") -- its routePlan names the venues. */
  quote?: JupiterQuote | null;
  /** Jupiter's own error text, passed through verbatim. */
  message?: string | null;
}

/**
 * One honest, specific sentence for a failed swap: what failed, on which
 * venue(s), for exactly how much of what, in Jupiter's own words, plus the
 * concrete next step. Never speculates about the cause -- when the amount is
 * genuinely dust-sized it says so as an additional fact, not as the verdict.
 */
export function describeSwapFailure(p: SwapFailureContext): string {
  const isUsdcIn = p.inputMint === MAINNET_USDC_MINT;
  const amount = isUsdcIn ? formatUsdcRaw(p.amountRaw) : `${p.amountRaw.toString()} raw units of ${shortMint(p.inputMint)}`;
  const target = shortMint(isUsdcIn ? p.outputMint : p.inputMint);
  const said = p.message ? ` Jupiter said: "${p.message}".` : "";
  const excluded = DEFAULT_EXCLUDED_DEXES.length ? ` (${DEFAULT_EXCLUDED_DEXES.join(" and ")} are excluded on purpose -- they returned broken routes.)` : "";
  const tiny = isUsdcIn && p.amountRaw > 0n && p.amountRaw < 1_000n ? ` ${amount} is also smaller than this swap's own network fee, so it is worth raising the amount for this asset regardless.` : "";

  if (p.stage === "build") {
    const route = describeRoute(routeLabelsOf(p.quote));
    const via = route ? `The ${route} route` : "The route Jupiter chose";
    return `${via} quoted ${amount} into ${target} but could not build the swap.${said} Nothing was swapped and no fee was paid.${tiny}`;
  }
  const route = describeRoute(routeLabelsOf(p.quote));
  const tried = route ? `Jupiter could only reach ${target} through ${route}, and that route would not quote ${amount}.` : `Jupiter found no route from ${amount} into ${target} on any venue it supports.`;
  return `${tried}${said}${excluded} Nothing was swapped and no fee was paid.${tiny}`;
}

export interface JupiterBuildParams {
  quote: JupiterQuote;
  userPublicKey: string;
  apiKey: string;
  /** Optional: deliver the swap OUTPUT into this existing token account instead of the user's ATA (Jupiter `destinationTokenAccount`). Used by the fee-settlement keeper to land USDC directly in a Reserve's settlement staging ATA. */
  destinationTokenAccount?: string;
}

/**
 * Builds Jupiter's swap for `quote`, either as a ready-to-sign serialized
 * transaction ("transaction") or as raw instructions + lookup-table
 * addresses ("instructions", for composing into one transaction). ALWAYS
 * wrapAndUnwrapSol:false (live 2026-08-26: Jupiter's default cleanup closed
 * the buyer's wSOL ATA mid-purchase) and dynamicSlippage/dynamicComputeUnitLimit.
 */
export async function buildJupiterSwapTransactionWithRetry(p: JupiterBuildParams): Promise<JupiterCallResult<JupiterSwapTransactionPayload>> {
  return withJupiterRetry<JupiterSwapTransactionPayload>(() => attemptBuild(p, "transaction") as Promise<Attempt<JupiterSwapTransactionPayload>>);
}

export async function buildJupiterSwapInstructionsWithRetry(p: JupiterBuildParams): Promise<JupiterCallResult<JupiterSwapInstructionsPayload>> {
  return withJupiterRetry<JupiterSwapInstructionsPayload>(() => attemptBuild(p, "instructions") as Promise<Attempt<JupiterSwapInstructionsPayload>>);
}

async function attemptBuild(p: JupiterBuildParams, mode: "transaction" | "instructions"): Promise<Attempt<JupiterSwapTransactionPayload | JupiterSwapInstructionsPayload>> {
  const outputMint = String(p.quote.outputMint ?? "");
  try {
    const swapRes = await fetch(mode === "instructions" ? JUPITER_SWAP_INSTRUCTIONS_URL : JUPITER_SWAP_URL, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": p.apiKey },
      body: JSON.stringify({
        quoteResponse: p.quote,
        userPublicKey: p.userPublicKey,
        dynamicComputeUnitLimit: true,
        dynamicSlippage: true,
        wrapAndUnwrapSol: false,
        ...(p.destinationTokenAccount ? { destinationTokenAccount: p.destinationTokenAccount } : {}),
      }),
    });
    const rawText = await swapRes.text().catch(() => "<unreadable body>");
    let swapBody: { swapTransaction?: unknown; lastValidBlockHeight?: unknown; swapInstruction?: unknown; error?: unknown } | null = null;
    try {
      swapBody = JSON.parse(rawText);
    } catch {
      swapBody = null;
    }
    if (mode === "transaction" && swapRes.ok && swapBody && typeof swapBody.swapTransaction === "string" && typeof swapBody.lastValidBlockHeight === "number") {
      return { kind: "ok", value: { swapTransaction: swapBody.swapTransaction, lastValidBlockHeight: swapBody.lastValidBlockHeight } };
    }
    if (mode === "instructions" && swapRes.ok && swapBody && typeof swapBody.swapInstruction === "object" && swapBody.swapInstruction !== null) {
      const b = swapBody as Record<string, unknown>;
      return {
        kind: "ok",
        value: {
          setupInstructions: Array.isArray(b.setupInstructions) ? (b.setupInstructions as JupiterInstructionJson[]) : [],
          swapInstruction: b.swapInstruction as JupiterInstructionJson,
          cleanupInstruction: b.cleanupInstruction ?? null,
          addressLookupTableAddresses: Array.isArray(b.addressLookupTableAddresses) ? (b.addressLookupTableAddresses as string[]) : [],
        },
      };
    }
    console.error(`[jupiter] swap-build non-OK/malformed: status=${swapRes.status} outputMint=${outputMint} body=${rawText.slice(0, 500)}`);
    if (swapRes.status !== 429 && swapBody && typeof swapBody.error === "string") return { kind: "specific-error", message: swapBody.error };
    return { kind: "transient", status: swapRes.status, retryAfterMs: retryAfterMsFrom(swapRes) };
  } catch (e) {
    console.error(`[jupiter] swap-build fetch threw: outputMint=${outputMint} error=${e instanceof Error ? e.stack || e.message : String(e)}`);
    return { kind: "transient", status: null, retryAfterMs: null };
  }
}

/** Pure: the price-impact backstop every Mainnet swap this app builds must pass. */
export function isPriceImpactAcceptable(quote: Pick<JupiterQuote, "priceImpactPct">): boolean {
  const pct = Number(quote.priceImpactPct);
  return !(Number.isFinite(pct) && pct > MAX_PRICE_IMPACT_PCT);
}

/** Pure: the HTTP answer for an exhausted-retries Jupiter call -- 429 (with Retry-After 10s) when Jupiter itself rate-limited the key, else 502 with a transient-worded message classifyCreateReserveError already recognizes as retryable. */
export function jupiterExhaustedResponse(what: "quote" | "transaction", lastStatus: number | null): { status: 429 | 502; retryAfterSeconds?: number; error: string } {
  if (lastStatus === 429) {
    return {
      status: 429,
      retryAfterSeconds: 10,
      error: "Jupiter's API answered with too many requests for this key right now (a burst of quotes in quick succession) -- wait a few seconds and try again.",
    };
  }
  return {
    status: 502,
    error:
      what === "quote"
        ? "Jupiter's swap-quote service had a network error and is temporarily unavailable for this asset -- wait a moment and try again."
        : "Jupiter's swap-transaction service had a network error and is temporarily unavailable -- wait a moment and try again.",
  };
}
