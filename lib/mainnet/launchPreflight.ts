// DEC-0249: the route check Create Reserve runs BEFORE anything is created.
//
// A launch swaps the creator's USDC into every non-USDC, non-SOL asset. When
// one of those assets has no Jupiter route, or a route so thin the swap proxy
// refuses it (price impact above MAX_PRICE_IMPACT_PCT), the launch used to
// find out half way through, after the Reserve already existed on-chain. This
// asks Jupiter the same question up front, for the exact USDC amount each
// asset will be swapped from, and says per asset: fine, risky, or must go.
//
// Read-only: quotes only, never builds or signs a transaction.
import { JUPITER_KEY_REJECTED_MESSAGE, MAINNET_USDC_MINT, MAX_PRICE_IMPACT_PCT, describeSwapFailure, fetchJupiterQuoteWithRetry, isJupiterKeyRejected, routeLabelsOf, type JupiterCallResult, type JupiterQuote, type JupiterQuoteParams } from "./jupiter";

export const WRAPPED_SOL_MINT_STR = "So11111111111111111111111111111111111111112";
/** Above this price impact an asset still launches, but the creator is told it is thin and will land noticeably short. */
export const PREFLIGHT_WARN_PRICE_IMPACT_PCT = 3;
/** Same slippage the launch swaps start at (DEFAULT_SLIPPAGE_BPS) -- the check must quote what the launch will actually ask for. */
const PREFLIGHT_SLIPPAGE_BPS = 150;
/** Jupiter is shared by every user; ten assets x two directions is the most one check sends. */
export const PREFLIGHT_MAX_ASSETS = 10;

export type PreflightStatus = "ok" | "warning" | "blocked" | "unchecked";

export interface PreflightAssetInput {
  mint: string;
  /** USDC swapped into this asset at launch, raw (6 decimals). */
  usdcBudgetRaw: bigint;
}

export interface PreflightAssetResult {
  mint: string;
  status: PreflightStatus;
  /** Plain-language reason shown under the asset. Empty for "ok". */
  reason: string;
  priceImpactPct: number | null;
  /** Venues the swap-in route goes through, in hop order. */
  route: string[];
  /** Expected raw amount of the asset the USDC buys, when a route was found. */
  expectedOutRaw: string | null;
  /** False when USDC can be swapped into the asset but not back to USDC (redemptions to USDC would fail for it). */
  canSwapBack: boolean | null;
}

export interface PreflightDeps {
  quote: (p: Omit<JupiterQuoteParams, "apiKey">) => Promise<JupiterCallResult<JupiterQuote>>;
}

export function jupiterPreflightDeps(apiKey: string): PreflightDeps {
  return { quote: (p) => fetchJupiterQuoteWithRetry({ ...p, apiKey }) };
}

/** USDC and SOL are never swapped for at launch (deposited directly / wrapped from the wallet), so there is no route to check. */
export function needsRouteCheck(mint: string): boolean {
  return mint !== MAINNET_USDC_MINT && mint !== WRAPPED_SOL_MINT_STR;
}

/** Pure: one asset's verdict from its swap-in quote and (optional) swap-back quote. */
export function classifyPreflight(
  input: PreflightAssetInput,
  swapIn: JupiterCallResult<JupiterQuote>,
  swapBack: JupiterCallResult<JupiterQuote> | null,
): PreflightAssetResult {
  const base = { mint: input.mint, route: [] as string[], priceImpactPct: null as number | null, expectedOutRaw: null as string | null, canSwapBack: null as boolean | null };
  if (swapIn.kind === "exhausted") {
    if (isJupiterKeyRejected(swapIn.lastStatus)) return { ...base, status: "unchecked", reason: JUPITER_KEY_REJECTED_MESSAGE };
    return { ...base, status: "unchecked", reason: "Jupiter was busy and could not check this asset right now. It does not block the launch; the swap is checked again when you launch." };
  }
  if (swapIn.kind === "specific-error") {
    return {
      ...base,
      status: "blocked",
      reason: describeSwapFailure({ stage: "quote", inputMint: MAINNET_USDC_MINT, outputMint: input.mint, amountRaw: input.usdcBudgetRaw, message: swapIn.message }).replace(" Nothing was swapped and no fee was paid.", "") +
        " Remove it, or replace it with another asset.",
    };
  }
  const quote = swapIn.value;
  const impact = Number(quote.priceImpactPct);
  const impactPct = Number.isFinite(impact) ? impact : null;
  const route = routeLabelsOf(quote);
  const canSwapBack = swapBack === null ? null : swapBack.kind === "ok" ? true : swapBack.kind === "specific-error" ? false : null;
  const found = { ...base, route, priceImpactPct: impactPct, expectedOutRaw: String(quote.outAmount), canSwapBack };
  if (impactPct !== null && impactPct > MAX_PRICE_IMPACT_PCT) {
    return {
      ...found,
      status: "blocked",
      reason: `Too little trading liquidity: swapping its share of your Reserve into this asset would move its price by ${impactPct.toFixed(1)}%, and swaps above ${MAX_PRICE_IMPACT_PCT}% are refused. Remove it, lower its weight, or replace it with another asset.`,
    };
  }
  const notes: string[] = [];
  if (impactPct !== null && impactPct > PREFLIGHT_WARN_PRICE_IMPACT_PCT) {
    notes.push(`Thin liquidity: the swap moves the price by about ${impactPct.toFixed(1)}%, so you will receive less of it than its weight suggests.`);
  }
  if (canSwapBack === false) {
    notes.push("Jupiter has no route to swap this asset back to USDC, so redeeming to USDC would fail for it (redeeming in kind still works).");
  }
  if (notes.length > 0) return { ...found, status: "warning", reason: `${notes.join(" ")} You can still continue.` };
  return { ...found, status: "ok", reason: "" };
}

/** Quotes every asset that needs a swap, in parallel (Jupiter's per-key limit is far above ten). */
export async function runLaunchPreflight(deps: PreflightDeps, assets: PreflightAssetInput[]): Promise<PreflightAssetResult[]> {
  return Promise.all(
    assets.map(async (a): Promise<PreflightAssetResult> => {
      if (!needsRouteCheck(a.mint)) {
        return { mint: a.mint, status: "ok", reason: "", priceImpactPct: null, route: [], expectedOutRaw: null, canSwapBack: true };
      }
      const swapIn = await deps.quote({ inputMint: MAINNET_USDC_MINT, outputMint: a.mint, amount: a.usdcBudgetRaw, slippageBps: PREFLIGHT_SLIPPAGE_BPS, maxAccounts: null });
      // Swap-back check sized at what the swap-in would deliver: the same amount
      // a redemption of the whole seed would hand back.
      const swapBack =
        swapIn.kind === "ok" && BigInt(swapIn.value.outAmount) > 0n
          ? await deps.quote({ inputMint: a.mint, outputMint: MAINNET_USDC_MINT, amount: BigInt(swapIn.value.outAmount), slippageBps: PREFLIGHT_SLIPPAGE_BPS, maxAccounts: null })
          : null;
      return classifyPreflight(a, swapIn, swapBack);
    }),
  );
}
