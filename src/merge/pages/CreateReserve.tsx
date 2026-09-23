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
    blurb: "Holds tokenized equities (NVDA, SPY, AMZN) and USDG. You seed the basket from your own wallet; buys and sells are in kind.",
  },
];

/**
 * An equal choice between the chains, as a segmented control.
 *
 * Built from labels + radios rather than <button>s on purpose: merge.css
 * restyles any `.merge-scope button` carrying a bg-primary/bg-action class
 * into an uppercase Lexend Giga action button, which turned the selected
 * option into a giant CTA and left the other one in body type.
 */
export function ChainPicker({ value, onChange }: { value: ChainChoice; onChange: (c: ChainChoice) => void }) {
  return (
    <div className="inline-flex rounded-full border border-border bg-secondary/40 p-1" role="radiogroup" aria-label="Chain">
      {CHAINS.map((c) => {
        const active = value === c.v;
        return (
          <label
            key={c.v}
            className={`cursor-pointer select-none rounded-full px-4 py-1.5 text-sm font-semibold transition-colors ${
              active ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
            }`}
          >
            <input
              type="radio"
              name="ssr-create-chain"
              className="sr-only"
              checked={active}
              onChange={() => onChange(c.v)}
            />
            {c.label}
          </label>
        );
      })}
    </div>
  );
}

export function CreateReserve() {
  const chain = chainFromPath(usePath());
  const blurb = CHAINS.find((c) => c.v === chain)?.blurb;
  return (
    <div>
      {/* Centred to match the page beneath it (the connect gate and the wizard
          are both centre-weighted), and compact so choosing a chain reads as
          one step of Launch rather than a slab bolted above the page. */}
      <div className="container mx-auto px-4 md:px-8 pt-8 pb-2 flex flex-col items-center gap-2.5 text-center">
        <p className="font-merge-display text-[10px] font-medium uppercase tracking-[0.22em] text-muted-foreground">
          Launch on
        </p>
        <ChainPicker value={chain} onChange={(c) => navigate(c === "robinhood" ? "/create?chain=robinhood" : "/create")} />
        <p className="text-sm text-muted-foreground max-w-md">{blurb}</p>
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
