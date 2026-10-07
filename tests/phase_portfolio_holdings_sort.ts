// Portfolio > Reserve Holdings: one-click column sorting (2026-10-07).
// First click on a column sorts it (numbers highest first, Asset A-Z), the
// next click on the same column inverts; legacy rows without a price always
// stay at the bottom.
import { expect } from "chai";
import * as fs from "fs";
import * as path from "path";
import { defaultDirection, nextHoldingsSort, sortHoldingsRows, type HoldingsSortRow } from "../src/merge/lib/holdingsSort";
import type { DTR } from "../src/merge/lib/types";

const dtr = (id: string, name: string, tokenPrice: number) => ({ id, name, tokenPrice, nav: tokenPrice } as unknown as DTR);
const rows: HoldingsSortRow[] = [
  { holding: { dtrId: "a", tokenBalance: 10, avgPurchasePrice: 1 }, dtr: dtr("a", "Alpha", 2), name: "Alpha" }, // value 20, pnl +10, cost 10
  { holding: { dtrId: "b", tokenBalance: 100, avgPurchasePrice: 0.5 }, dtr: dtr("b", "bravo", 0.4), name: "bravo" }, // value 40, pnl -10, cost 50
  { holding: { dtrId: "c", tokenBalance: 1, avgPurchasePrice: 3 }, dtr: dtr("c", "Charlie", 5), name: "Charlie" }, // value 5, pnl +2, cost 3
  { holding: { dtrId: "x", tokenBalance: 50, avgPurchasePrice: 0 }, dtr: undefined, name: "Legacy" }, // no price data
];
const ids = (r: HoldingsSortRow[]) => r.map((x) => x.holding.dtrId).join("");

describe("Portfolio holdings sort -- click behaviour", () => {
  it("first click: numbers highest-first, Asset A-Z; second click on the same column inverts", () => {
    expect(defaultDirection("value")).to.equal("desc");
    expect(defaultDirection("asset")).to.equal("asc");
    const s1 = nextHoldingsSort(null, "value");
    expect(s1).to.deep.equal({ key: "value", dir: "desc" });
    expect(nextHoldingsSort(s1, "value")).to.deep.equal({ key: "value", dir: "asc" });
    expect(nextHoldingsSort(nextHoldingsSort(s1, "value"), "value")).to.deep.equal({ key: "value", dir: "desc" });
  });

  it("clicking a different column starts that column at its own default", () => {
    expect(nextHoldingsSort({ key: "value", dir: "asc" }, "pnl")).to.deep.equal({ key: "pnl", dir: "desc" });
    expect(nextHoldingsSort({ key: "value", dir: "desc" }, "asset")).to.deep.equal({ key: "asset", dir: "asc" });
  });
});

describe("Portfolio holdings sort -- ordering", () => {
  it("no sort keeps the natural order and never mutates the input", () => {
    const before = ids(rows);
    expect(ids(sortHoldingsRows(rows, null))).to.equal("abcx");
    sortHoldingsRows(rows, { key: "value", dir: "desc" });
    expect(ids(rows)).to.equal(before);
  });

  it("sorts every column both ways, legacy rows last either way", () => {
    const cases: [Parameters<typeof sortHoldingsRows>[1], string][] = [
      [{ key: "value", dir: "desc" }, "bacx"],
      [{ key: "value", dir: "asc" }, "cabx"],
      [{ key: "pnl", dir: "desc" }, "acbx"],
      [{ key: "pnl", dir: "asc" }, "bcax"],
      [{ key: "costBasis", dir: "desc" }, "bacx"],
      [{ key: "price", dir: "desc" }, "cabx"],
      [{ key: "avgEntry", dir: "desc" }, "cabx"],
      [{ key: "avgEntry", dir: "asc" }, "bacx"],
      [{ key: "asset", dir: "asc" }, "abcx"], // Alpha, bravo, Charlie (case-insensitive), then Legacy
      [{ key: "asset", dir: "desc" }, "xcba"], // Legacy has a name, so it sorts with the rest
    ];
    for (const [sort, expected] of cases) expect(ids(sortHoldingsRows(rows, sort)), JSON.stringify(sort)).to.equal(expected);
  });

  it("balance is known for legacy rows too, so they sort with everyone", () => {
    expect(ids(sortHoldingsRows(rows, { key: "balance", dir: "desc" }))).to.equal("bxac");
    expect(ids(sortHoldingsRows(rows, { key: "balance", dir: "asc" }))).to.equal("caxb");
  });
});

describe("Portfolio page wiring", () => {
  const page = fs.readFileSync(path.resolve(__dirname, "../src/merge/pages/Portfolio.tsx"), "utf8");
  it("every data column header is sortable; Action is not", () => {
    for (const k of ["asset", "balance", "avgEntry", "price", "costBasis", "value", "pnl"]) expect(page).to.include(`sortKey="${k}"`);
    expect(page).to.match(/<TableHead className="text-right">Action<\/TableHead>/);
  });
  it("the sort hook sits before the not-connected early return (stable hook order)", () => {
    expect(page.indexOf("useState<HoldingsSort | null>")).to.be.lessThan(page.indexOf("if (!isConnected)"));
  });
});
