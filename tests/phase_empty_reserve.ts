// DEC-0246: a seeded Reserve whose every Reserve Token was redeemed stays
// discoverable (it used to be hidden as "never seeded" -- the live "Salami"
// report, 2026-10-15) and is shown with a "possibly abandoned" warning, no
// price, and no Mint action.
import { expect } from "chai";
import type { DTR } from "../src/merge/lib/types";
import { buildReserveCardProps } from "../src/merge/lib/reserveCardProps";
import { mergeDiscoveredReserves } from "../src/merge/lib/onChainReserve";
import { isEmptyReserve, EMPTY_RESERVE_WARNING, DEVUSDC } from "../packages/sdk/src";

function makeOnChainDtr(id: string, status: string, supplyRaw: string): DTR {
  return {
    id,
    name: id,
    ticker: id.toUpperCase(),
    description: "",
    category: "DevNet Test",
    tags: [],
    logoSeed: id,
    dtrAddress: id,
    managerAddress: "11111111111111111111111111111111",
    delegates: [],
    feeConfig: { mintFeePct: 0.5, tvlFeePct: 1, creatorFeeDestination: "11111111111111111111111111111111", feeRecipients: [] },
    tokenPrice: 1,
    nav: 1,
    aum: 0,
    liquidityUsdc: 0,
    change24h: 0,
    change7d: 0,
    holders: 0,
    composition: [],
    unallocatedPct: 0,
    isUserCreated: false,
    priceHistory: [{ t: Date.now(), price: 1 }],
    trades: [],
    onChain: {
      programId: "2dURvmSdHeyaFES5rxaE1zgPSHCBLW5BLNguJ2Tu1mkW",
      reserveId: "0",
      reserve: id,
      reserveTokenMint: "11111111111111111111111111111111",
      mintAuthority: "11111111111111111111111111111111",
      vaultAuthority: "11111111111111111111111111111111",
      manager: "11111111111111111111111111111111",
      assets: [{ mint: DEVUSDC.mint, symbol: "devUSDC", decimals: DEVUSDC.decimals, weightBps: 10_000, reserveAsset: "ra", vault: "v", vaultBalanceRaw: "0" }],
      status: status as never,
      assetCount: 1,
      totalTargetWeightBps: 10_000,
      reserveTokenSupplyRaw: supplyRaw,
      vaultBalancesRaw: {},
      assetsResolvedFully: true,
    },
  } as DTR;
}

describe("DEC-0246 empty Reserves (every Reserve Token redeemed)", () => {
  it("isEmptyReserve is true only for a seeded Reserve with zero supply", () => {
    expect(isEmptyReserve({ status: "active", reserveTokenSupplyRaw: "0" })).to.equal(true);
    expect(isEmptyReserve({ status: "paused", reserveTokenSupplyRaw: "0" })).to.equal(true);
    expect(isEmptyReserve({ status: "windDown", reserveTokenSupplyRaw: "0" })).to.equal(true);
    expect(isEmptyReserve({ status: "active", reserveTokenSupplyRaw: "1" })).to.equal(false);
    expect(isEmptyReserve({ status: "assetsInitializing", reserveTokenSupplyRaw: "0" })).to.equal(false);
    expect(isEmptyReserve(undefined)).to.equal(false);
  });

  it("stays in discovery instead of being quarantined; a never-seeded Reserve is still quarantined", () => {
    const empty = makeOnChainDtr("salami", "active", "0");
    const unseeded = makeOnChainDtr("draft", "assetsInitializing", "0");
    const { dtrs, quarantined } = mergeDiscoveredReserves([], [empty, unseeded], true);
    expect(dtrs.map((d) => d.id)).to.deep.equal(["salami"]);
    expect(quarantined.map((q) => q.id)).to.deep.equal(["draft"]);
  });

  it("the card carries the warning, shows $0.00 (Creator, 2026-10-28) and offers View instead of Mint", () => {
    const card = buildReserveCardProps(makeOnChainDtr("salami", "active", "0"), true);
    expect(card.emptyWarning).to.match(/possibly abandoned/i);
    expect(card.ctaLabel).to.equal("View");
    expect(card.priceFormatted).to.equal("$0.00");
    expect(card.metrics.find((m) => m.key === "price")?.value).to.equal("$0.00");
  });

  it("a Reserve with supply has no warning and the normal Mint button", () => {
    const card = buildReserveCardProps(makeOnChainDtr("live", "active", "1000000"), true);
    expect(card.emptyWarning).to.equal(undefined);
    expect(card.ctaLabel).to.equal(undefined);
  });

  it("the warning says 0 Reserve Tokens, possibly abandoned, do your own research", () => {
    expect(EMPTY_RESERVE_WARNING).to.match(/0 Reserve Tokens/);
    expect(EMPTY_RESERVE_WARNING).to.match(/abandoned by its creator/);
    expect(EMPTY_RESERVE_WARNING).to.match(/Do your own research/);
  });
});
