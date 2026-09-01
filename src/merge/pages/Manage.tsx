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
import { Button } from "@/components/ui/button";
import { MergeParamsContext } from "@/lib/wouter-shim";
import { ManageDTR } from "./ManageDTR";

function ManageGateHero() {
  return (
    /* Full-bleed hero art behind the gate screens (public/manage-gate-hero.jpg)
       — the shared mascot-hero treatment: scrim for legibility, bottom fade
       into the ground, hides itself if the file is absent. */
    <div aria-hidden="true" className="absolute top-0 left-1/2 w-screen -translate-x-1/2 h-[240px] sm:h-[400px] overflow-hidden pointer-events-none -z-10">
      <img
        src="/manage-gate-hero.jpg"
        alt=""
        className="w-full h-full object-cover"
        style={{ objectPosition: "center 30%" }}
        onError={(e) => { (e.currentTarget.parentElement as HTMLElement).style.display = "none"; }}
      />
      {/* Centered wash (not the left scrim other heroes use): this gate's
          text is center-aligned, so legibility needs the middle calmed. */}
      <div className="absolute inset-0" style={{ background: "radial-gradient(ellipse 55% 90% at 50% 62%, hsl(var(--background) / 0.88) 0%, hsl(var(--background) / 0.5) 55%, hsl(var(--background) / 0.05) 100%)" }} />
      <div className="absolute inset-0" style={{ background: "linear-gradient(180deg, hsl(var(--background) / 0) 0%, hsl(var(--background) / 0.15) 68%, hsl(var(--background)) 100%)" }} />
    </div>
  );
}

export function Manage() {
  const { wallet, dtrs, setWalletModalOpen } = useAppStore();
  const managed = dtrs.filter((d) => isManagerOrDelegate(d, wallet.address));
  const [selected, setSelected] = useState<string | null>(null);
  const activeId = selected && managed.some((d) => d.id === selected) ? selected : managed[0]?.id;

  if (!wallet.connected) {
    return (
      <div className="container mx-auto px-4 py-24 text-center relative">
        <ManageGateHero />
        <div className="max-w-md mx-auto space-y-6">
          <Shield className="w-16 h-16 text-primary mx-auto mb-4" />
          <h1 className="text-3xl font-merge-display font-bold">Connect Wallet</h1>
          {/* Inline margins: same unlayered <p> reset workaround as the other gates. */}
          <p className="text-muted-foreground" style={{ marginTop: 15, marginBottom: 12 }}>Connect a wallet to manage your Reserves.</p>
          <Button className="rounded-full h-12 px-10 text-base mt-6" onClick={() => setWalletModalOpen(true)}>
            Connect Wallet
          </Button>
        </div>
      </div>
    );
  }

  if (managed.length === 0) {
    return (
      <div className="container mx-auto px-4 py-24 text-center relative">
        <ManageGateHero />
        <div className="max-w-md mx-auto space-y-6">
          <Shield className="w-16 h-16 text-muted-foreground mx-auto mb-4" />
          <h1 className="text-3xl font-merge-display font-bold">Reserve Manager</h1>
          <p className="text-muted-foreground">You do not manage any Reserves yet.</p>
          {/* Native .btn-primary, not the shadcn Button: FABLE's unlayered
              `a { color: var(--accent-ink) }` base rule always beats Tailwind's
              layered text-primary-foreground utility, which made the shadcn
              button render low-contrast purple-on-purple text here. .btn-primary
              sets a literal `color: #fff` that wins on unlayered specificity. */}
          <Link href="/create" className="btn btn-primary btn-lg">Launch a Reserve</Link>
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
