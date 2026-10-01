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
import { EVM_ENABLED } from "@/lib/evmFeature";
import { chainFromPath, type ChainChoice } from "@/lib/chainChoice";

export type { ChainChoice };

// viem is only needed on the Robinhood branch; keep it out of the main bundle.
const RobinhoodCreateForm = lazy(() => import("@/components/robinhood/RobinhoodCreateForm").then((m) => ({ default: m.RobinhoodCreateForm })));

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
    <div className="inline-flex rounded-full border border-border/70 bg-background/70 backdrop-blur-sm shadow-sm p-1" role="radiogroup" aria-label="Chain">
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

/**
 * The "Launch on" block: label, segmented control, and the chosen chain's
 * one-liner. It is the FIRST field of the Identity step (step 1) in both
 * wizards -- the chain is part of what the creator defines, not page chrome
 * standing above every step -- so by default it is laid out like the fields
 * around it. It appears nowhere else: not on the Solana connect-wallet gate
 * (Creator, 2026-09-30), so a visitor meets it exactly once, at the start.
 */
function ChainChoiceBlock({ chain, onChange }: { chain: ChainChoice; onChange: (c: ChainChoice) => void }) {
  const blurb = CHAINS.find((c) => c.v === chain)?.blurb;
  return (
    <div className="flex flex-col gap-2 items-start">
      <p className="font-merge-display text-[10px] font-medium uppercase tracking-[0.22em] text-muted-foreground">
        Launch on
      </p>
      <ChainPicker value={chain} onChange={onChange} />
      <p className="text-xs text-muted-foreground max-w-md">{blurb}</p>
    </div>
  );
}

export function CreateReserve() {
  const chain = chainFromPath(usePath(), EVM_ENABLED);
  const onChange = (c: ChainChoice) => navigate(c === "robinhood" ? "/create?chain=robinhood" : "/create");
  // The chooser is handed DOWN into each chain's wizard, which renders it as
  // the first field of its Identity step and nowhere else. With one chain
  // there is no choice to present, so nothing is passed at all.
  const picker = EVM_ENABLED ? <ChainChoiceBlock chain={chain} onChange={onChange} /> : undefined;

  return (
    <div>
      {chain === "solana" ? (
        <CreateDTR chainPicker={picker} />
      ) : (
        <Suspense fallback={<p className="container mx-auto px-4 py-12 text-muted-foreground">Loading…</p>}>
          <RobinhoodCreateForm chainPicker={picker} />
        </Suspense>
      )}
    </div>
  );
}
