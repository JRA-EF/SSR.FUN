// Beta Campaign entry (DEC-0279): shown on a Mainnet Reserve's page to its
// creator (manager wallet) only. The creator types their X handle and signs a
// plain message with the wallet (no transaction, no fee). The server checks
// the signature and that the wallet is the Reserve's on-chain manager, then
// the Reserve appears on ssr.fun/leaderboard under that handle.
import { useEffect, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { entryMessage, normalizeHandle } from "../../../lib/campaign/rules";

interface EntryStatus {
  open: boolean;
  phase: string;
  entry: { handle: string; wallet: string; enteredAt: string } | null;
}

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

export function CampaignEntryCard({ reserve }: { reserve: string }) {
  const wallet = useWallet();
  const [status, setStatus] = useState<EntryStatus | null>(null);
  const [handle, setHandle] = useState("");
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/mainnet/campaign-entry?reserve=${encodeURIComponent(reserve)}`, { cache: "no-store" })
      .then(r => (r.ok ? r.json() : null))
      .then((s: EntryStatus | null) => { if (!cancelled) setStatus(s); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [reserve]);

  if (!status || (!status.open && !status.entry)) return null;

  const submit = async () => {
    setMessage(null);
    const h = normalizeHandle(handle);
    if (!h) { setMessage({ text: "Enter a valid X handle (letters, numbers and _ only, up to 15).", error: true }); return; }
    if (!wallet.publicKey || !wallet.signMessage) { setMessage({ text: "Your wallet can't sign messages. Try Phantom, Solflare or Backpack.", error: true }); return; }
    setBusy(true);
    try {
      const walletAddress = wallet.publicKey.toBase58();
      const issuedAt = new Date().toISOString();
      const text = entryMessage({ reserve, wallet: walletAddress, handle: h, issuedAt });
      const signature = await wallet.signMessage(new TextEncoder().encode(text));
      const r = await fetch("/api/mainnet/campaign-entry", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reserve, wallet: walletAddress, handle: h, issuedAt, signature: toBase64(signature) }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || "Entry failed. Please try again.");
      setStatus({ ...status, entry: j.entry });
      setEditing(false);
      setMessage({ text: "You're entered. Your Reserve now shows on the leaderboard.", error: false });
    } catch (e) {
      const text = e instanceof Error ? e.message : "Entry failed. Please try again.";
      setMessage({ text: /reject|declin|cancel/i.test(text) ? "Signature cancelled." : text, error: true });
    } finally {
      setBusy(false);
    }
  };

  const showForm = status.open && (!status.entry || editing);

  return (
    <div className="mb-6 rounded-xl border border-card-border bg-card p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Beta Campaign · $300 in prizes</div>
          {status.entry && !editing ? (
            <p className="mt-1 text-sm">
              Entered as <a className="font-semibold underline" href={`https://x.com/${status.entry.handle}`} target="_blank" rel="noopener noreferrer">@{status.entry.handle}</a>.{" "}
              <a className="underline" href="/leaderboard" target="_blank" rel="noopener">See the leaderboard</a>
            </p>
          ) : (
            <p className="mt-1 text-sm text-muted-foreground">
              Enter this Reserve in the campaign: add your X handle and sign with the wallet that created it. Signing is free (no transaction).
            </p>
          )}
        </div>
        {status.entry && !editing && status.open && (
          <Button variant="outline" size="sm" onClick={() => { setHandle(status.entry!.handle); setEditing(true); }}>Change handle</Button>
        )}
      </div>
      {showForm && (
        <div className="mt-3 flex flex-col gap-2 sm:flex-row">
          <Input value={handle} onChange={e => setHandle(e.target.value)} placeholder="@yourhandle" maxLength={40} autoCapitalize="off" spellCheck={false} className="sm:max-w-xs" />
          <Button onClick={submit} disabled={busy || !handle.trim()}>{busy ? "Waiting for signature…" : "Sign & enter"}</Button>
        </div>
      )}
      {message && <p className={`mt-2 text-sm ${message.error ? "text-destructive" : "text-muted-foreground"}`} role="status">{message.text}</p>}
    </div>
  );
}
