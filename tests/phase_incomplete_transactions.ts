// DEC-0241: the recovery guardrail for mints/redemptions that stopped half
// way. Pure attribution only -- what may be converted back to USDC must
// never exceed what the flow itself put in the wallet, nor what the wallet
// still holds. Modelled on the 2026-10-14 redemption on Reserve 6z1r...KJKTB:
// 20 Reserve Tokens redeemed, BONK and A7bd... swapped to USDC, the RAY swap
// failed with Jupiter 6001 and RAY stayed in the wallet next to a small RAY
// balance the user already had.
import { expect } from "chai";
import { computeLeftovers, redeemAttribution } from "../src/merge/lib/incompleteTransactions";

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
