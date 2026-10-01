// The Launch page's header and 1-2-3-4 progress rail, shared by both chains so
// creating a Reserve is the same flow whether it lands on Solana or Robinhood
// Chain. Extracted from CreateDTR verbatim -- if the Solana wizard's chrome
// changes, the Robinhood one changes with it.
export const LAUNCH_STEPS = ["Identity", "Composition", "Economics", "Review"] as const;

export function LaunchHeader({ subtitle }: { subtitle: string }) {
  return (
    <div className="mb-8">
      <h1 className="text-4xl font-merge-display font-bold mb-2">Launch a Reserve</h1>
      <p className="text-muted-foreground">{subtitle}</p>
    </div>
  );
}

export function LaunchStepper({ step }: { step: number }) {
  return (
    <div className="flex justify-between mb-8 relative">
      {/* Anchored to top-4 (16px = half of the w-8/h-8 circle below), not top-1/2 of the
          whole step item -- top-1/2 measured against the full circle+label height, which
          sits the line below the circles' true center. */}
      <div className="absolute top-4 left-0 right-0 h-0.5 bg-border -z-10 -translate-y-1/2"></div>
      <div
        className="absolute top-4 left-0 h-0.5 bg-primary -z-10 -translate-y-1/2 transition-all duration-300"
        style={{ width: `${((step - 1) / 3) * 100}%` }}
      ></div>

      {[1, 2, 3, 4].map((s) => (
        <div key={s} className="flex flex-col items-center gap-2">
          <div
            className={`w-8 h-8 rounded-full flex items-center justify-center font-bold text-sm transition-colors
              ${s < step ? "bg-primary text-primary-foreground" : s === step ? "bg-background border-2 border-primary text-primary" : "bg-background border-2 border-border text-muted-foreground"}
            `}
          >
            {s}
          </div>
          <span className={`text-xs font-semibold hidden sm:block ${s <= step ? "text-foreground" : "text-muted-foreground"}`}>
            {LAUNCH_STEPS[s - 1]}
          </span>
        </div>
      ))}
    </div>
  );
}
