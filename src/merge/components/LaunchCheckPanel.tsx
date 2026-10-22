// DEC-0249: the route check's answer on the Basket Composition step. Lists
// every asset going into the Reserve with what the creator should do about
// it: nothing (ready), continue knowingly (warning), remove or replace
// (blocked), and the assets already removed with a reminder to pick a
// replacement.
import { AlertCircle, CheckCircle2, RefreshCw, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { LaunchCheck, LaunchCheckResult, RemovedLaunchAsset } from "@/lib/launchPreflight";

const BADGE = "text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded border shrink-0";

function StatusBadge({ result }: { result: LaunchCheckResult | undefined }) {
  if (!result) return <span className={`${BADGE} border-border text-muted-foreground`}>Not checked</span>;
  if (result.status === "blocked") return <span className={`${BADGE} border-destructive/50 bg-destructive/10 text-destructive`}>Must remove</span>;
  if (result.status === "warning") return <span className={`${BADGE} border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400`}>Risky -- can continue</span>;
  if (result.status === "unchecked") return <span className={`${BADGE} border-border text-muted-foreground`}>Could not check</span>;
  return <span className={`${BADGE} border-emerald-500/40 text-emerald-600 dark:text-emerald-400`}>Ready</span>;
}

export function LaunchCheckPanel({
  assets,
  check,
  checking,
  removed,
  onRemove,
  onRemoveAllBlocked,
  onRecheck,
  onClearRemoved,
}: {
  assets: { symbol: string; name: string; weight: number }[];
  check: LaunchCheck | null;
  checking: boolean;
  removed: RemovedLaunchAsset[];
  onRemove: (symbol: string) => void;
  onRemoveAllBlocked: () => void;
  onRecheck: () => void;
  onClearRemoved: () => void;
}) {
  if (!check && !checking && removed.length === 0) return null;
  const bySymbol = new Map((check?.results ?? []).map((r) => [r.symbol, r]));
  const blocked = assets.filter((a) => bySymbol.get(a.symbol)?.status === "blocked");
  const failedDuringLaunch = blocked.some((a) => bySymbol.get(a.symbol)?.failedDuringLaunch);
  const risky = assets.filter((a) => {
    const s = bySymbol.get(a.symbol)?.status;
    return s === "warning" || s === "unchecked";
  });

  return (
    <div className={`rounded-xl border overflow-hidden ${blocked.length > 0 ? "border-destructive/50" : "border-border"}`}>
      <div className="bg-muted/50 p-4 border-b border-border flex items-start justify-between gap-3">
        <div>
          <h3 className="font-semibold">{failedDuringLaunch ? "Your launch stopped on an asset" : "Route check"}</h3>
          <p className="text-xs text-muted-foreground mt-1">
            {checking
              ? "Checking that every asset can be swapped into from USDC at the amount your Reserve needs..."
              : blocked.length > 0
                ? `${blocked.length === 1 ? "1 asset" : `${blocked.length} assets`} would make the launch fail. Remove ${blocked.length === 1 ? "it" : "them"} (and pick ${blocked.length === 1 ? "a replacement" : "replacements"} if you like), bring the total back to 100%, and continue. Everything else you entered is kept.`
                : risky.length > 0
                  ? "Nothing blocks the launch. The assets marked risky can still be included; read why before continuing."
                  : "Every asset can be swapped into at the amount your Reserve needs."}
          </p>
        </div>
        <Button type="button" variant="ghost" size="sm" className="h-8 gap-1.5 text-xs shrink-0" onClick={onRecheck} disabled={checking || assets.length === 0}>
          <RefreshCw className={`w-3.5 h-3.5 ${checking ? "animate-spin" : ""}`} /> Check again
        </Button>
      </div>

      <div className="divide-y divide-border/60">
        {assets.map((a) => {
          const r = bySymbol.get(a.symbol);
          return (
            <div key={a.symbol} className="p-3 text-sm space-y-1.5">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2 min-w-0">
                  {r?.status === "blocked" ? (
                    <AlertCircle className="w-4 h-4 text-destructive shrink-0" />
                  ) : r?.status === "ok" ? (
                    <CheckCircle2 className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
                  ) : (
                    <AlertCircle className="w-4 h-4 text-muted-foreground shrink-0" />
                  )}
                  <span className="font-semibold">{a.symbol}</span>
                  <span className="font-merge-mono text-xs text-muted-foreground">{(a.weight * 100).toFixed(1)}%</span>
                  <StatusBadge result={checking ? undefined : r} />
                </div>
                {r?.status === "blocked" && (
                  <Button type="button" variant="outline" size="sm" className="h-7 px-2 text-xs gap-1 border-destructive/50 text-destructive hover:bg-destructive/10" onClick={() => onRemove(a.symbol)}>
                    <X className="w-3.5 h-3.5" /> Remove
                  </Button>
                )}
              </div>
              {!checking && r && r.reason && <p className="text-xs text-muted-foreground pl-6">{r.reason}</p>}
              {!checking && r && r.status !== "blocked" && r.priceImpactPct !== null && r.route.length > 0 && (
                <p className="text-[11px] text-muted-foreground pl-6 font-merge-mono">
                  via {r.route.join(" -> ")} · price impact {r.priceImpactPct.toFixed(2)}%
                </p>
              )}
            </div>
          );
        })}
        {removed.map((r) => (
          <div key={`removed-${r.symbol}`} className="p-3 text-sm space-y-1.5 bg-muted/20">
            <div className="flex items-center gap-2">
              <X className="w-4 h-4 text-muted-foreground shrink-0" />
              <span className="font-semibold line-through text-muted-foreground">{r.symbol}</span>
              <span className={`${BADGE} border-border text-muted-foreground`}>Removed -- replace it</span>
            </div>
            <p className="text-xs text-muted-foreground pl-6">{r.reason} Pick another asset from the list to take its place, or give its share to the assets you kept.</p>
          </div>
        ))}
      </div>

      {(blocked.length > 1 || removed.length > 0) && (
        <div className="p-3 border-t border-border flex flex-wrap justify-end gap-2">
          {removed.length > 0 && (
            <Button type="button" variant="ghost" size="sm" className="h-8 text-xs text-muted-foreground" onClick={onClearRemoved}>
              Hide removed assets
            </Button>
          )}
          {blocked.length > 1 && (
            <Button type="button" variant="outline" size="sm" className="h-8 text-xs border-destructive/50 text-destructive hover:bg-destructive/10" onClick={onRemoveAllBlocked}>
              Remove all {blocked.length} problem assets
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
