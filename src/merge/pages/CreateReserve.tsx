// "Launch Reserve": one page, two chains. The creator picks Solana or
// Robinhood Chain first; each branch is that chain's own form, because the
// two are genuinely different -- a Solana reserve is funded in USDC and
// swapped into its basket, a Robinhood reserve is seeded in kind from the
// creator's wallet and deployed as its own contract.
//
// The choice rides in the URL (#/create?chain=robinhood) so it survives a
// reload and can be linked to directly.
import { lazy, Suspense } from "react";
import { usePath, navigate } from "../../lib/router";
import { CreateDTR } from "./CreateDTR";

// viem is only needed on the Robinhood branch; keep it out of the main bundle.
const RobinhoodCreateForm = lazy(() => import("@/components/robinhood/RobinhoodCreateForm").then((m) => ({ default: m.RobinhoodCreateForm })));

export type ChainChoice = "solana" | "robinhood";

export function chainFromPath(path: string): ChainChoice {
  const q = path.split("?")[1] ?? "";
  return new URLSearchParams(q).get("chain") === "robinhood" ? "robinhood" : "solana";
}

export function ChainPicker({ value, onChange }: { value: ChainChoice; onChange: (c: ChainChoice) => void }) {
  const opts: { v: ChainChoice; label: string }[] = [
    { v: "solana", label: "Solana" },
    { v: "robinhood", label: "Robinhood Chain" },
  ];
  return (
    <div className="inline-flex rounded-full border border-border bg-secondary/40 p-1" role="radiogroup" aria-label="Chain">
      {opts.map((o) => (
        <button
          key={o.v}
          role="radio"
          aria-checked={value === o.v}
          onClick={() => onChange(o.v)}
          className={`px-4 py-1.5 rounded-full text-sm font-semibold transition-colors ${
            value === o.v ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function CreateReserve() {
  const chain = chainFromPath(usePath());
  return (
    <div>
      <div className="container mx-auto px-4 md:px-8 pt-8 flex flex-wrap items-center gap-3">
        <span className="text-sm text-muted-foreground">Launch on</span>
        <ChainPicker value={chain} onChange={(c) => navigate(c === "robinhood" ? "/create?chain=robinhood" : "/create")} />
      </div>
      {chain === "solana" ? (
        <CreateDTR />
      ) : (
        <div className="container mx-auto px-4 md:px-8 py-8 max-w-3xl">
          <Suspense fallback={<p className="text-muted-foreground">Loading…</p>}>
            <RobinhoodCreateForm />
          </Suspense>
        </div>
      )}
    </div>
  );
}
