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
import { useAppStore } from "@/store/useAppStore";
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

/**
 * The "Launch on" block: label, segmented control, and the chosen chain's
 * one-liner.
 *
 * `overArt` gives it a glass panel. Bare centred text on top of the hero
 * photograph reads as unfinished and the blurb loses contrast against the
 * bright parts of the image; a surface makes it a deliberate control and
 * keeps the text legible wherever the art happens to be light.
 */
function ChainChoiceBlock({
  chain,
  onChange,
  overArt = false,
}: {
  chain: ChainChoice;
  onChange: (c: ChainChoice) => void;
  overArt?: boolean;
}) {
  const blurb = CHAINS.find((c) => c.v === chain)?.blurb;
  return (
    <div
      className={
        overArt
          ? "inline-flex flex-col items-center gap-3 text-center rounded-2xl border border-border/60 bg-background/80 backdrop-blur-md px-7 py-6 shadow-xl"
          : "flex flex-col items-center gap-2.5 text-center"
      }
    >
      <p className="font-merge-display text-[10px] font-medium uppercase tracking-[0.22em] text-muted-foreground">
        Launch on
      </p>
      <ChainPicker value={chain} onChange={onChange} />
      <p className="text-sm text-muted-foreground max-w-sm" style={{ marginTop: 2 }}>
        {blurb}
      </p>
    </div>
  );
}

export function CreateReserve() {
  const chain = chainFromPath(usePath());
  const solanaConnected = useAppStore((s) => s.wallet.connected);
  const onChange = (c: ChainChoice) => navigate(c === "robinhood" ? "/create?chain=robinhood" : "/create");
  const picker = <ChainChoiceBlock chain={chain} onChange={onChange} />;
  const pickerOverArt = <ChainChoiceBlock chain={chain} onChange={onChange} overArt />;

  // Solana, no wallet yet: the chain choice takes the place of the connect
  // gate's own heading and CTA, sitting over the hero art. The header already
  // has a Connect Wallet button, so a second one here was just noise in front
  // of the decision the page actually starts with.
  if (chain === "solana" && !solanaConnected) return <CreateDTR chainPicker={pickerOverArt} />;

  if (chain === "solana") {
    return (
      <div>
        <div className="container mx-auto px-4 md:px-8 pt-8 pb-2">{picker}</div>
        <CreateDTR />
      </div>
    );
  }

  return (
    <div>
      {/* Robinhood: the same hero treatment as the Solana gate, so switching
          chains does not change the shape of the page. */}
      <div className="container mx-auto px-4 relative text-center flex items-center justify-center min-h-[320px] sm:min-h-[440px] py-12">
        <div aria-hidden="true" className="absolute top-0 left-1/2 w-screen -translate-x-1/2 h-[320px] sm:h-[440px] overflow-hidden pointer-events-none -z-10">
          <img
            src="/create-gate-hero.jpg"
            alt=""
            className="w-full h-full object-cover"
            // 1800x1028 art: the crest starts ~12% down, so the window must
            // open near the top of the frame. No scale() -- magnifying about
            // the centre is what cropped the head off.
            style={{ objectPosition: "center 14%" }}
            onError={(e) => { (e.currentTarget.parentElement as HTMLElement).style.display = "none"; }}
          />
          <div className="absolute inset-0" style={{ background: "radial-gradient(ellipse 55% 90% at 50% 62%, hsl(var(--background) / 0.88) 0%, hsl(var(--background) / 0.5) 55%, hsl(var(--background) / 0.05) 100%)" }} />
          <div className="absolute inset-0" style={{ background: "linear-gradient(180deg, hsl(var(--background) / 0) 0%, hsl(var(--background) / 0.15) 68%, hsl(var(--background)) 100%)" }} />
        </div>
        {pickerOverArt}
      </div>
      <div className="container mx-auto px-4 md:px-8 pb-8 max-w-3xl">
        <Suspense fallback={<p className="text-muted-foreground">Loading…</p>}>
          <RobinhoodCreateForm />
        </Suspense>
      </div>
    </div>
  );
}
