// Pool launch prices for low-volume reserve assets (Creator rule 2026-10-22):
// a token without a trade in the last ~10 minutes is priced from a live
// two-way Jupiter quote, else from its last trade up to ~24 hours old.
import { expect } from "chai";
import { fetchLaunchPrices, priceFromQuotes, LOW_VOLUME_MAX_AGE_SLOTS, type LaunchPrice, type LaunchPriceDeps } from "../lib/mainnet/launchPrices";
import { MAINNET_USDC_MINT, type JupiterCallResult, type JupiterQuote } from "../lib/mainnet/jupiter";
import { LAUNCH_PRICE_MAX_AGE_SLOTS } from "../lib/mainnet/createLiquidity";

const PUMP = "BpdHpqznEgYPXZNrJVRZvBhdWoafYLVVuLxTQo34pump";
const SLOT = 460_093_574;
const ok = (inAmount: bigint, outAmount: bigint, contextSlot = SLOT): JupiterCallResult<JupiterQuote> => ({ kind: "ok", value: { inAmount: String(inAmount), outAmount: String(outAmount), priceImpactPct: "0", contextSlot } });

function deps(price: LaunchPrice, quote: LaunchPriceDeps["quote"]): LaunchPriceDeps {
  return {
    prices: async () => new Map([[PUMP, { ...price }], [MAINNET_USDC_MINT, { usdPrice: 1, decimals: 6, blockId: SLOT }]]),
    quote,
    currentSlot: async () => SLOT,
    maxAgeSlots: LAUNCH_PRICE_MAX_AGE_SLOTS,
  };
}
// The live 2026-10-22 numbers: $10 buys 19,365.897252 tokens; selling them back returns $9.95.
const liveQuotes: LaunchPriceDeps["quote"] = async (p) => (p.inputMint === MAINNET_USDC_MINT ? ok(10_000_000n, 19_365_897_252n) : ok(19_365_897_252n, 9_950_000n));

describe("pool launch prices for low-volume assets", () => {
  it("prices from the geometric mean of a two-way quote, refusing a wide spread", () => {
    const p = priceFromQuotes(6, 10_000_000n, 19_365_897_252n, 9_950_000n)!;
    expect(p).to.be.closeTo(0.0005151, 0.0000005);
    expect(priceFromQuotes(6, 10_000_000n, 19_365_897_252n, 9_000_000n)).to.equal(null);
    expect(priceFromQuotes(6, 10_000_000n, 0n, 9_950_000n)).to.equal(null);
  });

  it("keeps a fresh price untouched and asks Jupiter for nothing", async () => {
    let calls = 0;
    const m = await fetchLaunchPrices(deps({ usdPrice: 0.0005, decimals: 6, blockId: SLOT - 10 }, async () => (calls++, ok(1n, 1n))), [PUMP]);
    expect(calls).to.equal(0);
    expect(m.get(PUMP)!.usdPrice).to.equal(0.0005);
  });

  it("re-prices a token with no trade in 10 minutes from a live quote, stamped at the quote's slot", async () => {
    const m = await fetchLaunchPrices(deps({ usdPrice: 0.0005158, decimals: 6, blockId: SLOT - 4_327 }, liveQuotes), [PUMP]);
    expect(m.get(PUMP)!.usdPrice).to.be.closeTo(0.0005151, 0.0000005);
    expect(m.get(PUMP)!.blockId).to.equal(SLOT);
  });

  it("accepts the last trade (under 24 hours) when Jupiter cannot quote it", async () => {
    const m = await fetchLaunchPrices(deps({ usdPrice: 0.0005158, decimals: 6, blockId: SLOT - 50_000 }, async () => ({ kind: "exhausted", lastStatus: 429 })), [PUMP]);
    expect(m.get(PUMP)!.usdPrice).to.equal(0.0005158);
    expect(m.get(PUMP)!.blockId).to.equal(SLOT);
  });

  it("still refuses a price older than 24 hours that cannot be quoted", async () => {
    const old = SLOT - LOW_VOLUME_MAX_AGE_SLOTS - 1;
    const m = await fetchLaunchPrices(deps({ usdPrice: 0.0005158, decimals: 6, blockId: old }, async () => ({ kind: "specific-error", message: "No routes found" })), [PUMP]);
    expect(m.get(PUMP)!.blockId).to.equal(old);
  });
});
