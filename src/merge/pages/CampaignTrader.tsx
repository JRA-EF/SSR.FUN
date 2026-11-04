// /campaign -- Beta Campaign trader sign-up (owner, 2026-11-04). A trader
// connects the wallet they trade with, types their X handle and signs a plain
// message (no transaction, no fee). The server checks the signature, so the
// leaderboard can rank that wallet under the handle, and the Earn submission's
// X profile must match it. Creators sign up on their Reserve's page instead.
import { useEffect, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { useAppStore } from "@/store/useAppStore";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { normalizeHandle, traderEntryMessage } from "../../../lib/campaign/rules";

interface Status {
  open: boolean;
  phase: string;
  entry: { handle: string; wallet: string; enteredAt: string } | null;
}

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

export function CampaignTrader() {
  const wallet = useWallet();
  const { setWalletModalOpen } = useAppStore();
  const address = wallet.publicKey?.toBase58() ?? null;
  const [status, setStatus] = useState<Status | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [handle, setHandle] = useState("");
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);

  useEffect(() => {
    setStatus(null); setMessage(null); setEditing(false); setLoadError(false);
    if (!address) return;
    let cancelled = false;
    fetch(`/api/mainnet/campaign-entry?wallet=${encodeURIComponent(address)}`, { cache: "no-store" })
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((s: Status) => { if (!cancelled) setStatus(s); })
      .catch(() => { if (!cancelled) setLoadError(true); });
    return () => { cancelled = true; };
  }, [address]);

  const submit = async () => {
    setMessage(null);
    const h = normalizeHandle(handle);
    if (!h) { setMessage({ text: "Enter a valid X handle (letters, numbers and _ only, up to 15).", error: true }); return; }
    if (!address || !wallet.signMessage) { setMessage({ text: "Your wallet can't sign messages. Try Phantom, Solflare or Backpack.", error: true }); return; }
    setBusy(true);
    try {
      const issuedAt = new Date().toISOString();
      const signature = await wallet.signMessage(new TextEncoder().encode(traderEntryMessage({ wallet: address, handle: h, issuedAt })));
      const r = await fetch("/api/mainnet/campaign-entry", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "trader", wallet: address, handle: h, issuedAt, signature: toBase64(signature) }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || "Sign-up failed. Please try again.");
      setStatus(s => (s ? { ...s, entry: j.entry } : s));
      setEditing(false);
      setMessage({ text: "You're signed up. Your trades on campaign Reserves now count on the leaderboard.", error: false });
    } catch (e) {
      const text = e instanceof Error ? e.message : "Sign-up failed. Please try again.";
      setMessage({ text: /reject|declin|cancel/i.test(text) ? "Signature cancelled." : text, error: true });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="container mx-auto max-w-xl px-4 py-16 space-y-6">
      <div className="space-y-2">
        <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Beta Campaign · $300 in prizes</div>
        <h1 className="text-3xl font-merge-display font-bold">Sign up as a trader</h1>
        <p className="text-muted-foreground">
          Trading volume on Reserves created during the campaign counts toward the $150 Volume prize. Connect the wallet you trade with,
          add your X handle and sign once. Signing is free (no transaction). Use the same X profile when you submit on Superteam Earn.
        </p>
        <p className="text-sm text-muted-foreground">
          Created a Reserve? Sign up on your Reserve's page instead. Trades on your own Reserve don't count toward volume.
        </p>
      </div>

      <div className="rounded-xl border border-card-border bg-card p-5 space-y-3">
        {!address ? (
          <Button className="rounded-full" onClick={() => setWalletModalOpen(true)}>Connect Wallet</Button>
        ) : loadError ? (
          <p className="text-sm text-destructive">Couldn't check your sign-up just now. Please reload the page.</p>
        ) : !status ? (
          <p className="text-sm text-muted-foreground">Checking…</p>
        ) : status.entry && !editing ? (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm">
              Wallet …{address.slice(-4)} is signed up as{" "}
              <a className="font-semibold underline" href={`https://x.com/${status.entry.handle}`} target="_blank" rel="noopener noreferrer">@{status.entry.handle}</a>.
            </p>
            {status.open && <Button variant="outline" size="sm" onClick={() => { setHandle(status.entry!.handle); setEditing(true); }}>Change handle</Button>}
          </div>
        ) : !status.open ? (
          <p className="text-sm text-muted-foreground">The campaign has closed; sign-ups are no longer accepted.</p>
        ) : (
          <>
            <p className="text-sm text-muted-foreground">Signing up wallet …{address.slice(-4)}.</p>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input value={handle} onChange={e => setHandle(e.target.value)} placeholder="@yourhandle" maxLength={40} autoCapitalize="off" spellCheck={false} className="sm:max-w-xs" />
              <Button onClick={submit} disabled={busy || !handle.trim()}>{busy ? "Waiting for signature…" : "Sign & enter"}</Button>
            </div>
          </>
        )}
        {message && <p className={`text-sm ${message.error ? "text-destructive" : "text-muted-foreground"}`} role="status">{message.text}</p>}
      </div>

      <a className="text-sm underline" href="/leaderboard" target="_blank" rel="noopener">See the leaderboard</a>
    </div>
  );
}
