import { useState } from "react";
import { useParams, Link } from "wouter";
import { useAppStore, isManagerOrDelegate } from "@/store/useAppStore";
import { 
  calcTokensReceived, 
  calcUsdcReceived, 
  formatUsdc, 
  formatPercent, 
  formatTokenAmount,
  TRADING_FEE_RATE
} from "@/lib/calculations";
import { 
  ResponsiveContainer, 
  LineChart, 
  Line, 
  XAxis, 
  YAxis, 
  Tooltip as RechartsTooltip,
  PieChart as RechartsPieChart,
  Pie,
  Cell
} from "recharts";
import { format } from "date-fns";
import { ChevronLeft, Info, ArrowUpRight, ArrowDownRight, Layers, BarChart3, Activity } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription, CardFooter } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useToast } from "@/hooks/use-toast";

const CHART_COLORS = [
  "hsl(var(--chart-1))",
  "hsl(var(--chart-2))",
  "hsl(var(--chart-3))",
  "hsl(var(--chart-4))",
  "hsl(var(--chart-5))",
];

export function DTRDetail() {
  const { dtrId } = useParams();
  const { wallet, holdings, dtrs, buyDTRToken, sellDTRToken } = useAppStore();
  const dtr = dtrs.find((d) => d.id === (dtrId || ""));
  const { toast } = useToast();
  
  const [priceRange, setPriceRange] = useState<"24H" | "7D" | "30D" | "All">("7D");
  
  // Trading state
  const [tradeTab, setTradeTab] = useState<"buy" | "sell">("buy");
  const [buyAmount, setBuyAmount] = useState("");
  const [sellAmount, setSellAmount] = useState("");
  const [isProcessing, setIsProcessing] = useState(false);

  if (!dtr) {
    return (
      <div className="container mx-auto px-4 py-24 text-center">
        <h1 className="text-3xl font-display font-bold mb-4">Reserve Not Found</h1>
        <p className="text-muted-foreground mb-8">The requested DTR does not exist or has been removed.</p>
        <Button asChild>
          <Link href="/">Return Home</Link>
        </Button>
      </div>
    );
  }

  const holding = holdings.find((h) => h.dtrId === dtr.id);
  const premiumDiscount = (dtr.tokenPrice - dtr.nav) / dtr.nav;
  const isPremium = premiumDiscount > 0;

  // Chart data formatting
  const chartData = dtr.priceHistory[priceRange].map(p => ({
    ...p,
    dateStr: priceRange === "24H" || priceRange === "7D" 
      ? format(new Date(p.t), "MMM d, HH:mm")
      : format(new Date(p.t), "MMM d, yyyy")
  }));

  const chartMin = Math.min(...chartData.map(d => d.price));
  const chartMax = Math.max(...chartData.map(d => d.price));
  const yDomain = [chartMin * 0.95, chartMax * 1.05];

  // Pie chart data
  const pieData = dtr.composition.map(a => ({
    name: a.symbol,
    value: a.weight
  }));

  // Trading Calculations
  const numBuyAmount = parseFloat(buyAmount) || 0;
  const buyQuote = calcTokensReceived(numBuyAmount, dtr.tokenPrice, dtr.liquidityUsdc);
  
  const numSellAmount = parseFloat(sellAmount) || 0;
  const sellQuote = calcUsdcReceived(numSellAmount, dtr.tokenPrice, dtr.liquidityUsdc);

  const handleBuy = async () => {
    setIsProcessing(true);
    // Fake processing delay
    await new Promise(r => setTimeout(r, 600));
    
    const res = buyDTRToken(dtr.id, numBuyAmount);
    setIsProcessing(false);
    
    if (res.success) {
      toast({
        title: "Order Executed",
        description: res.message,
      });
      setBuyAmount("");
    } else {
      toast({
        variant: "destructive",
        title: "Transaction Failed",
        description: res.message,
      });
    }
  };

  const handleSell = async () => {
    setIsProcessing(true);
    await new Promise(r => setTimeout(r, 600));
    
    const res = sellDTRToken(dtr.id, numSellAmount);
    setIsProcessing(false);
    
    if (res.success) {
      toast({
        title: "Order Executed",
        description: res.message,
      });
      setSellAmount("");
    } else {
      toast({
        variant: "destructive",
        title: "Transaction Failed",
        description: res.message,
      });
    }
  };

  const setBuyPct = (pct: number) => {
    if (wallet.connected) {
      setBuyAmount((wallet.usdc * pct).toString());
    }
  };

  const setSellPct = (pct: number) => {
    if (wallet.connected && holding) {
      setSellAmount((holding.tokenBalance * pct).toString());
    }
  };

  return (
    <div className="container mx-auto px-4 md:px-8 py-8">
      <Link href="/" className="inline-flex items-center text-sm text-muted-foreground hover:text-primary mb-6 transition-colors">
        <ChevronLeft className="w-4 h-4 mr-1" /> Back to Directory
      </Link>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        {/* Left Column: Details & Charts */}
        <div className="lg:col-span-2 space-y-8">
          
          {/* Header Section */}
          <div className="flex flex-col md:flex-row md:items-start justify-between gap-6">
            <div className="flex items-start gap-5">
              <Avatar className="h-20 w-20 border-2 border-border shadow-md">
                {dtr.logoUrl && <AvatarImage src={dtr.logoUrl} alt={dtr.ticker} />}
                <AvatarFallback className="bg-primary/10 text-primary text-2xl font-display font-bold">
                  {dtr.ticker.slice(0, 2)}
                </AvatarFallback>
              </Avatar>
              <div>
                <div className="flex items-center gap-3 mb-1">
                  <h1 className="text-4xl font-display font-bold tracking-tight">{dtr.name}</h1>
                  <Badge variant="secondary" className="font-mono text-sm">{dtr.ticker}</Badge>
                </div>
                <div className="flex items-center gap-3 text-sm text-muted-foreground mb-4">
                  <Badge variant="outline" className="bg-background/50 border-border">{dtr.category}</Badge>
                  <span>{dtr.holders.toLocaleString()} Holders</span>
                </div>
                <p className="text-muted-foreground max-w-xl leading-relaxed">
                  {dtr.description}
                </p>
              </div>
            </div>
            
            <div className="flex flex-col items-end gap-3 shrink-0">
              <div className="bg-card/40 border border-border/50 rounded-xl p-4 min-w-[200px]">
                <p className="text-xs text-muted-foreground mb-1 uppercase tracking-wider font-semibold">Token Price</p>
                <div className="flex items-baseline gap-2 mb-1">
                  <span className="text-3xl font-mono font-bold text-foreground">{formatUsdc(dtr.tokenPrice)}</span>
                </div>
                <p className={`text-sm font-mono flex items-center ${dtr.change24h >= 0 ? 'text-positive' : 'text-destructive'}`}>
                  {dtr.change24h >= 0 ? <ArrowUpRight className="w-4 h-4 mr-0.5" /> : <ArrowDownRight className="w-4 h-4 mr-0.5" />}
                  {Math.abs(dtr.change24h).toFixed(2)}% <span className="text-muted-foreground ml-1">(24h)</span>
                </p>
              </div>
              
              {isManagerOrDelegate(dtr, wallet.address) && (
                <Button asChild variant="outline" className="w-full border-primary/50 text-primary hover:bg-primary/10">
                  <Link href={`/dtr/${dtr.id}/manage`}>Manage Reserve</Link>
                </Button>
              )}
            </div>
          </div>

          {/* Stats Grid */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <Card className="bg-card/30 border-border/50 shadow-none">
              <CardContent className="p-4">
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-2">
                  AUM
                  <Tooltip>
                    <TooltipTrigger><Info className="w-3 h-3" /></TooltipTrigger>
                    <TooltipContent>Assets Under Management (Total value of underlying assets)</TooltipContent>
                  </Tooltip>
                </div>
                <p className="text-xl font-mono font-semibold">{formatUsdc(dtr.aum, { compact: true })}</p>
              </CardContent>
            </Card>
            <Card className="bg-card/30 border-border/50 shadow-none">
              <CardContent className="p-4">
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-2">
                  NAV per Token
                  <Tooltip>
                    <TooltipTrigger><Info className="w-3 h-3" /></TooltipTrigger>
                    <TooltipContent>Net Asset Value: The underlying value backing each token.</TooltipContent>
                  </Tooltip>
                </div>
                <p className="text-xl font-mono font-semibold">{formatUsdc(dtr.nav)}</p>
              </CardContent>
            </Card>
            <Card className="bg-card/30 border-border/50 shadow-none">
              <CardContent className="p-4">
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-2">
                  Prem/Discount
                  <Tooltip>
                    <TooltipTrigger><Info className="w-3 h-3" /></TooltipTrigger>
                    <TooltipContent>Difference between market price and NAV. Premium implies high demand.</TooltipContent>
                  </Tooltip>
                </div>
                <p className={`text-xl font-mono font-semibold ${isPremium ? 'text-positive' : 'text-destructive'}`}>
                  {isPremium ? '+' : ''}{(premiumDiscount * 100).toFixed(2)}%
                </p>
              </CardContent>
            </Card>
            <Card className="bg-card/30 border-border/50 shadow-none">
              <CardContent className="p-4">
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-2">
                  7D Performance
                </div>
                <p className={`text-xl font-mono font-semibold ${dtr.change7d >= 0 ? 'text-positive' : 'text-destructive'}`}>
                  {dtr.change7d >= 0 ? '+' : ''}{dtr.change7d.toFixed(2)}%
                </p>
              </CardContent>
            </Card>
          </div>

          {/* Chart Section */}
          <Card className="bg-card/30 border-border/50">
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-lg font-display flex items-center gap-2">
                <Activity className="w-5 h-5 text-primary" /> Price History
              </CardTitle>
              <div className="flex bg-muted/50 p-1 rounded-md">
                {(["24H", "7D", "30D", "All"] as const).map((range) => (
                  <button
                    key={range}
                    onClick={() => setPriceRange(range)}
                    className={`px-3 py-1 text-xs font-medium rounded-sm transition-colors ${
                      priceRange === range 
                        ? 'bg-background text-foreground shadow-sm' 
                        : 'text-muted-foreground hover:text-foreground hover:bg-muted'
                    }`}
                  >
                    {range}
                  </button>
                ))}
              </div>
            </CardHeader>
            <CardContent className="p-0 sm:p-6 sm:pt-0 h-[350px] w-full">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={chartData} margin={{ top: 20, right: 20, bottom: 20, left: 20 }}>
                  <XAxis 
                    dataKey="dateStr" 
                    stroke="hsl(var(--muted-foreground))" 
                    fontSize={12} 
                    tickLine={false} 
                    axisLine={false}
                    minTickGap={30}
                  />
                  <YAxis 
                    domain={yDomain} 
                    stroke="hsl(var(--muted-foreground))" 
                    fontSize={12} 
                    tickLine={false} 
                    axisLine={false}
                    tickFormatter={(value) => `$${value.toFixed(2)}`}
                    width={60}
                  />
                  <RechartsTooltip 
                    contentStyle={{ backgroundColor: 'hsl(var(--card))', borderColor: 'hsl(var(--border))', borderRadius: '0.5rem', color: 'hsl(var(--foreground))' }}
                    itemStyle={{ color: 'hsl(var(--primary))', fontWeight: 'bold' }}
                    labelStyle={{ color: 'hsl(var(--muted-foreground))', marginBottom: '4px' }}
                    formatter={(value: number) => [formatUsdc(value), "Price"]}
                  />
                  <Line 
                    type="monotone" 
                    dataKey="price" 
                    stroke="hsl(var(--primary))" 
                    strokeWidth={2}
                    dot={false}
                    activeDot={{ r: 6, fill: "hsl(var(--primary))", stroke: "hsl(var(--background))", strokeWidth: 2 }}
                  />
                </LineChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>

          {/* Composition Section */}
          <Card className="bg-card/30 border-border/50">
            <CardHeader>
              <CardTitle className="text-lg font-display flex items-center gap-2">
                <Layers className="w-5 h-5 text-primary" /> Reserve Composition
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex flex-col md:flex-row gap-8 items-center">
                <div className="w-[200px] h-[200px] shrink-0">
                  <ResponsiveContainer width="100%" height="100%">
                    <RechartsPieChart>
                      <Pie
                        data={pieData}
                        cx="50%"
                        cy="50%"
                        innerRadius={60}
                        outerRadius={80}
                        paddingAngle={2}
                        dataKey="value"
                        stroke="none"
                      >
                        {pieData.map((entry, index) => (
                          <Cell key={`cell-${index}`} fill={CHART_COLORS[index % CHART_COLORS.length]} />
                        ))}
                      </Pie>
                      <RechartsTooltip 
                        formatter={(value: number) => [`${(value * 100).toFixed(1)}%`, "Weight"]}
                        contentStyle={{ backgroundColor: 'hsl(var(--card))', borderColor: 'hsl(var(--border))', borderRadius: '0.5rem', color: 'hsl(var(--foreground))' }}
                        itemStyle={{ color: 'hsl(var(--foreground))', fontWeight: 'bold' }}
                        labelStyle={{ color: 'hsl(var(--foreground))', marginBottom: '4px' }}
                      />
                    </RechartsPieChart>
                  </ResponsiveContainer>
                </div>
                
                <div className="flex-1 w-full overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow className="border-border/50">
                        <TableHead>Asset</TableHead>
                        <TableHead className="text-right">Weight</TableHead>
                        <TableHead className="text-right hidden sm:table-cell">Value in Reserve</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {dtr.composition.map((asset, index) => (
                        <TableRow key={asset.symbol} className="border-border/50">
                          <TableCell className="font-medium">
                            <div className="flex items-center gap-2">
                              <div className="w-3 h-3 rounded-full" style={{ backgroundColor: CHART_COLORS[index % CHART_COLORS.length] }} />
                              {asset.name} <span className="text-muted-foreground font-normal ml-1">{asset.symbol}</span>
                            </div>
                          </TableCell>
                          <TableCell className="text-right font-mono">
                            {(asset.weight * 100).toFixed(2)}%
                          </TableCell>
                          <TableCell className="text-right font-mono text-muted-foreground hidden sm:table-cell">
                            {formatUsdc(asset.weight * dtr.aum, { compact: true })}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Info Table */}
          <Card className="bg-card/30 border-border/50">
             <CardContent className="p-0">
               <Table>
                 <TableBody>
                   <TableRow className="border-border/50">
                     <TableCell className="py-4 text-muted-foreground">Contract Address</TableCell>
                     <TableCell className="text-right font-mono text-xs">{dtr.dtrAddress}</TableCell>
                   </TableRow>
                   <TableRow className="border-border/50">
                     <TableCell className="py-4 text-muted-foreground">Manager Address</TableCell>
                     <TableCell className="text-right font-mono text-xs">{dtr.managerAddress}</TableCell>
                   </TableRow>
                 </TableBody>
               </Table>
             </CardContent>
          </Card>

        </div>

        {/* Right Column: Trading Panel */}
        <div className="lg:col-span-1">
          <div className="sticky top-24">
            <Card className="border-border shadow-xl bg-card">
              <Tabs value={tradeTab} onValueChange={(v) => setTradeTab(v as "buy" | "sell")} className="w-full">
                <CardHeader className="pb-4">
                  <TabsList className="grid w-full grid-cols-2">
                    <TabsTrigger value="buy" className="font-bold data-[state=active]:text-primary">Buy</TabsTrigger>
                    <TabsTrigger value="sell" className="font-bold data-[state=active]:text-destructive">Sell</TabsTrigger>
                  </TabsList>
                </CardHeader>
                
                <CardContent>
                  <TabsContent value="buy" className="mt-0 space-y-4">
                    <div className="flex justify-between items-center text-sm mb-2">
                      <span className="text-muted-foreground">Available</span>
                      <span className="font-mono font-medium">{wallet.connected ? formatUsdc(wallet.usdc) : "—"}</span>
                    </div>

                    <div className="relative">
                      <div className="absolute inset-y-0 right-3 flex items-center pointer-events-none text-muted-foreground font-medium text-sm">
                        USDC
                      </div>
                      <Input 
                        type="number" 
                        placeholder="0.00" 
                        className="h-14 bg-background border-border/60 text-lg font-mono pr-16"
                        value={buyAmount}
                        onChange={(e) => setBuyAmount(e.target.value)}
                        disabled={!wallet.connected || isProcessing}
                      />
                    </div>

                    <div className="grid grid-cols-4 gap-2">
                      {[0.25, 0.5, 0.75, 1].map((pct) => (
                        <Button 
                          key={pct} 
                          variant="outline" 
                          size="sm" 
                          className="bg-muted/30 text-xs h-7 border-border/50"
                          onClick={() => setBuyPct(pct)}
                          disabled={!wallet.connected || isProcessing}
                        >
                          {pct === 1 ? "Max" : `${pct * 100}%`}
                        </Button>
                      ))}
                    </div>

                    <div className="p-4 bg-muted/20 rounded-lg space-y-3 border border-border/40 mt-6">
                      <div className="flex justify-between text-sm">
                        <span className="text-muted-foreground">Price</span>
                        <span className="font-mono">{formatUsdc(dtr.tokenPrice)}</span>
                      </div>
                      <div className="flex justify-between text-sm">
                        <span className="text-muted-foreground">Gross Tokens</span>
                        <span className="font-mono">{formatTokenAmount(buyQuote.grossAmount)} {dtr.ticker}</span>
                      </div>
                      <div className="flex justify-between text-sm">
                        <span className="text-muted-foreground flex items-center gap-1">
                          Trading Fee
                          <Tooltip>
                            <TooltipTrigger><Info className="w-3 h-3" /></TooltipTrigger>
                            <TooltipContent>SSR.FUN protocol fee (0.10%)</TooltipContent>
                          </Tooltip>
                        </span>
                        <span className="font-mono text-destructive">-{formatTokenAmount(buyQuote.fee)} {dtr.ticker}</span>
                      </div>
                      <div className="pt-3 border-t border-border/50 flex justify-between font-semibold">
                        <span>You Receive</span>
                        <span className="font-mono text-primary">{formatTokenAmount(buyQuote.netAmount)} {dtr.ticker}</span>
                      </div>
                      {numBuyAmount > 0 && (
                        <div className="flex justify-between text-sm">
                          <span className="text-muted-foreground flex items-center gap-1">
                            Price Impact
                            <Tooltip>
                              <TooltipTrigger><Info className="w-3 h-3" /></TooltipTrigger>
                              <TooltipContent>Buys push this DTR's price up against its liquidity depth -- larger orders move it more.</TooltipContent>
                            </Tooltip>
                          </span>
                          <span className="font-mono text-positive">+{buyQuote.priceImpactPct.toFixed(2)}% &rarr; {formatUsdc(buyQuote.newPrice)}</span>
                        </div>
                      )}
                    </div>

                    <Button 
                      className="w-full h-12 text-lg font-bold shadow-lg shadow-primary/20" 
                      onClick={handleBuy}
                      disabled={!wallet.connected || isProcessing || numBuyAmount <= 0 || numBuyAmount > wallet.usdc}
                    >
                      {isProcessing ? (
                        <div className="flex items-center gap-2">
                          <div className="w-4 h-4 border-2 border-background border-t-transparent rounded-full animate-spin" /> Processing...
                        </div>
                      ) : !wallet.connected ? (
                        "Connect Wallet to Trade"
                      ) : numBuyAmount > wallet.usdc ? (
                        "Insufficient Balance"
                      ) : (
                        `Buy ${dtr.ticker}`
                      )}
                    </Button>
                  </TabsContent>

                  <TabsContent value="sell" className="mt-0 space-y-4">
                    <div className="flex justify-between items-center text-sm mb-2">
                      <span className="text-muted-foreground">Available</span>
                      <span className="font-mono font-medium">
                        {wallet.connected ? `${formatTokenAmount(holding?.tokenBalance || 0)} ${dtr.ticker}` : "—"}
                      </span>
                    </div>

                    <div className="relative">
                      <div className="absolute inset-y-0 right-3 flex items-center pointer-events-none text-muted-foreground font-medium text-sm">
                        {dtr.ticker}
                      </div>
                      <Input 
                        type="number" 
                        placeholder="0.00" 
                        className="h-14 bg-background border-border/60 text-lg font-mono pr-20"
                        value={sellAmount}
                        onChange={(e) => setSellAmount(e.target.value)}
                        disabled={!wallet.connected || isProcessing || !holding}
                      />
                    </div>

                    <div className="grid grid-cols-4 gap-2">
                      {[0.25, 0.5, 0.75, 1].map((pct) => (
                        <Button 
                          key={pct} 
                          variant="outline" 
                          size="sm" 
                          className="bg-muted/30 text-xs h-7 border-border/50"
                          onClick={() => setSellPct(pct)}
                          disabled={!wallet.connected || isProcessing || !holding}
                        >
                          {pct === 1 ? "Max" : `${pct * 100}%`}
                        </Button>
                      ))}
                    </div>

                    <div className="p-4 bg-muted/20 rounded-lg space-y-3 border border-border/40 mt-6">
                      <div className="flex justify-between text-sm">
                        <span className="text-muted-foreground">Price</span>
                        <span className="font-mono">{formatUsdc(dtr.tokenPrice)}</span>
                      </div>
                      <div className="flex justify-between text-sm">
                        <span className="text-muted-foreground">Gross USDC</span>
                        <span className="font-mono">{formatUsdc(sellQuote.grossAmount)}</span>
                      </div>
                      <div className="flex justify-between text-sm">
                        <span className="text-muted-foreground flex items-center gap-1">
                          Trading Fee
                          <Tooltip>
                            <TooltipTrigger><Info className="w-3 h-3" /></TooltipTrigger>
                            <TooltipContent>SSR.FUN protocol fee (0.10%)</TooltipContent>
                          </Tooltip>
                        </span>
                        <span className="font-mono text-destructive">-{formatUsdc(sellQuote.fee)}</span>
                      </div>
                      <div className="pt-3 border-t border-border/50 flex justify-between font-semibold">
                        <span>You Receive</span>
                        <span className="font-mono text-foreground">{formatUsdc(sellQuote.netAmount)}</span>
                      </div>
                      {numSellAmount > 0 && (
                        <div className="flex justify-between text-sm">
                          <span className="text-muted-foreground flex items-center gap-1">
                            Price Impact
                            <Tooltip>
                              <TooltipTrigger><Info className="w-3 h-3" /></TooltipTrigger>
                              <TooltipContent>Sells push this DTR's price down against its liquidity depth -- larger orders move it more.</TooltipContent>
                            </Tooltip>
                          </span>
                          <span className="font-mono text-destructive">{sellQuote.priceImpactPct.toFixed(2)}% &rarr; {formatUsdc(sellQuote.newPrice)}</span>
                        </div>
                      )}
                    </div>

                    <Button 
                      variant="destructive"
                      className="w-full h-12 text-lg font-bold shadow-lg shadow-destructive/20" 
                      onClick={handleSell}
                      disabled={!wallet.connected || isProcessing || numSellAmount <= 0 || numSellAmount > (holding?.tokenBalance || 0)}
                    >
                      {isProcessing ? (
                        <div className="flex items-center gap-2">
                          <div className="w-4 h-4 border-2 border-background border-t-transparent rounded-full animate-spin" /> Processing...
                        </div>
                      ) : !wallet.connected ? (
                        "Connect Wallet to Trade"
                      ) : numSellAmount > (holding?.tokenBalance || 0) ? (
                        "Insufficient Balance"
                      ) : (
                        `Sell ${dtr.ticker}`
                      )}
                    </Button>
                  </TabsContent>
                </CardContent>
              </Tabs>
            </Card>
            
            {holding && holding.tokenBalance > 0 && (
              <Card className="mt-4 border-border/50 bg-card/30">
                <CardHeader className="pb-3">
                  <CardTitle className="text-sm font-semibold">Your Position</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="flex justify-between text-sm">
                    <span className="text-muted-foreground">Balance</span>
                    <span className="font-mono font-semibold">{formatTokenAmount(holding.tokenBalance)}</span>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span className="text-muted-foreground">Value</span>
                    <span className="font-mono font-semibold">{formatUsdc(holding.tokenBalance * dtr.tokenPrice)}</span>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span className="text-muted-foreground">Avg Entry</span>
                    <span className="font-mono text-muted-foreground">{formatUsdc(holding.avgPurchasePrice)}</span>
                  </div>
                  <div className="pt-2 border-t border-border/50 flex justify-between text-sm">
                    <span className="text-muted-foreground">Unrealized P&L</span>
                    <span className={`font-mono font-semibold ${dtr.tokenPrice >= holding.avgPurchasePrice ? 'text-primary' : 'text-destructive'}`}>
                      {dtr.tokenPrice >= holding.avgPurchasePrice ? '+' : ''}
                      {formatUsdc((dtr.tokenPrice - holding.avgPurchasePrice) * holding.tokenBalance)}
                    </span>
                  </div>
                </CardContent>
              </Card>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
