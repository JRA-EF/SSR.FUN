/* Composition weight pill — a full-width rounded bar segmented by asset
 * weight, in the SSR brand palette. Sits directly under the Reserve
 * Composition header (it replaced first the donut, then a space-hungry
 * treemap grid) so the table below keeps the card's full width.
 *
 * Responsive: the pill measures itself and lays the basket out over as many
 * weight-balanced rows as its width requires (1 on wide screens, 2-4 as it
 * narrows), so segment labels never overflow their slices. Label detail also
 * steps down per-segment by actual pixel width: symbol+percent, symbol only,
 * then tooltip-only for slivers.
 */

import { useEffect, useRef, useState } from "react";

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

/** Estimated pixels a segment needs to show its full "SYM 99.9%" label. */
function fullLabelPx(item: WeightItem): number {
  return 18 + item.symbol.length * 9 + 42;
}

export function WeightPill({ items }: { items: WeightItem[] }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => setWidth(entries[0].contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const sorted = [...items].filter((i) => i.weight > 0).sort((a, b) => b.weight - a.weight);
  const total = sorted.reduce((s, i) => s + i.weight, 0);
  if (total <= 0) return null;

  // Rows needed so every segment could carry its full label at this width.
  const totalMin = sorted.reduce((s, i) => s + fullLabelPx(i), 0);
  const rowCount = width > 0 ? Math.min(4, Math.max(1, Math.ceil(totalMin / width))) : sorted.length > 8 ? 2 : 1;

  // Weight-balanced sequential split into rowCount rows.
  const rows: WeightItem[][] = [];
  let current: WeightItem[] = [];
  let acc = 0;
  for (const item of sorted) {
    current.push(item);
    acc += item.weight;
    const rowsLeft = rowCount - rows.length - 1;
    const itemsLeft = sorted.length - sorted.indexOf(item) - 1;
    if (rows.length < rowCount - 1 && acc >= (total * (rows.length + 1)) / rowCount && itemsLeft >= rowsLeft) {
      rows.push(current);
      current = [];
    }
  }
  if (current.length) rows.push(current);

  const colorOf = (symbol: string) => SSR_TILE_COLORS[sorted.findIndex((s) => s.symbol === symbol) % SSR_TILE_COLORS.length];
  return (
    <div
      ref={containerRef}
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
              const segPx = width > 0 ? (widthPct / 100) * width : 0;
              const c = colorOf(item.symbol);
              const showFull = width > 0 ? segPx >= fullLabelPx(item) : widthPct >= 11;
              const showSym = width > 0 ? segPx >= 20 + item.symbol.length * 9 : widthPct >= 6;
              return (
                <div
                  key={item.symbol}
                  className="flex items-center justify-center gap-1 whitespace-nowrap overflow-hidden border-r last:border-r-0"
                  style={{ width: `${widthPct}%`, background: c.bg, color: c.ink, borderColor: "hsl(var(--card))" }}
                  title={`${item.symbol} ${truePct.toFixed(2)}%`}
                >
                  {showFull ? (
                    <>
                      <span className="font-merge-display text-[10px] font-semibold">{item.symbol}</span>
                      <span className="font-merge-mono text-[10px] opacity-80">{truePct.toFixed(1)}%</span>
                    </>
                  ) : showSym ? (
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
