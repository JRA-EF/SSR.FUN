// One-click column sorting for the Portfolio page's Reserve Holdings table.
// Click a column header to sort by it; click the same header again to invert.
// Numeric columns start highest-first, the Asset column starts A-Z. Rows with
// no value for the column (e.g. a legacy, unsupported Reserve has no price)
// always sit at the bottom, in either direction. Ties keep the table's
// original order (Array.prototype.sort is stable).
import { calcCostBasis, calcHoldingValue, calcUnrealizedPnl } from "./calculations";
import type { DTR, Holding } from "./types";

export type HoldingsSortKey = "asset" | "balance" | "avgEntry" | "price" | "costBasis" | "value" | "pnl";
export type SortDirection = "asc" | "desc";
export interface HoldingsSort {
  key: HoldingsSortKey;
  dir: SortDirection;
}

/** The direction a column starts in on its first click. */
export function defaultDirection(key: HoldingsSortKey): SortDirection {
  return key === "asset" ? "asc" : "desc";
}

/** Next sort state after clicking `key`: a new column starts at its default, the same column inverts. */
export function nextHoldingsSort(current: HoldingsSort | null, key: HoldingsSortKey): HoldingsSort {
  if (current && current.key === key) return { key, dir: current.dir === "asc" ? "desc" : "asc" };
  return { key, dir: defaultDirection(key) };
}

export interface HoldingsSortRow {
  holding: Holding;
  /** The Reserve, when it passed eligibility; undefined for a legacy/unsupported holding. */
  dtr: DTR | undefined;
  /** Display name used for the Asset column (Reserve name, or the legacy record's name). */
  name: string;
}

/** The value a row sorts by for `key`, or null when the row has none (sorted last). */
export function holdingsSortValue(row: HoldingsSortRow, key: HoldingsSortKey): number | string | null {
  const { holding, dtr } = row;
  const finite = (n: number) => (Number.isFinite(n) ? n : null);
  switch (key) {
    case "asset":
      return row.name ? row.name.toLocaleLowerCase() : null;
    case "balance":
      return finite(holding.tokenBalance);
    case "avgEntry":
      return dtr ? finite(holding.avgPurchasePrice) : null;
    case "price":
      return dtr ? finite(dtr.tokenPrice) : null;
    case "costBasis":
      return dtr ? finite(calcCostBasis(holding)) : null;
    case "value":
      return dtr ? finite(calcHoldingValue(holding, dtr)) : null;
    case "pnl":
      return dtr ? finite(calcUnrealizedPnl(holding, dtr)) : null;
  }
}

/** Returns a new, sorted array; `sort === null` keeps the original order. */
export function sortHoldingsRows<T extends HoldingsSortRow>(rows: readonly T[], sort: HoldingsSort | null): T[] {
  const out = rows.slice();
  if (!sort) return out;
  const sign = sort.dir === "asc" ? 1 : -1;
  return out.sort((a, b) => {
    const va = holdingsSortValue(a, sort.key);
    const vb = holdingsSortValue(b, sort.key);
    if (va === null && vb === null) return 0;
    if (va === null) return 1;
    if (vb === null) return -1;
    if (typeof va === "string" && typeof vb === "string") return sign * va.localeCompare(vb);
    return sign * ((va as number) - (vb as number));
  });
}
