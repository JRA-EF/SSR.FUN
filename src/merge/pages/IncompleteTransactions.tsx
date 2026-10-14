// /recover -- incomplete mints and redemptions (DEC-0241). When a Reserve is
// too large for one atomic transaction, a mint or redemption runs as several,
// and one of them can fail after another landed. This page shows exactly
// what happened (with signatures) and converts whatever that flow left in
// the wallet back into USDC, so the user ends up holding only USDC or
// Reserve Tokens. The logic lives in lib/incompleteTransactions.ts.
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "wouter";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { AlertCircle, CheckCircle2, ExternalLink, Loader2 } from "lucide-react";
import { useAppStore } from "@/store/useAppStore";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { explorerUrl } from "@/lib/solana-config";
import { fetchAssetPricesUsd, type AssetPriceInfo } from "@/lib/assetPricing";
import { convertLeftoversToUsdc, findIncompleteTransactions, type IncompleteTransaction, type RecoveryProgress } from "@/lib/incompleteTransactions";

const short = (s: string) => `...${s.slice(-6)}`;

function formatRaw(raw: bigint, decimals: number): string {
  const n = Number(raw) / 10 ** decimals;
  return n.toLocaleString(undefined, { maximumFractionDigits: n < 1 ? 6 : 4 });
}

function describeProgress(p: RecoveryProgress | null): string {
  if (!p) return "Working...";
  if (p.phase === "quoting") return `Getting a USDC price for asset ${p.index + 1} of ${p.total}...`;
  if (p.phase === "awaiting-wallet") return `Approve ${p.total === 1 ? "the swap" : `${p.total} swaps`} in your wallet...`;
  if (p.phase === "confirming") return `Confirming on Solana (${p.signature.slice(0, 8)}...)...`;
  return "Checking your wallet...";
}

export function IncompleteTransactions() {
  const { connection } = useConnection();
  const walletCtx = useWallet();
  const { wallet, dtrs, setWalletModalOpen } = useAppStore();
  const { toast } = useToast();
  const [items, setItems] = useState<IncompleteTransaction[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [prices, setPrices] = useState<Record<string, AssetPriceInfo>>({});
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [progress, setProgress] = useState<RecoveryProgress | null>(null);
  const [itemError, setItemError] = useState<Record<string, string>>({});

  const reserveByAddress = useMemo(() => {
    const m = new Map<string, (typeof dtrs)[number]>();
    for (const d of dtrs) if (d.onChain?.reserve) m.set(d.onChain.reserve, d);
    return m;
  }, [dtrs]);
  const symbolOf = useCallback(
    (mint: string) => {
      for (const d of dtrs) {
        const a = d.onChain?.assets.find((x) => x.mint === mint);
        if (a?.symbol) return a.symbol;
      }
      return `${mint.slice(0, 4)}...${mint.slice(-4)}`;
    },
    [dtrs],
  );

  const load = useCallback(async () => {
    if (!walletCtx.publicKey) return;
    setLoadError(null);
    try {
      const found = await findIncompleteTransactions(connection, walletCtx.publicKey, (r) => reserveByAddress.get(r)?.onChain?.reserveTokenMint ?? null);
      setItems(found);
      const assets = found.flatMap((t) => t.leftovers.map((l) => ({ mint: l.mint, decimals: l.decimals })));
      if (assets.length > 0) fetchAssetPricesUsd(assets).then(setPrices).catch(() => setPrices({}));
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    }
  }, [connection, walletCtx.publicKey, reserveByAddress]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleConvert = async (item: IncompleteTransaction) => {
    const key = `${item.kind}:${item.reserve}`;
    setBusyKey(key);
    setProgress(null);
    setItemError((e) => ({ ...e, [key]: "" }));
    useAppStore.getState().setTxInFlight(true);
    try {
      const result = await convertLeftoversToUsdc(connection, walletCtx, item, setProgress);
      if (result.remaining.length === 0) {
        toast({ title: "Converted to USDC", description: "Everything this transaction left in your wallet is now USDC." });
      } else {
        const msg = result.remaining.map((r) => `${symbolOf(r.mint)}: ${r.reason}`).join(" ");
        setItemError((e) => ({ ...e, [key]: msg }));
      }
    } catch (e) {
      setItemError((err) => ({ ...err, [key]: e instanceof Error ? e.message : String(e) }));
    } finally {
      useAppStore.getState().setTxInFlight(false);
      setBusyKey(null);
      setProgress(null);
      await load();
    }
  };

  if (!wallet.connected || !walletCtx.publicKey) {
    return (
      <div className="container mx-auto px-4 py-24 text-center">
        <div className="max-w-md mx-auto space-y-6">
          <h1 className="text-3xl font-merge-display font-bold">Incomplete transactions</h1>
          <p className="text-muted-foreground">Connect the wallet you used to see any mint or redemption that did not finish.</p>
          <Button className="rounded-full h-12 px-10 text-base" onClick={() => setWalletModalOpen(true)}>
            Connect Wallet
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="container mx-auto px-4 py-10 max-w-3xl space-y-6">
      <div className="space-y-2">
        <h1 className="text-3xl font-merge-display font-bold">Incomplete transactions</h1>
        <p className="text-muted-foreground">
          Large Reserves mint and redeem in several steps. If one step fails after another went through, the assets in between stay in your wallet. Here you can see what happened and convert them back to USDC.
        </p>
      </div>

      {loadError && (
        <Card className="border-destructive/40">
          <CardContent className="pt-6 flex items-start gap-2 text-sm">
            <AlertCircle className="w-4 h-4 text-destructive shrink-0 mt-0.5" />
            <span>
              {loadError}{" "}
              <button className="underline" onClick={() => void load()}>
                Try again
              </button>
            </span>
          </CardContent>
        </Card>
      )}

      {items === null && !loadError && (
        <div className="flex items-center gap-2 text-muted-foreground">
          <Loader2 className="w-4 h-4 animate-spin" /> Checking your wallet on Solana...
        </div>
      )}

      {items !== null && items.length === 0 && (
        <Card>
          <CardContent className="pt-6 flex items-center gap-2">
            <CheckCircle2 className="w-5 h-5 text-primary" />
            <span>Nothing to finish. Every mint and redemption from this browser completed.</span>
          </CardContent>
        </Card>
      )}

      {items?.map((item) => {
        const key = `${item.kind}:${item.reserve}`;
        const dtr = reserveByAddress.get(item.reserve);
        const name = dtr ? `${dtr.name} (${dtr.ticker})` : short(item.reserve);
        const busy = busyKey === key;
        const totalUsd = item.leftovers.reduce((s, l) => {
          const p = prices[l.mint]?.usdPrice;
          return p == null ? s : s + (Number(l.amountRaw) / 10 ** l.decimals) * p;
        }, 0);
        return (
          <Card key={key}>
            <CardHeader>
              <CardTitle className="text-lg">
                {item.kind === "redeem" ? "Redemption" : "Mint"} of {name} did not finish
              </CardTitle>
              <CardDescription>
                Started {new Date(item.startedAt).toLocaleString()}.{" "}
                {item.kind === "redeem"
                  ? "Your Reserve Tokens were redeemed, but not every asset was swapped into USDC."
                  : "Your USDC was swapped into some of the Reserve's assets, but the Reserve Tokens were not minted."}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4 text-sm">
              {item.events.length > 0 && (
                <div className="space-y-1">
                  <p className="font-semibold">What went through</p>
                  {item.events.map((e) => (
                    <a key={e.signature} href={explorerUrl("tx", e.signature)} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-muted-foreground hover:underline">
                      <CheckCircle2 className="w-3.5 h-3.5 text-primary" /> {e.label} <span className="font-merge-mono">{short(e.signature)}</span> <ExternalLink className="w-3 h-3" />
                    </a>
                  ))}
                </div>
              )}
              <div className="space-y-1">
                <p className="font-semibold">Still in your wallet from this transaction</p>
                {item.leftovers.map((l) => {
                  const p = prices[l.mint]?.usdPrice;
                  return (
                    <div key={l.mint} className="flex justify-between">
                      <span>{symbolOf(l.mint)}</span>
                      <span className="font-merge-mono">
                        {formatRaw(l.amountRaw, l.decimals)}
                        {p != null && <span className="text-muted-foreground"> (~${((Number(l.amountRaw) / 10 ** l.decimals) * p).toFixed(2)})</span>}
                      </span>
                    </div>
                  );
                })}
              </div>
              {itemError[key] && (
                <p className="flex items-start gap-1 text-destructive">
                  <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" /> {itemError[key]}
                </p>
              )}
            </CardContent>
            <CardFooter className="flex flex-wrap justify-between gap-2 border-t border-border/40 pt-6">
              {dtr ? (
                <Link href={`/dtr/${dtr.id}`} className="text-sm text-muted-foreground hover:underline">
                  Open the Reserve
                </Link>
              ) : (
                <span />
              )}
              <Button onClick={() => void handleConvert(item)} disabled={busyKey !== null}>
                {busy ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin mr-2" /> {describeProgress(progress)}
                  </>
                ) : (
                  `Convert to USDC${totalUsd > 0 ? ` (~$${totalUsd.toFixed(2)})` : ""}`
                )}
              </Button>
            </CardFooter>
          </Card>
        );
      })}
    </div>
  );
}
