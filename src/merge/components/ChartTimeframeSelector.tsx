import type { ChartTimeframe } from "@/lib/types";

// Kept as its own small, dependency-free component (no store/router/wallet
// context) specifically so it can be rendered and asserted on directly in an
// offline test -- see tests/phase_chart_range_selector.ts. This is what
// caught and fixed a real regression: every entry here was already a
// distinct <button>, but a global, unlayered `button {}` reset in
// src/index.css (see its own comment) was silently stripping each button's
// Tailwind padding/background, making 10 real buttons render as one
// visually concatenated string ("1s1m5m1h4h24h7d30d1yAll").
export const CHART_TIMEFRAMES: ChartTimeframe[] = ["1s", "1m", "5m", "1h", "4h", "24h", "7d", "30d", "1y", "All"];

export function ChartTimeframeSelector({
  timeframe,
  onChange,
}: {
  timeframe: ChartTimeframe;
  onChange: (tf: ChartTimeframe) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1 bg-muted/50 p-1 rounded-md" role="group" aria-label="Chart time range">
      {CHART_TIMEFRAMES.map((tf) => (
        <button
          key={tf}
          type="button"
          onClick={() => onChange(tf)}
          aria-pressed={timeframe === tf}
          className={`px-2.5 py-1 text-xs font-medium rounded-sm transition-colors whitespace-nowrap focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 ${
            timeframe === tf
              ? "bg-background text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground hover:bg-muted"
          }`}
        >
          {tf}
        </button>
      ))}
    </div>
  );
}
