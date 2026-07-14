import { useAppStore } from "@/store/useAppStore";
import { calcHoldingValue, calcUnrealizedPnl, calcUnrealizedPnlPct, calcPortfolioValue, formatUsdc, formatPercent, SSR_PRICE_USDC, SOL_PRICE_USDC } from "@/lib/calculations";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Link } from "wouter";
import { Wallet, PieChart, ArrowUpRight, ArrowDownRight, ArrowRightLeft, Search } from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";

export function Portfolio() {
  const { wallet, holdings, dtrs } = useAppStore();

  const isConnected = wallet.connected;
  
  if (!isConnected) {
    return (
      <div className="container mx-auto px-4 py-24 flex flex-col items-center justify-center min-h-[70vh]">
        <div className="w-20 h-20 bg-muted rounded-full flex items-center justify-center mb-6">
          <Wallet className="w-10 h-10 text-muted-foreground" />
        </div>
        <h1 className="text-3xl font-display font-bold mb-4">Wallet Not Connected</h1>
        <p className="text-muted-foreground text-center max-w-md mb-8">
          Connect a wallet to view your SSR.FUN portfolio, simulated balances, and DTR Token holdings.
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

  return (
    <div className="container mx-auto px-4 md:px-8 py-10">
      <div className="flex items-center gap-3 mb-8">
        <PieChart className="w-8 h-8 text-primary" />
        <h1 className="text-4xl font-display font-bold tracking-tight">Portfolio</h1>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-12">
        <Card className="bg-card/40 border-border/50 col-span-1 md:col-span-3 lg:col-span-1">
          <CardHeader className="pb-2">
            <CardDescription className="text-sm">Total Net Value</CardDescription>
            <CardTitle className="text-4xl font-mono">{formatUsdc(portfolioValue)}</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="mt-4 pt-4 border-t border-border/30 grid grid-cols-2 gap-4">
              <div>
                <p className="text-xs text-muted-foreground mb-1">Wallet Assets</p>
                <p className="font-mono text-lg">{formatUsdc(totalWalletValue)}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground mb-1">DTR Holdings</p>
                <p className="font-mono text-lg">{formatUsdc(totalDtrValue)}</p>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="bg-card/40 border-border/50 col-span-1 md:col-span-3 lg:col-span-2">
          <CardHeader className="pb-4">
            <CardTitle className="text-lg">Wallet Balances</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div className="p-4 bg-muted/30 rounded-lg border border-border/50 flex flex-col justify-center">
                <div className="flex items-center gap-2 mb-2">
                  <div className="w-6 h-6 rounded-full bg-blue-500/20 text-blue-500 flex items-center justify-center text-xs font-bold">U</div>
                  <span className="font-semibold">USDC</span>
                </div>
                <div className="font-mono text-xl">{formatUsdc(wallet.usdc)}</div>
                <p className="text-xs text-muted-foreground mt-1">Available for trading</p>
              </div>
              
              <div className="p-4 bg-muted/30 rounded-lg border border-border/50 flex flex-col justify-center">
                <div className="flex items-center gap-2 mb-2">
                  <div className="w-6 h-6 rounded-full bg-purple-500/20 text-purple-500 flex items-center justify-center text-xs font-bold">
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
                      <path d="M4 17.5l14-3.5 2.5 3.5-14 3.5zm2.5-11L20.5 3l-2.5-3.5L4 3zM4 10.5l14-3.5 2.5 3.5-14 3.5z"/>
                    </svg>
                  </div>
                  <span className="font-semibold">SOL</span>
                </div>
                <div className="font-mono text-xl">{wallet.sol.toLocaleString(undefined, { maximumFractionDigits: 4 })}</div>
                <p className="text-xs text-muted-foreground mt-1">{formatUsdc(wallet.sol * SOL_PRICE_USDC)}</p>
              </div>

              <div className="p-4 bg-muted/30 rounded-lg border border-border/50 flex flex-col justify-center">
                <div className="flex items-center gap-2 mb-2">
                  <div className="w-6 h-6 rounded-full bg-primary/20 text-primary border border-primary flex items-center justify-center text-[10px] font-bold">S</div>
                  <span className="font-semibold">SSR</span>
                </div>
                <div className="font-mono text-xl">{wallet.ssr.toLocaleString()}</div>
                <p className="text-xs text-muted-foreground mt-1">{formatUsdc(wallet.ssr * SSR_PRICE_USDC)}</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="space-y-6">
        <h2 className="text-2xl font-display font-bold">DTR Holdings</h2>
        
        {holdings.length === 0 ? (
          <Card className="border-dashed border-border/60 bg-transparent">
            <CardContent className="py-16 flex flex-col items-center justify-center text-center">
              <div className="w-16 h-16 bg-muted/50 rounded-full flex items-center justify-center mb-4">
                <Search className="w-8 h-8 text-muted-foreground" />
              </div>
              <h3 className="text-xl font-semibold mb-2">No Reserves Yet</h3>
              <p className="text-muted-foreground max-w-md mb-6">
                Your portfolio is empty. Explore available DTRs and start building your position.
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
                    <TableHead className="text-right">Avg Price</TableHead>
                    <TableHead className="text-right">Current Price</TableHead>
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
                    const pnl = calcUnrealizedPnl(holding, dtr);
                    const pnlPct = calcUnrealizedPnlPct(holding, dtr);
                    const isProfit = pnl >= 0;

                    return (
                      <TableRow key={holding.dtrId} className="border-border/50 hover:bg-muted/20">
                        <TableCell className="py-4">
                          <Link href={`/dtr/${dtr.id}`} className="flex items-center gap-3 group cursor-pointer">
                            <Avatar className="h-8 w-8 border border-border group-hover:border-primary transition-colors">
                              <AvatarFallback className="bg-primary/10 text-primary text-xs font-bold">
                                {dtr.ticker.slice(0, 2)}
                              </AvatarFallback>
                            </Avatar>
                            <div>
                              <p className="font-semibold text-foreground group-hover:text-primary transition-colors">{dtr.name}</p>
                              <Badge variant="secondary" className="font-mono text-[10px] px-1 py-0 h-4 mt-0.5">{dtr.ticker}</Badge>
                            </div>
                          </Link>
                        </TableCell>
                        <TableCell className="text-right font-mono">
                          {holding.tokenBalance.toLocaleString(undefined, { maximumFractionDigits: 4 })}
                        </TableCell>
                        <TableCell className="text-right font-mono text-muted-foreground">
                          {formatUsdc(holding.avgPurchasePrice)}
                        </TableCell>
                        <TableCell className="text-right font-mono">
                          {formatUsdc(dtr.tokenPrice)}
                        </TableCell>
                        <TableCell className="text-right font-mono font-semibold">
                          {formatUsdc(currentValue)}
                        </TableCell>
                        <TableCell className="text-right">
                          <div className={`flex flex-col items-end ${isProfit ? 'text-primary' : 'text-destructive'}`}>
                            <span className="font-mono font-medium">
                              {isProfit ? '+' : ''}{formatUsdc(pnl)}
                            </span>
                            <span className="font-mono text-xs flex items-center">
                              {isProfit ? <ArrowUpRight className="w-3 h-3 mr-0.5" /> : <ArrowDownRight className="w-3 h-3 mr-0.5" />}
                              {Math.abs(pnlPct).toFixed(2)}%
                            </span>
                          </div>
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
    </div>
  );
}
