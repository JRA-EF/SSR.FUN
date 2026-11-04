// Beta Campaign card on a Mainnet Reserve's page, shown to its creator only
// (DEC-0279, simplified 2026-11-04). The sign-up is per wallet, not per
// Reserve: once the creator's wallet has signed up, every new Reserve it
// creates is entered automatically, so this card just shows that state or
// offers the one-time sign-up.
import { CampaignSignupForm } from "./CampaignSignupForm";

export function CampaignEntryCard(_props: { reserve: string }) {
  return (
    <div className="mb-6 rounded-xl border border-card-border bg-card p-4 sm:p-5 space-y-2">
      <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Beta Campaign · $300 in prizes</div>
      <CampaignSignupForm hideWhenClosed />
    </div>
  );
}
