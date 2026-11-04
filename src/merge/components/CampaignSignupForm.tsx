// Beta Campaign sign-up (owner, 2026-11-04): one signature per wallet covers
// everything. The connected wallet signs a plain message with the X handle
// (no transaction, no fee); after that its trades count and every new Reserve
// it creates is entered automatically. Used on /campaign and on Reserve pages.
import { useEffect, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { useAppStore } from "@/store/useAppStore";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { normalizeHandle, signupMessage } from "../../../lib/campaign/rules";

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

/** Loads the connected wallet's sign-up; `hideWhenClosed` keeps Reserve pages clean after the campaign. */
export function CampaignSignupForm({ hideWhenClosed = false }: { hideWhenClosed?: boolean }) {
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

  if (hideWhenClosed && (loadError || (status && !status.open && !status.entry))) return null;

  const submit = async () => {
    setMessage(null);
    const h = normalizeHandle(handle);
    if (!h) { setMessage({ text: "Enter a valid X handle (letters, numbers and _ only, up to 15).", error: true }); return; }
    if (!address || !wallet.signMessage) { setMessage({ text: "Your wallet can't sign messages. Try Phantom, Solflare or Backpack.", error: true }); return; }
    setBusy(true);
    try {
      const issuedAt = new Date().toISOString();
      const signature = await wallet.signMessage(new TextEncoder().encode(signupMessage({ wallet: address, handle: h, issuedAt })));
      const r = await fetch("/api/mainnet/campaign-entry", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "trader", wallet: address, handle: h, issuedAt, signature: toBase64(signature) }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || "Sign-up failed. Please try again.");
      setStatus(s => (s ? { ...s, entry: j.entry } : s));
      setEditing(false);
      setMessage({ text: "You're signed up. Your trades and every new Reserve you create now count on the leaderboard.", error: false });
    } catch (e) {
      const text = e instanceof Error ? e.message : "Sign-up failed. Please try again.";
      setMessage({ text: /reject|declin|cancel/i.test(text) ? "Signature cancelled." : text, error: true });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
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
            Your trades and new Reserves count automatically.{" "}
            <a className="underline" href="/leaderboard" target="_blank" rel="noopener">See the leaderboard</a>
          </p>
          {status.open && <Button variant="outline" size="sm" onClick={() => { setHandle(status.entry!.handle); setEditing(true); }}>Change handle</Button>}
        </div>
      ) : !status.open ? (
        <p className="text-sm text-muted-foreground">The campaign has closed; sign-ups are no longer accepted.</p>
      ) : (
        <>
          <p className="text-sm text-muted-foreground">Signing up wallet …{address.slice(-4)}. You only do this once.</p>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input value={handle} onChange={e => setHandle(e.target.value)} placeholder="@yourhandle" maxLength={40} autoCapitalize="off" spellCheck={false} className="sm:max-w-xs" />
            <Button onClick={submit} disabled={busy || !handle.trim()}>{busy ? "Waiting for signature…" : "Sign & enter"}</Button>
          </div>
        </>
      )}
      {message && <p className={`text-sm ${message.error ? "text-destructive" : "text-muted-foreground"}`} role="status">{message.text}</p>}
    </div>
  );
}
