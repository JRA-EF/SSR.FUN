/* Composition weight pill — one slim, full-width rounded bar segmented by
 * asset weight, in the SSR brand palette. Sits directly under the Reserve
 * Composition header (it replaced first the donut, then a space-hungry
 * treemap grid) so the table below keeps the card's full width.
 */

interface WeightItem {
  symbol: string;
  weight: number;
}

/* SSR brand palette, ordered so neighbouring segments contrast. Paired
 * `ink` is the readable text color on that segment. Assigned by
 * descending-weight rank — the table's row dots use the same rule. */
export const SSR_TILE_COLORS: Array<{ bg: string; ink: string }> = [
  { bg: "#4155a6", ink: "#ffffff" }, // reserve blue
  { bg: "#c9d3f7", ink: "#070429" }, // peri-soft
  { bg: "#1c1465", ink: "#ffffff" }, // indigo
  { bg: "#97abef", ink: "#070429" }, // periwinkle
  { bg: "#2f5be2", ink: "#ffffff" }, // action blue
  { bg: "#ede871", ink: "#070429" }, // SSR yellow
  { bg: "#0d0940", ink: "#ffffff" }, // deep navy
];

/* Above this many assets a single line can't label its tail, so the pill
   doubles in height and lays the basket out as two weight-balanced rows. */
const SINGLE_ROW_MAX = 8;

export function WeightPill({ items }: { items: WeightItem[] }) {
  const sorted = [...items].filter((i) => i.weight > 0).sort((a, b) => b.weight - a.weight);
  const total = sorted.reduce((s, i) => s + i.weight, 0);
  if (total <= 0) return null;

  let rows: WeightItem[][];
  if (sorted.length <= SINGLE_ROW_MAX) {
    rows = [sorted];
  } else {
    // Split at ~half the total weight so both rows carry similar visual mass.
    const first: WeightItem[] = [];
    let acc = 0;
    for (const item of sorted) {
      if (acc >= total / 2 && first.length > 0) break;
      first.push(item);
      acc += item.weight;
    }
    rows = [first, sorted.slice(first.length)];
  }

  const colorOf = (symbol: string) => SSR_TILE_COLORS[sorted.findIndex((s) => s.symbol === symbol) % SSR_TILE_COLORS.length];
  return (
    <div
      className={`w-full overflow-hidden border border-border/60 ${rows.length > 1 ? "rounded-3xl" : "rounded-full"}`}
      role="img"
      aria-label="Reserve composition by weight"
    >
      {rows.map((row, r) => {
        const rowTotal = row.reduce((s, i) => s + i.weight, 0);
        return (
          <div key={r} className={`flex w-full h-9 ${r > 0 ? "border-t-2" : ""}`} style={{ borderColor: "hsl(var(--card))" }}>
            {row.map((item) => {
              const truePct = (item.weight / total) * 100;
              const widthPct = (item.weight / rowTotal) * 100;
              const c = colorOf(item.symbol);
              return (
                <div
                  key={item.symbol}
                  className="flex items-center justify-center gap-1 whitespace-nowrap overflow-hidden border-r last:border-r-0"
                  style={{ width: `${widthPct}%`, background: c.bg, color: c.ink, borderColor: "hsl(var(--card))" }}
                  title={`${item.symbol} ${truePct.toFixed(2)}%`}
                >
                  {widthPct >= 11 ? (
                    <>
                      <span className="font-merge-display text-[10px] font-semibold">{item.symbol}</span>
                      <span className="font-merge-mono text-[10px] opacity-80">{truePct.toFixed(1)}%</span>
                    </>
                  ) : widthPct >= 6 ? (
                    <span className="font-merge-display text-[10px] font-semibold">{item.symbol}</span>
                  ) : null}
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}
