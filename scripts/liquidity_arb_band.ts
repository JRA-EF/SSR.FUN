/**
 * NAV-arbitrage band model for the Liquidity Module (DEC-0223, item 8 of
 * Yeh's 2026-10-01 rulings): how far a Reserve Token's DEX price can drift
 * from NAV before the mint/redeem loop makes arbitrage profitable, using LIVE
 * Jupiter quotes for the basket legs instead of an assumed constant.
 *
 * Both mint and redeem are in-kind in ssr_protocol, so each arbitrage loop
 * swaps every constituent through Jupiter once:
 *   discount side: buy on DEX -> redeem in-kind -> sell constituents
 *                  = dexFee + redemptionFee + basketRoundTrip/2
 *   premium side:  buy constituents -> mint in-kind -> sell on DEX
 *                  = dexFee + mintFee + basketRoundTrip/2
 *
 * Usage (no wallet, no transactions -- quotes only):
 *   JUPITER_API_KEY=... npx tsx scripts/liquidity_arb_band.ts
 * Without a key it falls back to lite-api.jup.ag, which rate-limits and may
 * drop legs; the report marks any basket that lost legs.
 */

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

// Representative Mainnet baskets. Swap these for real Reserve compositions
// (scripts/check_reserve_compositions.ts) when modelling a specific Reserve.
const MINTS: Record<string, string> = {
  SOL: "So11111111111111111111111111111111111111112",
  JUP: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN",
  RAY: "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R",
  JTO: "jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL",
  BONK: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",
  PYTH: "HZ1JovNiVvGrGNiiYvEozEVjZ72jPu9uDd8NSbrY2GBi",
  WIF: "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm",
  ORCA: "orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE",
  DRIFT: "DriFtupJYLTosbwoN8koMbEYSx54aFAVLddWsbksjwg7",
  HNT: "hntyVP6YFm1Hg25TN9WGLqM12b8TQmcknKrdu1oxWux",
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
const base = apiKey ? "https://api.jup.ag/swap/v1" : "https://lite-api.jup.ag/swap/v1";

async function quote(inputMint: string, outputMint: string, amount: bigint): Promise<bigint | null> {
  const url = `${base}/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=50&restrictIntermediateTokens=true`;
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(url, { headers: apiKey ? { "x-api-key": apiKey } : {} });
    if (res.ok) {
      const body = (await res.json()) as { outAmount: string };
      return BigInt(body.outAmount);
    }
    if (res.status === 400) return null; // no route for this mint/size
    await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
  }
  return null;
}

async function basketRoundTrip(names: string[], sizeUsd: number): Promise<{ pct: number; legsLost: string[] }> {
  const perAsset = sizeUsd / names.length;
  const amountIn = BigInt(Math.round(perAsset * 1e6)); // USDC has 6 decimals
  let cost = 0;
  let counted = 0;
  const legsLost: string[] = [];
  for (const name of names) {
    const out = await quote(USDC, MINTS[name], amountIn);
    const back = out === null ? null : await quote(MINTS[name], USDC, out);
    if (out === null || back === null) {
      legsLost.push(name);
      continue;
    }
    cost += Number(amountIn - back) / Number(amountIn);
    counted++;
    await new Promise((r) => setTimeout(r, 300));
  }
  return { pct: counted ? cost / counted : NaN, legsLost };
}

async function main() {
  console.log(`NAV-arbitrage band model -- live Jupiter quotes via ${base} at ${new Date().toISOString()}`);
  console.log(`mint fee ${(MINT_FEE * 100).toFixed(2)}%, redemption fee ${(REDEMPTION_FEE * 100).toFixed(2)}% (ssr_protocol defaults)\n`);
  for (const [label, names] of Object.entries(BASKETS)) {
    for (const size of SIZES_USD) {
      const { pct, legsLost } = await basketRoundTrip(names, size);
      const oneWay = pct / 2;
      const lost = legsLost.length ? `  [no quote: ${legsLost.join(", ")}]` : "";
      console.log(`${label} basket, $${size.toLocaleString()}: round trip ${(pct * 100).toFixed(3)}%, one-way ${(oneWay * 100).toFixed(3)}%${lost}`);
      for (const f of DEX_FEES) {
        const discount = f + REDEMPTION_FEE + oneWay;
        const premium = f + MINT_FEE + oneWay;
        console.log(
          `    DEX ${(f * 100).toFixed(2)}%: band -${(discount * 100).toFixed(2)}% / +${(premium * 100).toFixed(2)}% (width ${((discount + premium) * 100).toFixed(2)}%), LP take at 100% ownership ${(f * LP_SHARE_OF_FEE * 100).toFixed(3)}% of volume`,
        );
      }
    }
  }
  console.log("\nSlippage does not move the band; on a full-range pool roughly 1% of pool TVL can be arbed per 1% of mispricing beyond it.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
