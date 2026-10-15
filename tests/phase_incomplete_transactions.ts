// DEC-0241: the recovery guardrail for mints/redemptions that stopped half
// way. Pure attribution only -- what may be converted back to USDC must
// never exceed what the flow itself put in the wallet, nor what the wallet
// still holds. Modelled on the 2026-10-14 redemption on Reserve 6z1r...KJKTB:
// 20 Reserve Tokens redeemed, BONK and A7bd... swapped to USDC, the RAY swap
// failed with Jupiter 6001 and RAY stayed in the wallet next to a small RAY
// balance the user already had.
import { expect } from "chai";
import { computeLeftovers, dustAttribution, redeemAttribution } from "../src/merge/lib/incompleteTransactions";
import { clearAbandonedCreate, readAbandonedCreates, recordAbandonedCreate } from "../src/merge/lib/recoveryRecords";

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const RAY = "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R";
const BONK = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
const A7BD = "A7bdiYdS5GjqGFtxf17ppRHtDKPkkRqbKtR27dxvQXaS";
const RT = "6z1r7H76YYgo3vSy8kNJYisS1vCdmYu5NmTSWxZKJKTB";

describe("incompleteTransactions -- leftover attribution (DEC-0241)", () => {
  // Token deltas of redeem …R2Ta9q for the owner.
  const payout = { [RAY]: 4_877_096n, [A7BD]: 656_666n, [BONK]: 64_185_541_804n, [RT]: -20_000_000n, [USDC]: 0n };

  it("a redeem's payout minus every leg already swapped into USDC is what is left", () => {
    const attributed = redeemAttribution(payout, { [BONK]: { signature: "s1", confirmed: true }, [A7BD]: { signature: "s2", confirmed: true }, [RAY]: { signature: "s3" } });
    expect(attributed).to.deep.equal({ [RAY]: 4_877_096n });
  });

  it("never includes USDC, the burned Reserve Token, or a zero payout", () => {
    const attributed = redeemAttribution(payout, {});
    expect(Object.keys(attributed).sort()).to.deep.equal([A7BD, BONK, RAY].sort());
  });

  it("leaves the user's own pre-existing balance alone: only the redeem's payout is converted", () => {
    // Wallet holds 4.922489 RAY: 4.877096 from the redeem + 0.045393 already there.
    const left = computeLeftovers({ [RAY]: 4_877_096n }, {}, { [RAY]: 4_922_489n });
    expect(left).to.deep.equal({ [RAY]: 4_877_096n });
  });

  it("is capped by what the wallet still holds", () => {
    const left = computeLeftovers({ [RAY]: 4_877_096n }, {}, { [RAY]: 1_000_000n });
    expect(left).to.deep.equal({ [RAY]: 1_000_000n });
  });

  it("subtracts confirmed recovery swaps, so nothing is converted twice", () => {
    expect(computeLeftovers({ [RAY]: 4_877_096n }, { [RAY]: 4_877_096n }, { [RAY]: 45_393n })).to.deep.equal({});
    expect(computeLeftovers({ [RAY]: 4_877_096n }, { [RAY]: 4_000_000n }, { [RAY]: 922_489n })).to.deep.equal({ [RAY]: 877_096n });
  });

  it("returns nothing when the asset has left the wallet or is USDC", () => {
    expect(computeLeftovers({ [RAY]: 5n, [USDC]: 10n }, {}, { [USDC]: 10n })).to.deep.equal({});
  });
});

describe("incompleteTransactions -- mint dust attribution (DEC-0241)", () => {
  it("a batch mint's leftover is what its swaps acquired minus what the mint deposited", () => {
    // Swaps bought 1.02x the requirement; the mint deposited exactly 1x.
    const left = dustAttribution({ [RAY]: 1_020_000n, [BONK]: 51_000n }, { [RAY]: -1_000_000n, [BONK]: -50_000n, [RT]: 5_000_000n, [USDC]: 0n }, [RT]);
    expect(left).to.deep.equal({ [RAY]: 20_000n, [BONK]: 1_000n });
  });

  it("a single atomic mint's leftover is its own positive net delta", () => {
    const left = dustAttribution({}, { [RAY]: 20_000n, [USDC]: -10_000_000n, [RT]: 5_000_000n }, [RT]);
    expect(left).to.deep.equal({ [RAY]: 20_000n });
  });

  it("never counts the Reserve Token or USDC, nor an asset the mint took from the user's own balance", () => {
    // The mint consumed 50 raw of RAY the user already held (acquired < deposited).
    const left = dustAttribution({ [RAY]: 950n, [USDC]: 10n }, { [RAY]: -1_000n, [RT]: 7n }, [RT]);
    expect(left).to.deep.equal({});
  });

  it("is still capped by the wallet and by earlier conversions", () => {
    const attributed = dustAttribution({ [RAY]: 1_020_000n }, { [RAY]: -1_000_000n }, [RT]);
    expect(computeLeftovers(attributed, {}, { [RAY]: 5_000n })).to.deep.equal({ [RAY]: 5_000n });
    expect(computeLeftovers(attributed, { [RAY]: 20_000n }, { [RAY]: 90_000n })).to.deep.equal({});
  });
});

describe("recoveryRecords -- cancelled launches (DEC-0241)", () => {
  const store: Record<string, string> = {};
  before(() => {
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => void (store[k] = v),
      removeItem: (k: string) => void delete store[k],
    };
  });

  it("is saved only when a seed swap was actually submitted", () => {
    const base = { wallet: "W", reserve: "R1", programId: "P", name: "Test", startedAt: 1 };
    expect(recordAbandonedCreate({ ...base, assetFunding: { [RAY]: { mint: RAY, status: "not_started" } } })).to.equal(false);
    expect(readAbandonedCreates("W")).to.have.length(0);
    expect(recordAbandonedCreate({ ...base, assetFunding: { [RAY]: { mint: RAY, status: "confirmed", lastSignature: "sig" } } })).to.equal(true);
    expect(readAbandonedCreates("W").map((r) => r.reserve)).to.deep.equal(["R1"]);
    expect(readAbandonedCreates("someone-else")).to.have.length(0);
    clearAbandonedCreate("W", "R1");
    expect(readAbandonedCreates("W")).to.have.length(0);
  });
});
