// Phase B's DevNet onboarding panel: real devUSDC ("SSR Test USD") faucet
// claims and a tightly-limited real DevNet SOL grant, so an internal tester
// can get moving without depending entirely on the public DevNet faucet. See
// docs/project/DEVNET_IMPLEMENTATION_PLAN_2026-07-29.md "Phase B" for the
// full design and docs/protocol/FRONTEND_INTEGRATION.md for the endpoint
// architecture (api/devnet/faucet-devusdc.ts, api/devnet/sponsor-sol.ts).
//
// Every balance shown here is read live from Solana DevNet (never a
// simulated/local number) and is only ever displayed as "confirmed" after a
// real transaction signature comes back from the server AND the balance is
// re-fetched from chain afterward -- no optimistic/local update. Both
// claim endpoints add funds only (no user wallet signature is required,
// matching this app's existing mint-test-assets.ts precedent), but every
// action still goes through real pending -> submitted -> confirmed/failed
// states with a real Explorer link.
import { useCallback, useEffect, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { DEVUSDC, DEVUSDC_MINT, fetchTokenBalanceRaw } from "@ssr/sdk";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { InfoTip } from "@/components/InfoTip";
import { TransactionConfirmedCard } from "@/components/TransactionConfirmation";

type ClaimStatus = "idle" | "submitting" | "confirmed" | "failed";

interface ClaimState {
  status: ClaimStatus;
  signature: string | null;
  error: string | null;
}

const IDLE: ClaimState = { status: "idle", signature: null, error: null };
const PUBLIC_FAUCET_URL = "https://faucet.solana.com";

async function postJson(url: string, body: unknown): Promise<{ ok: boolean; json: Record<string, unknown> }> {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  return { ok: res.ok, json };
}

export function DevnetOnboarding() {
  const { connection } = useConnection();
  const { publicKey, connected } = useWallet();

  const [solBalanceLamports, setSolBalanceLamports] = useState<number | null>(null);
  const [devUsdcBalanceRaw, setDevUsdcBalanceRaw] = useState<bigint | null>(null);
  const [devUsdcClaim, setDevUsdcClaim] = useState<ClaimState>(IDLE);
  const [solClaim, setSolClaim] = useState<ClaimState>(IDLE);

  const refreshBalances = useCallback(async () => {
    if (!publicKey) return;
    try {
      const [lamports, devUsdcRaw] = await Promise.all([
        connection.getBalance(publicKey, "confirmed"),
        fetchTokenBalanceRaw(connection, DEVUSDC_MINT, publicKey),
      ]);
      setSolBalanceLamports(lamports);
      setDevUsdcBalanceRaw(BigInt(devUsdcRaw));
    } catch {
      // Transient RPC failure -- leave the last known values in place rather
      // than showing a fabricated zero; the user can retry via the buttons.
    }
  }, [connection, publicKey]);

  useEffect(() => {
    if (connected && publicKey) {
      refreshBalances();
    } else {
      setSolBalanceLamports(null);
      setDevUsdcBalanceRaw(null);
    }
  }, [connected, publicKey, refreshBalances]);

  async function claimDevUsdc() {
    if (!publicKey) return;
    setDevUsdcClaim({ status: "submitting", signature: null, error: null });
    try {
      const { ok, json } = await postJson("/api/devnet/faucet-devusdc", { userPubkey: publicKey.toBase58() });
      if (!ok) {
        setDevUsdcClaim({ status: "failed", signature: null, error: typeof json.error === "string" ? json.error : "Claim failed." });
        return;
      }
      setDevUsdcClaim({ status: "confirmed", signature: typeof json.signature === "string" ? json.signature : null, error: null });
      await refreshBalances();
    } catch (e) {
      setDevUsdcClaim({ status: "failed", signature: null, error: e instanceof Error ? e.message : "Claim failed." });
    }
  }

  async function claimSol() {
    if (!publicKey) return;
    setSolClaim({ status: "submitting", signature: null, error: null });
    try {
      const { ok, json } = await postJson("/api/devnet/sponsor-sol", { userPubkey: publicKey.toBase58() });
      if (!ok) {
        setSolClaim({ status: "failed", signature: null, error: typeof json.error === "string" ? json.error : "Grant failed." });
        return;
      }
      setSolClaim({ status: "confirmed", signature: typeof json.signature === "string" ? json.signature : null, error: null });
      await refreshBalances();
    } catch (e) {
      setSolClaim({ status: "failed", signature: null, error: e instanceof Error ? e.message : "Grant failed." });
    }
  }

  if (!connected || !publicKey) return null;

  const devUsdcHuman = devUsdcBalanceRaw !== null ? (Number(devUsdcBalanceRaw) / 10 ** DEVUSDC.decimals).toLocaleString(undefined, { maximumFractionDigits: 2 }) : "—";
  const solHuman = solBalanceLamports !== null ? (solBalanceLamports / 1e9).toLocaleString(undefined, { maximumFractionDigits: 5 }) : "—";

  return (
    <Card className="bg-card/40 border-border/50 mb-8">
      <CardHeader className="pb-4">
        <CardTitle className="text-lg flex items-center gap-2">
          DevNet Onboarding
          <InfoTip label="More information about DevNet onboarding">Real Solana DevNet assets with zero monetary value, for internal testing only.</InfoTip>
        </CardTitle>
        <CardDescription>SSR Test USD (devUSDC) and DevNet SOL have no real value -- this panel only ever operates on Solana DevNet.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {/* devUSDC */}
          <div className="p-4 bg-muted/30 rounded-lg border border-border/50 space-y-3">
            <div className="flex items-center justify-between">
              <div>
                <div className="flex items-center gap-2">
                  <div className="w-6 h-6 rounded-full bg-emerald-500/20 text-emerald-500 flex items-center justify-center text-xs font-bold">$</div>
                  <span className="font-semibold">devUSDC</span>
                  <span className="text-[10px] text-muted-foreground uppercase tracking-wide">SSR Test USD</span>
                </div>
                <div className="font-merge-mono text-xl mt-1">{devUsdcHuman}</div>
              </div>
              <Button size="sm" onClick={claimDevUsdc} disabled={devUsdcClaim.status === "submitting"}>
                {devUsdcClaim.status === "submitting" ? "Requesting..." : "Claim devUSDC"}
              </Button>
            </div>
            {devUsdcClaim.status === "confirmed" && (
              devUsdcClaim.signature ? (
                <TransactionConfirmedCard headline="Confirmed on Solana DevNet" signature={devUsdcClaim.signature} size="xs" className="text-positive" />
              ) : (
                <p className="text-xs text-positive">Confirmed on Solana DevNet.</p>
              )
            )}
            {devUsdcClaim.status === "failed" && <p className="text-xs text-destructive">{devUsdcClaim.error}</p>}
            <p className="text-[11px] text-muted-foreground">devUSDC has no monetary value and exists only for DevNet testing.</p>
          </div>

          {/* DevNet SOL */}
          <div className="p-4 bg-muted/30 rounded-lg border border-border/50 space-y-3">
            <div className="flex items-center justify-between">
              <div>
                <div className="flex items-center gap-2">
                  <div className="w-6 h-6 rounded-full bg-purple-500/20 text-purple-500 flex items-center justify-center text-xs font-bold">
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
                      <path d="M4 17.5l14-3.5 2.5 3.5-14 3.5zm2.5-11L20.5 3l-2.5-3.5L4 3zM4 10.5l14-3.5 2.5 3.5-14 3.5z" />
                    </svg>
                  </div>
                  <span className="font-semibold">DevNet SOL</span>
                </div>
                <div className="font-merge-mono text-xl mt-1">{solHuman}</div>
              </div>
              <Button size="sm" variant="outline" onClick={claimSol} disabled={solClaim.status === "submitting"}>
                {solClaim.status === "submitting" ? "Requesting..." : "Request SOL"}
              </Button>
            </div>
            {solClaim.status === "confirmed" && (
              solClaim.signature ? (
                <TransactionConfirmedCard headline="Confirmed on Solana DevNet" signature={solClaim.signature} size="xs" className="text-positive" />
              ) : (
                <p className="text-xs text-positive">Confirmed on Solana DevNet.</p>
              )
            )}
            {solClaim.status === "failed" && <p className="text-xs text-destructive">{solClaim.error}</p>}
            <p className="text-[11px] text-muted-foreground">
              DevNet SOL pays real network fees and account rent -- it is not the settlement asset for buying Reserve Tokens. Grants up to 1
              SOL, once per wallet every 24 hours;{" "}
              <a href={PUBLIC_FAUCET_URL} target="_blank" rel="noreferrer" className="underline">
                use the public DevNet faucet
              </a>{" "}
              for larger amounts or if the SSR-sponsored grant is unavailable.
            </p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
