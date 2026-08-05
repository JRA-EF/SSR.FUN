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

/** The range a Reserve-detail page opens on. Exported (rather than inlined as a literal in DTRDetail's useState) so it is assertable in a test instead of silently drifting. */
export const DEFAULT_CHART_TIMEFRAME: ChartTimeframe = "7d";

export function ChartTimeframeSelector({
  timeframe,
  onChange,
}: {
  timeframe: ChartTimeframe;
  onChange: (tf: ChartTimeframe) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Chart time range">
      {CHART_TIMEFRAMES.map((tf) => (
        <button
          key={tf}
          type="button"
          onClick={() => onChange(tf)}
          aria-pressed={timeframe === tf}
          // A border is present in BOTH states (only its colour changes), so
          // hovering/selecting never shifts layout by a pixel.
          className={`inline-flex h-7 items-center justify-center whitespace-nowrap rounded-md border px-2.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background ${
            timeframe === tf
              ? "border-primary bg-primary text-primary-foreground shadow-sm"
              : "border-border bg-background text-muted-foreground hover:border-primary/40 hover:bg-primary/5 hover:text-foreground"
          }`}
        >
          {tf}
        </button>
      ))}
    </div>
  );
}
