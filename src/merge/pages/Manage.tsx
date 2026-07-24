// MERGE has no top-level "pick a Reserve to manage" route of its own -- its
// Manager Dashboard only appears per-Reserve (a "Manage Reserve" link on that
// Reserve's own detail page, gated by isManagerOrDelegate). FABLE's navbar has
// a standing "Manage" link, so this thin hub lists the wallet's managed
// Reserves and renders MERGE's actual ManageDTR component for the selected
// one -- the substantive UI/logic below is untouched MERGE code.
import { useState } from "react";
import { Link } from "wouter";
import { Shield } from "lucide-react";
import { useAppStore, isManagerOrDelegate } from "@/store/useAppStore";
import { MergeParamsContext } from "@/lib/wouter-shim";
import { ManageDTR } from "./ManageDTR";

export function Manage() {
  const { wallet, dtrs } = useAppStore();
  const managed = dtrs.filter((d) => isManagerOrDelegate(d, wallet.address));
  const [selected, setSelected] = useState<string | null>(null);
  const activeId = selected && managed.some((d) => d.id === selected) ? selected : managed[0]?.id;

  if (!wallet.connected) {
    return (
      <div className="container mx-auto px-4 py-24 text-center">
        <div className="max-w-md mx-auto space-y-6">
          <Shield className="w-16 h-16 text-primary mx-auto mb-4" />
          <h1 className="text-3xl font-merge-display font-bold">Connect Wallet</h1>
          <p className="text-muted-foreground">Connect a wallet to manage your Reserves.</p>
          <div className="p-4 bg-muted/50 rounded-lg border border-border">
            <p className="text-sm font-medium">Use the "Connect Wallet" button in the navigation bar to proceed.</p>
          </div>
        </div>
      </div>
    );
  }

  if (managed.length === 0) {
    return (
      <div className="container mx-auto px-4 py-24 text-center">
        <div className="max-w-md mx-auto space-y-6">
          <Shield className="w-16 h-16 text-muted-foreground mx-auto mb-4" />
          <h1 className="text-3xl font-merge-display font-bold">Reserve Manager</h1>
          <p className="text-muted-foreground">You do not manage any Reserves yet.</p>
          {/* Native .btn-primary, not the shadcn Button: FABLE's unlayered
              `a { color: var(--accent-ink) }` base rule always beats Tailwind's
              layered text-primary-foreground utility, which made the shadcn
              button render low-contrast purple-on-purple text here. .btn-primary
              sets a literal `color: #fff` that wins on unlayered specificity. */}
          <Link href="/create" className="btn btn-primary btn-lg">Launch Reserve</Link>
        </div>
      </div>
    );
  }

  return (
    <>
      {managed.length > 1 && (
        <div className="container mx-auto px-4 max-w-6xl pt-8 flex flex-wrap gap-2">
          {managed.map((d) => (
            <button
              key={d.id}
              onClick={() => setSelected(d.id)}
              className={`px-4 py-2 rounded-lg text-sm font-medium border transition-colors ${
                d.id === activeId
                  ? "bg-primary text-primary-foreground border-primary"
                  : "border-border hover:bg-muted"
              }`}
            >
              {d.name} <span className="font-merge-mono opacity-70">{d.ticker}</span>
            </button>
          ))}
        </div>
      )}
      {activeId && (
        <MergeParamsContext.Provider value={{ dtrId: activeId }}>
          <ManageDTR />
        </MergeParamsContext.Provider>
      )}
    </>
  );
}
