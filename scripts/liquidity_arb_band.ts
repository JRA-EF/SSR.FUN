/**
 * NAV-arbitrage band model for the Liquidity Module (DEC-0223, item 8 of
 * Yeh's 2026-10-01 rulings): how far a Reserve Token's DEX price can drift
 * from NAV before the mint/redeem loop makes arbitrage profitable, using LIVE
 * Jupiter quotes for the basket legs instead of an assumed constant.
 *
 * Both mint and redeem are in-kind in ssr_protocol, so each arbitrage loop
 * swaps every constituent through Jupiter once. The two directions are
 * measured SEPARATELY against Jupiter's mid price, because routing cost and
 * price impact differ by direction:
 *   premium side:  buy constituents (USDC -> basket) -> mint in-kind -> sell on DEX
 *                  = dexFee + mintFee + basketBuyCost
 *   discount side: buy on DEX -> redeem in-kind -> sell constituents (basket -> USDC)
 *                  = dexFee + redemptionFee + basketSellCost
 *
 * Usage (no wallet, no transactions -- quotes only):
 *   JUPITER_API_KEY=... npx tsx scripts/liquidity_arb_band.ts
 * Without a key it falls back to lite-api.jup.ag, which rate-limits and may
 * drop legs; the report marks any basket that lost legs.
 */

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

// Representative Mainnet baskets. Swap these for real Reserve compositions
// (scripts/check_reserve_compositions.ts) when modelling a specific Reserve.
const MINTS: Record<string, { mint: string; decimals: number }> = {
  SOL: { mint: "So11111111111111111111111111111111111111112", decimals: 9 },
  JUP: { mint: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN", decimals: 6 },
  RAY: { mint: "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R", decimals: 6 },
  JTO: { mint: "jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL", decimals: 9 },
  BONK: { mint: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263", decimals: 5 },
  PYTH: { mint: "HZ1JovNiVvGrGNiiYvEozEVjZ72jPu9uDd8NSbrY2GBi", decimals: 6 },
  WIF: { mint: "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm", decimals: 6 },
  ORCA: { mint: "orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE", decimals: 6 },
  DRIFT: { mint: "DriFtupJYLTosbwoN8koMbEYSx54aFAVLddWsbksjwg7", decimals: 6 },
  HNT: { mint: "hntyVP6YFm1Hg25TN9WGLqM12b8TQmcknKrdu1oxWux", decimals: 8 },
};
const BASKETS: Record<string, string[]> = {
  "1-asset": ["SOL"],
  "5-asset": ["SOL", "JUP", "RAY", "JTO", "BONK"],
  "10-asset": Object.keys(MINTS),
};
const SIZES_USD = [1_000, 5_000, 20_000];

// ssr_protocol defaults (programs/ssr_protocol/src/constants.rs).
const MINT_FEE = 0.005; // DEFAULT_MINT_FEE_BPS 50 (also the protocol minimum)
const REDEMPTION_FEE = 0; // DEFAULT_REDEMPTION_FEE_BPS 0
// Candidate DEX fee tiers (Raydium CLMM AmmConfig indexes 1, 16, 17, 3).
const DEX_FEES = [0.0025, 0.006, 0.008, 0.01];
const LP_SHARE_OF_FEE = 0.84; // 12% protocol + 4% fund on every Raydium CLMM tier

const apiKey = process.env.JUPITER_API_KEY;
const host = apiKey ? "https://api.jup.ag" : "https://lite-api.jup.ag";
const headers: Record<string, string> = apiKey ? { "x-api-key": apiKey } : {};

async function getJson<T>(url: string): Promise<T | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(url, { headers });
    if (res.ok) return (await res.json()) as T;
    if (res.status === 400) return null; // no route for this mint/size
    await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
  }
  return null;
}

/** Jupiter mid price in USD per whole token (price API v3), or null. */
async function midPriceUsd(mint: string): Promise<number | null> {
  const body = await getJson<Record<string, { usdPrice?: number }>>(`${host}/price/v3?ids=${mint}`);
  const price = body?.[mint]?.usdPrice;
  return typeof price === "number" && price > 0 ? price : null;
}

async function quoteOut(inputMint: string, outputMint: string, amount: bigint): Promise<bigint | null> {
  const body = await getJson<{ outAmount: string }>(
    `${host}/swap/v1/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=50&restrictIntermediateTokens=true`,
  );
  return body ? BigInt(body.outAmount) : null;
}

interface LegCosts {
  /** Fraction lost buying the basket with USDC, vs. mid price (routing + price impact). */
  buy: number;
  /** Fraction lost selling the basket for USDC, vs. mid price. */
  sell: number;
  legsLost: string[];
}

/** Each direction measured on its own against Jupiter's mid price, per constituent, equal-weighted. */
async function basketCosts(names: string[], sizeUsd: number): Promise<LegCosts> {
  const perAssetUsd = sizeUsd / names.length;
  const usdcIn = BigInt(Math.round(perAssetUsd * 1e6)); // USDC has 6 decimals
  let buy = 0;
  let sell = 0;
  let counted = 0;
  const legsLost: string[] = [];
  for (const name of names) {
    const { mint, decimals } = MINTS[name];
    const mid = await midPriceUsd(mint);
    const bought = mid === null ? null : await quoteOut(USDC, mint, usdcIn);
    // Sell leg sized independently: the USD notional converted to tokens at mid, not the buy leg's output.
    const tokensAtMid = mid === null ? null : BigInt(Math.round((perAssetUsd / mid) * 10 ** decimals));
    const sold = tokensAtMid === null ? null : await quoteOut(mint, USDC, tokensAtMid);
    if (mid === null || bought === null || sold === null) {
      legsLost.push(name);
      continue;
    }
    const boughtUsdAtMid = (Number(bought) / 10 ** decimals) * mid;
    buy += 1 - boughtUsdAtMid / perAssetUsd;
    sell += 1 - Number(sold) / 1e6 / perAssetUsd;
    counted++;
    await new Promise((r) => setTimeout(r, 300));
  }
  return { buy: counted ? buy / counted : NaN, sell: counted ? sell / counted : NaN, legsLost };
}

async function main() {
  console.log(`NAV-arbitrage band model -- live Jupiter quotes via ${host} at ${new Date().toISOString()}`);
  console.log(`mint fee ${(MINT_FEE * 100).toFixed(2)}%, redemption fee ${(REDEMPTION_FEE * 100).toFixed(2)}% (ssr_protocol defaults)\n`);
  for (const [label, names] of Object.entries(BASKETS)) {
    for (const size of SIZES_USD) {
      const { buy, sell, legsLost } = await basketCosts(names, size);
      const lost = legsLost.length ? `  [no quote: ${legsLost.join(", ")}]` : "";
      console.log(
        `${label} basket, $${size.toLocaleString()}: USDC->basket ${(buy * 100).toFixed(3)}%, basket->USDC ${(sell * 100).toFixed(3)}% (vs. Jupiter mid)${lost}`,
      );
      for (const f of DEX_FEES) {
        const premium = f + MINT_FEE + buy;
        const discount = f + REDEMPTION_FEE + sell;
        console.log(
          `    DEX ${(f * 100).toFixed(2)}%: band -${(discount * 100).toFixed(2)}% / +${(premium * 100).toFixed(2)}% (width ${((discount + premium) * 100).toFixed(2)}%), LP take at 100% ownership ${(f * LP_SHARE_OF_FEE * 100).toFixed(3)}% of volume`,
        );
      }
    }
  }
  console.log(
    "\nThe DEX side's own price impact is not in these numbers: it scales with trade size over pool depth (on a full-range pool, roughly 1% of pool TVL can be traded per 1% of mispricing beyond the band), so it limits how much an arbitrageur can do, not whether the first dollar pays.",
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
