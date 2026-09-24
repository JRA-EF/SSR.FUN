// Manager Buy/Sell tax charged through SSR.fun's own Buy and Sell (DEC-0198):
// the pure math, the instruction shape, and the metadata resolution -- all
// offline. The full-build wiring is covered in phase_server_built_buy.ts /
// phase_server_built_sell.ts ("tax" cases).
import { expect } from "chai";
import { Keypair, PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import {
  MAX_TRADE_TAX_BPS,
  TRADE_TAX_PROTOCOL_SHARE_BPS,
  appMetadataIdFromUri,
  buildTradeTaxInstructions,
  computeTradeTax,
  inlineMetadataJson,
  resolveReserveTradeTax,
  tradeTaxBps,
  tradeTaxRatesFromMetadata,
} from "../lib/mainnet/tradeTax";
import { buyTaxBaseUsdcRaw } from "../lib/mainnet/buildBuy";
import { sellTaxBaseUsdcRaw } from "../lib/mainnet/buildSell";

const USDC = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const TREASURY = new PublicKey("3CBpVMPDQD75b5bXgDunkpVJ3EeQWcwU9DCSLsTjWQL5"); // off-curve Squads vault

describe("tradeTax.ts -- rate and split", () => {
  it("percent -> bps, clamped to the 2% slider cap, 0 for anything unusable", () => {
    expect(tradeTaxBps(0.75)).to.equal(75);
    expect(tradeTaxBps(2)).to.equal(200);
    expect(tradeTaxBps(9)).to.equal(MAX_TRADE_TAX_BPS);
    expect(tradeTaxBps(0)).to.equal(0);
    expect(tradeTaxBps(-1)).to.equal(0);
    expect(tradeTaxBps(Number.NaN)).to.equal(0);
    expect(tradeTaxBps(undefined)).to.equal(0);
  });
  it("50/50 split, floor on the tax, protocol floor + manager remainder (always sums exactly), NO minimum", () => {
    expect(TRADE_TAX_PROTOCOL_SHARE_BPS).to.equal(5_000);
    const s = computeTradeTax(1_000_000n, 100); // 1% of 1 USDC
    expect(s.taxUsdcRaw).to.equal(10_000n);
    expect(s.protocolUsdcRaw).to.equal(5_000n);
    expect(s.managerUsdcRaw).to.equal(5_000n);
    const odd = computeTradeTax(333_333n, 75); // 0.75% -> 2499 (floor); protocol 1249, manager 1250
    expect(odd.taxUsdcRaw).to.equal(2_499n);
    expect(odd.protocolUsdcRaw).to.equal(1_249n);
    expect(odd.managerUsdcRaw).to.equal(1_250n);
    expect(odd.protocolUsdcRaw + odd.managerUsdcRaw).to.equal(odd.taxUsdcRaw);
    const zero = computeTradeTax(1_000_000n, 0);
    expect(zero.taxUsdcRaw).to.equal(0n);
    const tiny = computeTradeTax(10n, 50); // 0.5% of 10 raw floors to 0 -- no floor is ever imposed
    expect(tiny.taxUsdcRaw).to.equal(0n);
  });
});

describe("tradeTax.ts -- instructions", () => {
  const trader = Keypair.generate().publicKey;
  const manager = Keypair.generate().publicKey;
  it("two recipients: [create ATA (idempotent), transfer] per recipient, the Treasury ATA derived off-curve, source = the trader's USDC ATA", () => {
    const split = computeTradeTax(1_000_000n, 100);
    const ixs = buildTradeTaxInstructions({ trader, usdcMint: USDC, protocolDestination: TREASURY, managerDestination: manager, split });
    expect(ixs).to.have.length(4);
    expect(ixs[0].programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID)).to.equal(true);
    expect(ixs[1].programId.equals(TOKEN_PROGRAM_ID)).to.equal(true);
    const treasuryAta = getAssociatedTokenAddressSync(USDC, TREASURY, true);
    expect(ixs[1].keys[0].pubkey.equals(getAssociatedTokenAddressSync(USDC, trader))).to.equal(true);
    expect(ixs[1].keys[1].pubkey.equals(treasuryAta)).to.equal(true);
    expect(ixs[3].keys[1].pubkey.equals(getAssociatedTokenAddressSync(USDC, manager))).to.equal(true);
    // amounts: u64 LE at data[1..9]
    expect(ixs[1].data.readBigUInt64LE(1)).to.equal(5_000n);
    expect(ixs[3].data.readBigUInt64LE(1)).to.equal(5_000n);
  });
  it("same wallet for both shares -> ONE merged transfer; zero tax -> no instructions", () => {
    const split = computeTradeTax(1_000_000n, 100);
    const merged = buildTradeTaxInstructions({ trader, usdcMint: USDC, protocolDestination: TREASURY, managerDestination: TREASURY, split });
    expect(merged).to.have.length(2);
    expect(merged[1].data.readBigUInt64LE(1)).to.equal(10_000n);
    expect(buildTradeTaxInstructions({ trader, usdcMint: USDC, protocolDestination: TREASURY, managerDestination: manager, split: computeTradeTax(5n, 100) })).to.have.length(0);
  });
});

describe("tradeTax.ts -- metadata resolution", () => {
  it("reads buyTaxPct/sellTaxPct out of a payload; malformed or missing -> 0; capped at 2%", () => {
    expect(tradeTaxRatesFromMetadata({ buyTaxPct: 0.5, sellTaxPct: 1 })).to.deep.equal({ buyTaxPct: 0.5, sellTaxPct: 1 });
    expect(tradeTaxRatesFromMetadata({ buyTaxPct: "1" })).to.deep.equal({ buyTaxPct: 0, sellTaxPct: 0 });
    expect(tradeTaxRatesFromMetadata(null)).to.deep.equal({ buyTaxPct: 0, sellTaxPct: 0 });
    expect(tradeTaxRatesFromMetadata({ buyTaxPct: 50, sellTaxPct: -3 })).to.deep.equal({ buyTaxPct: 2, sellTaxPct: 0 });
  });
  it("recognises this app's hosted metadata URL (mainnet or devnet route, 16-hex id) and inline data: JSON", () => {
    expect(appMetadataIdFromUri("https://ssr.fun/api/mainnet/reserve-metadata?id=0123456789abcdef")).to.equal("0123456789abcdef");
    expect(appMetadataIdFromUri("https://strategic-super-reserve.fun/api/devnet/reserve-metadata?id=0123456789ABCDEF")).to.equal("0123456789ABCDEF");
    expect(appMetadataIdFromUri("https://ssr.fun/api/mainnet/reserve-metadata?id=short")).to.equal(null);
    expect(appMetadataIdFromUri("https://arweave.net/abc")).to.equal(null);
    expect(appMetadataIdFromUri("not a url")).to.equal(null);
    expect(inlineMetadataJson(`data:application/json,${encodeURIComponent(JSON.stringify({ name: "x", buyTaxPct: 1 }))}`)).to.deep.equal({ name: "x", buyTaxPct: 1 });
    expect(inlineMetadataJson("https://x")).to.equal(null);
  });
  it("resolves store-first for app URLs, HTTPS fetch otherwise, and 0/0 on ANY failure (a metadata hiccup never blocks a trade)", async () => {
    const calls: string[] = [];
    const deps = {
      lookupStoredMetadata: async (id: string) => {
        calls.push(`store:${id}`);
        return { buyTaxPct: 1.5, sellTaxPct: 0.25 };
      },
      fetchJson: async (url: string) => {
        calls.push(`fetch:${url}`);
        return { buyTaxPct: 0.1, sellTaxPct: 0.2 };
      },
    };
    expect(await resolveReserveTradeTax("https://ssr.fun/api/mainnet/reserve-metadata?id=0123456789abcdef", deps)).to.deep.equal({ buyTaxPct: 1.5, sellTaxPct: 0.25 });
    expect(await resolveReserveTradeTax("https://arweave.net/abc", deps)).to.deep.equal({ buyTaxPct: 0.1, sellTaxPct: 0.2 });
    expect(calls).to.deep.equal(["store:0123456789abcdef", "fetch:https://arweave.net/abc"]);
    const failing = { lookupStoredMetadata: async () => { throw new Error("db down"); }, fetchJson: async () => { throw new Error("net"); } };
    expect(await resolveReserveTradeTax("https://ssr.fun/api/mainnet/reserve-metadata?id=0123456789abcdef", failing)).to.deep.equal({ buyTaxPct: 0, sellTaxPct: 0 });
    expect(await resolveReserveTradeTax("https://arweave.net/abc", failing)).to.deep.equal({ buyTaxPct: 0, sellTaxPct: 0 });
    expect(await resolveReserveTradeTax("", deps)).to.deep.equal({ buyTaxPct: 0, sellTaxPct: 0 });
  });
});

describe("tax bases", () => {
  const USDC_S = USDC.toBase58();
  it("Buy: every leg's required deposit at its price (USDC at 1), whether the wallet already held it or not; unknown price -> the plan's USDC spend", () => {
    const legs = [
      { mint: USDC_S, decimals: 6, requiredRaw: 1_000_000n, priceUsd: 1 },
      { mint: "A", decimals: 9, requiredRaw: 2_000_000_000n, priceUsd: 0.5 }, // 2 A @ $0.5 = 1 USDC
    ];
    expect(buyTaxBaseUsdcRaw(legs, 999n)).to.equal(2_000_000n);
    expect(buyTaxBaseUsdcRaw([...legs, { mint: "B", decimals: 6, requiredRaw: 5n, priceUsd: null }], 999n)).to.equal(999n);
    expect(buyTaxBaseUsdcRaw([{ mint: "B", decimals: 6, requiredRaw: 0n, priceUsd: null }], 999n)).to.equal(0n);
  });
  it("Sell: each swap's MINIMUM out at the slippage (never the optimistic quote) plus the USDC leg's entitlement only when the redeem is in this build", () => {
    expect(sellTaxBaseUsdcRaw([1_000_000n, 500_000n], 200, 250_000n, true)).to.equal(980_000n + 490_000n + 250_000n);
    expect(sellTaxBaseUsdcRaw([1_000_000n], 200, 250_000n, false)).to.equal(980_000n);
    expect(sellTaxBaseUsdcRaw([], 200, 250_000n, true)).to.equal(250_000n);
  });
});
