// Pure-logic regression coverage for the global Reserve search bar
// (src/components/ReserveSearch.tsx). Covers only src/lib/reserveSearch.ts's
// exported pure functions -- no wallet/RPC/DOM involvement, consistent with
// this repo's offline pure-function test convention (see
// tests/phase_rebalance_slider.ts for the same pattern). The component
// itself calls these exact functions (not a parallel reimplementation), so
// this also covers the keyboard-navigation and result-selection logic that
// actually ships.
//
// Run in isolation:
//   npx ts-mocha -p ./tests/tsconfig.json -t 30000 tests/phase_reserve_search.ts
import { expect } from "chai";
import {
  searchReserves,
  getPopularReserves,
  splitForHighlight,
  shortenAddress,
  nextActiveIndex,
  resolveEnterSelection,
  reservePath,
  type SearchableReserve,
} from "../src/lib/reserveSearch";

const RESERVES: SearchableReserve[] = [
  {
    id: "1",
    name: "DevNet Reserve One",
    ticker: "DNR1",
    dtrAddress: "GFP9nJQyFWurTkJCEYYkBxjksUQUXLt9i3ZoUDncTy5C",
    reserveTokenMint: "MintOne1111111111111111111111111111111111",
    aum: 100,
  },
  {
    id: "2",
    name: "DevNet Reserve Two",
    ticker: "DNR2",
    dtrAddress: "H1U22fK3fMfsmz1WirJ4H63xBDcTEHgXjtSzw73tEfcJ",
    reserveTokenMint: "MintTwo2222222222222222222222222222222222",
    aum: 500,
  },
  {
    id: "3",
    name: "Strategic Sol Reserve",
    ticker: "SSR",
    dtrAddress: "Hj8uifcUHAmTpwySQJgfo4F6B8Y68X2b48BmTKv89xSX",
    reserveTokenMint: "MintSsr3333333333333333333333333333333333",
    aum: 250,
  },
  {
    id: "4",
    name: "Solar Reserve",
    ticker: "SOLR",
    aum: 10,
    // No dtrAddress/reserveTokenMint -- exercises the "address fields absent" path.
  },
];

describe("searchReserves (src/lib/reserveSearch.ts)", () => {
  it("matches by full or partial name, case-insensitively", () => {
    const byPartialName = searchReserves(RESERVES, "reserve two");
    expect(byPartialName.map(r => r.reserve.id)).to.deep.equal(["2"]);

    const byLowercase = searchReserves(RESERVES, "devnet reserve one");
    expect(byLowercase.map(r => r.reserve.id)).to.deep.equal(["1"]);

    const byUppercase = searchReserves(RESERVES, "STRATEGIC");
    expect(byUppercase.map(r => r.reserve.id)).to.deep.equal(["3"]);
  });

  it("matches by ticker, case-insensitively", () => {
    const exact = searchReserves(RESERVES, "ssr");
    expect(exact[0].reserve.id).to.equal("3");
    expect(exact[0].score).to.equal(0);

    const mixedCase = searchReserves(RESERVES, "DnR1");
    expect(mixedCase.map(r => r.reserve.id)).to.deep.equal(["1"]);
  });

  it("matches by the full Reserve Token contract address (CA)", () => {
    const results = searchReserves(RESERVES, "MintTwo2222222222222222222222222222222222");
    expect(results.map(r => r.reserve.id)).to.deep.equal(["2"]);
    expect(results[0].addressMatched).to.equal(true);
    expect(results[0].nameMatched).to.equal(false);
    expect(results[0].tickerMatched).to.equal(false);
  });

  it("matches by a partial (substring) contract address", () => {
    // A middle slice of reserve 3's dtrAddress -- not a prefix, not the ticker/name.
    const results = searchReserves(RESERVES, "QJgfo4F6B8Y68X2b");
    expect(results.map(r => r.reserve.id)).to.deep.equal(["3"]);
    expect(results[0].score).to.equal(2); // partial, not exact/prefix
  });

  it("also matches the Reserve account address (dtrAddress), not only the token mint", () => {
    const results = searchReserves(RESERVES, "GFP9nJQyFWurTkJCEYYkBxjksUQUXLt9i3ZoUDncTy5C");
    expect(results.map(r => r.reserve.id)).to.deep.equal(["1"]);
  });

  it("ranks exact matches first, then prefix, then partial", () => {
    const reserves: SearchableReserve[] = [
      { id: "a", name: "Solar Reserve", ticker: "SOLX", aum: 0 }, // "sol" is a prefix of the ticker
      { id: "b", name: "Consolidated Reserve", ticker: "CONS", aum: 0 }, // "sol" is a partial match inside the name
      { id: "c", name: "Sol", ticker: "SOL", aum: 0 }, // "sol" exactly equals both name and ticker
    ];
    const results = searchReserves(reserves, "sol");
    expect(results.map(r => r.reserve.id)).to.deep.equal(["c", "a", "b"]);
    expect(results.map(r => r.score)).to.deep.equal([0, 1, 2]);
  });

  it("breaks ties within the same rank by higher AUM, then name", () => {
    const reserves: SearchableReserve[] = [
      { id: "low", name: "Alpha Reserve", ticker: "ALP", aum: 10 },
      { id: "high", name: "Beta Reserve", ticker: "BET", aum: 999 },
    ];
    // Both are partial matches on "reserve" with no prefix/exact winner.
    const results = searchReserves(reserves, "reserve");
    expect(results.map(r => r.reserve.id)).to.deep.equal(["high", "low"]);
  });

  it("returns [] for an empty or whitespace-only query -- never the full list", () => {
    expect(searchReserves(RESERVES, "")).to.deep.equal([]);
    expect(searchReserves(RESERVES, "   ")).to.deep.equal([]);
  });

  it('shows "no results" (an empty array) for a query that matches nothing', () => {
    expect(searchReserves(RESERVES, "zzz-nonexistent-zzz")).to.deep.equal([]);
  });

  it("dedupes by id even if the input list has a duplicate record", () => {
    const withDupe = [...RESERVES, { ...RESERVES[0] }];
    // "dnr1" only matches reserve 1's ticker exactly -- if the duplicate
    // weren't deduped, it would appear twice.
    const results = searchReserves(withDupe, "dnr1");
    expect(results.map(r => r.reserve.id)).to.deep.equal(["1"]);
  });

  it("excludes malformed/invalid records (missing id, name, or ticker), even when their other fields would otherwise match", () => {
    const withInvalid: SearchableReserve[] = [
      ...RESERVES,
      { id: "", name: "No Id Reserve", ticker: "NID", aum: 0 },
      { id: "no-name", name: "", ticker: "NN", aum: 0 },
      { id: "no-ticker", name: "No Ticker Reserve", ticker: "", aum: 0 },
    ];
    // Each query below would ONLY match the corresponding invalid record --
    // none of RESERVES' real names/tickers contain these substrings.
    expect(searchReserves(withInvalid, "nid")).to.deep.equal([]);
    expect(searchReserves(withInvalid, "nn")).to.deep.equal([]);
    expect(searchReserves(withInvalid, "no ticker reserve")).to.deep.equal([]);
  });

  it("respects the limit parameter", () => {
    const many: SearchableReserve[] = Array.from({ length: 20 }, (_, i) => ({
      id: String(i),
      name: `Reserve ${i}`,
      ticker: `R${i}`,
      aum: i,
    }));
    expect(searchReserves(many, "reserve", 3)).to.have.length(3);
  });
});

describe("getPopularReserves (src/lib/reserveSearch.ts)", () => {
  it("orders by highest AUM first", () => {
    const popular = getPopularReserves(RESERVES);
    expect(popular.map(r => r.id)).to.deep.equal(["2", "3", "1", "4"]);
  });

  it("respects the limit parameter", () => {
    expect(getPopularReserves(RESERVES, 2)).to.have.length(2);
  });

  it("returns [] for an empty input list", () => {
    expect(getPopularReserves([])).to.deep.equal([]);
  });

  it("dedupes by id", () => {
    const withDupe = [...RESERVES, { ...RESERVES[1] }];
    const popular = getPopularReserves(withDupe, 10);
    expect(popular.filter(r => r.id === "2")).to.have.length(1);
  });
});

describe("splitForHighlight (src/lib/reserveSearch.ts)", () => {
  it("splits around the first case-insensitive occurrence of the query", () => {
    const split = splitForHighlight("DevNet Reserve One", "reserve");
    expect(split).to.deep.equal({ before: "DevNet ", match: "Reserve", after: " One" });
  });

  it("preserves the original casing of the matched text", () => {
    const split = splitForHighlight("DNR1", "dnr");
    expect(split?.match).to.equal("DNR");
  });

  it("returns null when the query does not occur in the text", () => {
    expect(splitForHighlight("DevNet Reserve One", "zzz")).to.equal(null);
  });

  it("returns null for an empty query", () => {
    expect(splitForHighlight("DevNet Reserve One", "")).to.equal(null);
    expect(splitForHighlight("DevNet Reserve One", "   ")).to.equal(null);
  });
});

describe("nextActiveIndex (keyboard navigation, src/lib/reserveSearch.ts)", () => {
  it("ArrowDown from no selection (-1) lands on the first item", () => {
    expect(nextActiveIndex(-1, 3, 1)).to.equal(0);
  });

  it("ArrowUp from no selection (-1) lands on the last item", () => {
    expect(nextActiveIndex(-1, 3, -1)).to.equal(2);
  });

  it("ArrowDown wraps from the last item back to the first", () => {
    expect(nextActiveIndex(2, 3, 1)).to.equal(0);
  });

  it("ArrowUp wraps from the first item back to the last", () => {
    expect(nextActiveIndex(0, 3, -1)).to.equal(2);
  });

  it("steps forward/backward normally within range", () => {
    expect(nextActiveIndex(0, 3, 1)).to.equal(1);
    expect(nextActiveIndex(1, 3, -1)).to.equal(0);
  });

  it("always returns -1 when there are no items", () => {
    expect(nextActiveIndex(-1, 0, 1)).to.equal(-1);
    expect(nextActiveIndex(-1, 0, -1)).to.equal(-1);
  });
});

describe("resolveEnterSelection (result navigation, src/lib/reserveSearch.ts)", () => {
  it("selects the highlighted item when one is in range", () => {
    expect(resolveEnterSelection(["a", "b", "c"], 1)).to.equal("b");
  });

  it("falls back to the first (top-ranked) item when nothing is highlighted", () => {
    expect(resolveEnterSelection(["a", "b", "c"], -1)).to.equal("a");
  });

  it("falls back to the first item when the highlighted index is out of range", () => {
    expect(resolveEnterSelection(["a", "b", "c"], 99)).to.equal("a");
  });

  it("returns null when there is nothing to select", () => {
    expect(resolveEnterSelection([], -1)).to.equal(null);
    expect(resolveEnterSelection([], 0)).to.equal(null);
  });
});

describe("reservePath (src/lib/reserveSearch.ts)", () => {
  it("builds the Reserve detail route for a given id", () => {
    expect(reservePath("42")).to.equal("/dtr/42");
  });
});

describe("shortenAddress (src/lib/reserveSearch.ts)", () => {
  it("shortens a long address to first/last chars", () => {
    expect(shortenAddress("GFP9nJQyFWurTkJCEYYkBxjksUQUXLt9i3ZoUDncTy5C")).to.equal("GFP9…Ty5C");
  });

  it("leaves a short address untouched", () => {
    expect(shortenAddress("abc")).to.equal("abc");
  });
});
