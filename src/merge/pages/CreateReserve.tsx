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

const CHAINS: { v: ChainChoice; label: string; blurb: string }[] = [
  { v: "solana", label: "Solana", blurb: "Settles in USDC. Buy and sell in one click; the Reserve swaps into its basket for you." },
  {
    v: "robinhood",
    label: "Robinhood Chain",
    blurb: "Holds tokenized equities (NVDA, SPY, AMZN…) and USDG. You seed the basket from your own wallet; buys and sells are in kind.",
  },
];

/** An explicit, equal choice between the chains -- neither is the afterthought. */
export function ChainPicker({ value, onChange }: { value: ChainChoice; onChange: (c: ChainChoice) => void }) {
  return (
    <div className="grid sm:grid-cols-2 gap-3" role="radiogroup" aria-label="Chain">
      {CHAINS.map((c) => {
        const active = value === c.v;
        return (
          <button
            key={c.v}
            role="radio"
            aria-checked={active}
            onClick={() => onChange(c.v)}
            className={`text-left rounded-xl border p-4 transition-colors ${
              active ? "border-primary bg-primary/10" : "border-border bg-card/40 hover:border-primary/40"
            }`}
          >
            <span className="flex items-center gap-2">
              <span
                aria-hidden="true"
                className={`w-3.5 h-3.5 rounded-full border-2 ${active ? "border-primary bg-primary" : "border-muted-foreground"}`}
              />
              <span className="font-merge-display font-bold">{c.label}</span>
            </span>
            <span className="block text-sm text-muted-foreground mt-2">{c.blurb}</span>
          </button>
        );
      })}
    </div>
  );
}

export function CreateReserve() {
  const chain = chainFromPath(usePath());
  return (
    <div>
      <div className="container mx-auto px-4 md:px-8 pt-8 max-w-3xl">
        <p className="font-merge-display text-[10px] font-medium uppercase tracking-[0.22em] text-muted-foreground mb-3">
          Choose a chain
        </p>
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
