import { useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { DEVNET_FIXTURES } from "@ssr/sdk";
import { useAppStore } from "@/store/useAppStore";
import {
  calcHoldingValue,
  calcUnrealizedPnl,
  calcUnrealizedPnlPct,
  calcPortfolioValue,
  calcCostBasis,
  calc24hPnl,
  formatUsdc,
  formatPercent,
} from "@/lib/calculations";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Link } from "wouter";
import { Wallet, PieChart, ArrowUpRight, ArrowDownRight, Search, Activity } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { DevnetOnboarding } from "../components/DevnetOnboarding";

/** Categorical swatch cycled across allocation rows -- same palette as the native charts. */
const ALLOCATION_COLORS = ["var(--s1)", "var(--s2)", "var(--s3)", "var(--s4)", "var(--s5)", "var(--s6)", "var(--s7)", "var(--s8)"];

function PnlText({ value, pct, className = "" }: { value: number; pct?: number; className?: string }) {
  const isProfit = value >= 0;
  return (
    <span className={`inline-flex items-center gap-1 font-merge-mono ${isProfit ? "text-positive" : "text-destructive"} ${className}`}>
      {isProfit ? <ArrowUpRight className="w-3.5 h-3.5" /> : <ArrowDownRight className="w-3.5 h-3.5" />}
      {formatUsdc(Math.abs(value))}
      {pct !== undefined && <span className="opacity-80">({formatPercent(pct)})</span>}
    </span>
  );
}

export function Portfolio() {
  const { wallet, holdings, dtrs } = useAppStore();
  const { publicKey } = useWallet();
  const { toast } = useToast();
  const [isFaucetLoading, setIsFaucetLoading] = useState(false);

  const isConnected = wallet.connected;

  async function handleGetTestAssets() {
    if (!publicKey) return;
    setIsFaucetLoading(true);
    try {
      const mints = Object.values(DEVNET_FIXTURES.mints);
      const res = await fetch("/api/devnet/mint-test-assets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userPubkey: publicKey.toBase58(),
          mints: mints.map((m) => ({ mint: m.address, rawAmount: String(10 * 10 ** m.decimals) })),
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed to get DevNet test assets.");
      toast({ title: "Received DevNet test assets", description: "10 of each SSR DevNet test asset (mockX/Y/Z) were minted to your wallet." });
    } catch (e) {
      toast({ variant: "destructive", title: "Faucet Failed", description: e instanceof Error ? e.message : "Failed to get DevNet test assets." });
    } finally {
      setIsFaucetLoading(false);
    }
  }

  if (!isConnected) {
    return (
      <div className="container mx-auto px-4 py-24 flex flex-col items-center justify-center min-h-[70vh]">
        <div className="w-20 h-20 bg-muted rounded-full flex items-center justify-center mb-6">
          <Wallet className="w-10 h-10 text-muted-foreground" />
        </div>
        <h1 className="text-3xl font-merge-display font-bold mb-4">Wallet Not Connected</h1>
        <p className="text-muted-foreground text-center max-w-md mb-8">
          Connect a wallet to view your SSR.FUN portfolio, simulated balances, and Reserve Token holdings.
        </p>
        {/* We can't trigger the modal directly from here without a global state for the modal,
            so we'll just encourage them to use the nav button */}
        <p className="text-sm font-medium px-4 py-2 bg-primary/10 text-primary rounded-md">
          Use the Connect Wallet button in the navigation bar.
        </p>
      </div>
    );
  }

  const portfolioValue = calcPortfolioValue(wallet, holdings, dtrs);
  const totalDtrValue = holdings.reduce((sum, h) => {
    const dtr = dtrs.find((d) => d.id === h.dtrId);
    return sum + calcHoldingValue(h, dtr);
  }, 0);
  const totalWalletValue = portfolioValue - totalDtrValue;

  const totalCostBasis = holdings.reduce((sum, h) => sum + calcCostBasis(h), 0);
  const totalUnrealizedPnl = holdings.reduce((sum, h) => sum + calcUnrealizedPnl(h, dtrs.find((d) => d.id === h.dtrId)), 0);
  const totalUnrealizedPnlPct = totalCostBasis > 0 ? (totalUnrealizedPnl / totalCostBasis) * 100 : 0;

  const total24hPnl = holdings.reduce((sum, h) => sum + calc24hPnl(h, dtrs.find((d) => d.id === h.dtrId)), 0);
  const prev24hValue = totalDtrValue - total24hPnl;
  const total24hPnlPct = prev24hValue > 0 ? (total24hPnl / prev24hValue) * 100 : 0;

  const allocation = holdings
    .map((h) => {
      const dtr = dtrs.find((d) => d.id === h.dtrId);
      return { dtr, value: calcHoldingValue(h, dtr) };
    })
    .filter((a): a is { dtr: NonNullable<typeof a.dtr>; value: number } => Boolean(a.dtr))
    .sort((a, b) => b.value - a.value);

  const recentActivity = dtrs
    .flatMap((d) => d.trades.map((t) => ({ ...t, dtr: d })))
    .sort((a, b) => b.t - a.t)
    .slice(0, 8);

  return (
    <div className="container mx-auto px-4 md:px-8 py-10">
      <div className="flex items-center gap-3 mb-8">
        <PieChart className="w-8 h-8 text-primary" />
        <h1 className="text-4xl font-merge-display font-bold tracking-tight">Portfolio</h1>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
        <Card className="bg-card/40 border-border/50 col-span-1 md:col-span-3 lg:col-span-1">
          <CardHeader className="pb-2">
            <CardDescription className="text-sm">Total Net Value</CardDescription>
            <CardTitle className="text-4xl font-merge-mono">{formatUsdc(portfolioValue)}</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="mt-4 pt-4 border-t border-border/30 grid grid-cols-2 gap-4">
              <div>
                <p className="text-xs text-muted-foreground mb-1">Total P&L</p>
                {holdings.length > 0 ? (
                  <PnlText value={totalUnrealizedPnl} pct={totalUnrealizedPnlPct} className="text-base font-semibold" />
                ) : (
                  <p className="font-merge-mono text-muted-foreground">—</p>
                )}
              </div>
              <div>
                <p className="text-xs text-muted-foreground mb-1">24h P&L</p>
                {holdings.length > 0 ? (
                  <PnlText value={total24hPnl} pct={total24hPnlPct} className="text-base font-semibold" />
                ) : (
                  <p className="font-merge-mono text-muted-foreground">—</p>
                )}
              </div>
            </div>
            <div className="mt-4 pt-4 border-t border-border/30 grid grid-cols-2 gap-4">
              <div>
                <p className="text-xs text-muted-foreground mb-1">Wallet Assets</p>
                <p className="font-merge-mono text-lg">{formatUsdc(totalWalletValue)}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground mb-1">Reserve Holdings</p>
                <p className="font-merge-mono text-lg">{formatUsdc(totalDtrValue)}</p>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="bg-card/40 border-border/50 col-span-1 md:col-span-3 lg:col-span-2">
          <CardHeader className="pb-4 flex-row items-center justify-between space-y-0">
            <CardTitle className="text-lg">Wallet Balances</CardTitle>
            <Button size="sm" variant="outline" onClick={handleGetTestAssets} disabled={isFaucetLoading}>
              {isFaucetLoading ? "Requesting..." : "Get DevNet Test Assets"}
            </Button>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="p-4 bg-muted/30 rounded-lg border border-border/50 flex flex-col justify-center">
                <div className="flex items-center gap-2 mb-2">
                  <div className="w-6 h-6 rounded-full bg-purple-500/20 text-purple-500 flex items-center justify-center text-xs font-bold">
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
                      <path d="M4 17.5l14-3.5 2.5 3.5-14 3.5zm2.5-11L20.5 3l-2.5-3.5L4 3zM4 10.5l14-3.5 2.5 3.5-14 3.5z"/>
                    </svg>
                  </div>
                  <span className="font-semibold">SOL</span>
                </div>
                <div className="font-merge-mono text-xl">{wallet.sol.toLocaleString(undefined, { maximumFractionDigits: 4 })}</div>
                <p className="text-xs text-muted-foreground mt-1">Real balance, read from Solana DevNet</p>
              </div>

              <div className="p-4 bg-muted/30 rounded-lg border border-border/50 flex flex-col justify-center">
                <div className="flex items-center gap-2 mb-2">
                  <div className="w-6 h-6 rounded-full bg-muted text-muted-foreground flex items-center justify-center text-xs font-bold">X</div>
                  <span className="font-semibold">mockX / mockY / mockZ</span>
                </div>
                <p className="text-xs text-muted-foreground mt-1">SSR DevNet test assets -- claimed via "Get DevNet Test Assets" above. See devUSDC below for the default settlement asset.</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      <DevnetOnboarding />

      {allocation.length > 0 && (
        <Card className="bg-card/40 border-border/50 mb-8">
          <CardHeader className="pb-4">
            <CardTitle className="text-lg">Allocation by Reserve</CardTitle>
            <CardDescription>Share of your Reserve Token holdings, by current value.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex h-2.5 rounded-full overflow-hidden mb-5 bg-muted/40">
              {allocation.map((a, i) => (
                <div
                  key={a.dtr.id}
                  style={{ width: `${(a.value / totalDtrValue) * 100}%`, background: ALLOCATION_COLORS[i % ALLOCATION_COLORS.length] }}
                  title={`${a.dtr.ticker} ${((a.value / totalDtrValue) * 100).toFixed(1)}%`}
                />
              ))}
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-6 gap-y-3">
              {allocation.map((a, i) => (
                <div key={a.dtr.id} className="flex items-center gap-2.5 text-sm min-w-0">
                  <span className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ background: ALLOCATION_COLORS[i % ALLOCATION_COLORS.length] }} />
                  <span className="truncate font-medium">{a.dtr.name}</span>
                  <span className="font-merge-mono text-muted-foreground text-xs shrink-0">{a.dtr.ticker}</span>
                  <span className="font-merge-mono ml-auto shrink-0">{((a.value / totalDtrValue) * 100).toFixed(1)}%</span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      <div className="space-y-6 mb-8">
        <h2 className="text-2xl font-merge-display font-bold">Reserve Holdings</h2>

        {holdings.length === 0 ? (
          <Card className="border-dashed border-border/60 bg-transparent">
            <CardContent className="py-16 flex flex-col items-center justify-center text-center">
              <div className="w-16 h-16 bg-muted/50 rounded-full flex items-center justify-center mb-4">
                <Search className="w-8 h-8 text-muted-foreground" />
              </div>
              <h3 className="text-xl font-semibold mb-2">No Reserves Yet</h3>
              <p className="text-muted-foreground max-w-md mb-6">
                Your portfolio is empty. Explore available Reserves and start building your position.
              </p>
              <Button asChild>
                <Link href="/">Explore Reserves</Link>
              </Button>
            </CardContent>
          </Card>
        ) : (
          <Card className="bg-card/40 border-border/50 overflow-hidden">
            <div className="overflow-x-auto">
              <Table>
                <TableHeader className="bg-muted/30">
                  <TableRow className="border-border/50">
                    <TableHead className="py-4">Asset</TableHead>
                    <TableHead className="text-right">Balance</TableHead>
                    <TableHead className="text-right">Avg Entry</TableHead>
                    <TableHead className="text-right">Price / NAV</TableHead>
                    <TableHead className="text-right">Cost Basis</TableHead>
                    <TableHead className="text-right">Value</TableHead>
                    <TableHead className="text-right">Unrealized P&L</TableHead>
                    <TableHead className="text-right">Action</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {holdings.map((holding) => {
                    const dtr = dtrs.find((d) => d.id === holding.dtrId);
                    if (!dtr) return null;

                    const currentValue = calcHoldingValue(holding, dtr);
                    const costBasis = calcCostBasis(holding);
                    const pnl = calcUnrealizedPnl(holding, dtr);
                    const pnlPct = calcUnrealizedPnlPct(holding, dtr);

                    return (
                      <TableRow key={holding.dtrId} className="border-border/50 hover:bg-muted/20">
                        <TableCell className="py-4">
                          <Link href={`/dtr/${dtr.id}`} className="flex items-center gap-3 group cursor-pointer">
                            <Avatar className="h-8 w-8 border border-border group-hover:border-primary transition-colors">
                              {dtr.logoUrl && <AvatarImage src={dtr.logoUrl} alt={dtr.ticker} />}
                              <AvatarFallback className="bg-primary/10 text-primary text-xs font-bold">
                                {dtr.ticker.slice(0, 2)}
                              </AvatarFallback>
                            </Avatar>
                            <div>
                              <p className="font-semibold text-foreground group-hover:text-primary transition-colors">{dtr.name}</p>
                              <div className="flex items-center gap-1 mt-0.5">
                                <Badge variant="secondary" className="font-merge-mono text-[10px] px-1 py-0 h-4">{dtr.ticker}</Badge>
                                <Badge
                                  variant={dtr.onChain ? "default" : "outline"}
                                  className="text-[9px] px-1 py-0 h-4 uppercase tracking-wide"
                                >
                                  {dtr.onChain ? "DevNet" : "Simulated"}
                                </Badge>
                              </div>
                            </div>
                          </Link>
                        </TableCell>
                        <TableCell className="text-right font-merge-mono">
                          {holding.tokenBalance.toLocaleString(undefined, { maximumFractionDigits: 4 })}
                        </TableCell>
                        <TableCell className="text-right font-merge-mono text-muted-foreground">
                          {formatUsdc(holding.avgPurchasePrice)}
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="font-merge-mono">{formatUsdc(dtr.tokenPrice)}</div>
                          <div className="font-merge-mono text-xs text-muted-foreground">NAV {formatUsdc(dtr.nav)}</div>
                        </TableCell>
                        <TableCell className="text-right font-merge-mono text-muted-foreground">
                          {formatUsdc(costBasis)}
                        </TableCell>
                        <TableCell className="text-right font-merge-mono font-semibold">
                          {formatUsdc(currentValue)}
                        </TableCell>
                        <TableCell className="text-right">
                          <PnlText value={pnl} pct={pnlPct} className="justify-end" />
                        </TableCell>
                        <TableCell className="text-right">
                          <Button asChild size="sm" variant="secondary" className="font-semibold">
                            <Link href={`/dtr/${dtr.id}`}>Trade</Link>
                          </Button>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          </Card>
        )}
      </div>

      <div className="space-y-6">
        <div className="flex items-center gap-2">
          <Activity className="w-5 h-5 text-primary" />
          <h2 className="text-2xl font-merge-display font-bold">Recent Activity</h2>
        </div>
        <Card className="bg-card/40 border-border/50">
          {recentActivity.length === 0 ? (
            <CardContent className="py-10 text-center text-muted-foreground text-sm">
              No trades yet this session. Buy or sell a Reserve Token to see activity here.
            </CardContent>
          ) : (
            <div className="divide-y divide-border/50">
              {recentActivity.map((trade) => (
                <div key={trade.id} className="flex items-center justify-between gap-4 px-5 py-3.5">
                  <div className="flex items-center gap-3 min-w-0">
                    <span className={`text-xs font-semibold font-merge-mono px-2 py-1 rounded ${trade.side === "buy" ? "bg-positive/15 text-positive" : "bg-destructive/15 text-destructive"}`}>
                      {trade.side === "buy" ? "BUY" : "SELL"}
                    </span>
                    <div className="min-w-0">
                      <p className="font-medium truncate">{trade.dtr.name} <span className="text-muted-foreground font-merge-mono text-xs">{trade.dtr.ticker}</span></p>
                      <p className="text-xs text-muted-foreground">{new Date(trade.t).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</p>
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    <p className="font-merge-mono font-medium">{formatUsdc(trade.usdcAmount)}</p>
                    <p className="text-xs text-muted-foreground font-merge-mono">{trade.tokenAmount.toFixed(4)} {trade.dtr.ticker} @ {formatUsdc(trade.price)}</p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
