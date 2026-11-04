// /campaign -- Beta Campaign sign-up page (owner, 2026-11-04). One signature
// per wallet covers trading and every new Reserve that wallet creates.
import { CampaignSignupForm } from "@/components/CampaignSignupForm";

export function CampaignTrader() {
  return (
    <div className="container mx-auto max-w-xl px-4 py-16 space-y-6">
      <div className="space-y-2">
        <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Beta Campaign · $300 in prizes</div>
        <h1 className="text-3xl font-merge-display font-bold">Sign up for the campaign</h1>
        <p className="text-muted-foreground">
          Connect the wallet you use on SSR.FUN, add your X handle and sign once. That's all: your trades on any Reserve count,
          and every new Reserve you create with this wallet is entered automatically. Signing is free (no transaction).
          Use the same X profile when you submit on Superteam Earn.
        </p>
        <p className="text-sm text-muted-foreground">Trades on your own Reserve don't count toward volume.</p>
      </div>
      <div className="rounded-xl border border-card-border bg-card p-5">
        <CampaignSignupForm />
      </div>
      <a className="text-sm underline" href="/leaderboard" target="_blank" rel="noopener">See the leaderboard</a>
    </div>
  );
}
