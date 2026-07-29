import { useEffect, useMemo, useState } from "react";
import { useParams, Link } from "wouter";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import { SOL_TEST_PRICE_USD, DEVUSDC, DEVUSDC_MINT, fetchReserveOnChain, fetchTokenBalanceRaw, computeRedemptionEntitlements } from "@ssr/sdk";
import { useAppStore, isManagerOrDelegate } from "@/store/useAppStore";
import { executeBuyZapDevUsdc, executeSellZap } from "@/lib/zapClient";
import { explorerUrl } from "@/lib/solana-config";
import {
  buildLineSeries,
  buildSimulatedOrderBook,
  calcTokensReceived,
  calcUsdcReceived,
  formatUsdc,
  formatTokenAmount,
  sampleLinePoints,
} from "@/lib/calculations";
import type { ChartTimeframe } from "@/lib/types";
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip as RechartsTooltip,
  PieChart as RechartsPieChart,
  Pie,
  Cell,
} from "recharts";
import { format } from "date-fns";
import { ChevronLeft, Info, ArrowUpRight, ArrowDownRight, Layers, BarChart3, Activity } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
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

const CHART_TIMEFRAMES: ChartTimeframe[] = ["1s", "1m", "5m", "1h", "4h", "24h", "7d", "30d", "1y", "All"];

/** Axis tick label, chosen by how fine the selected timeframe's resolution is. */
function timeframeTickFormat(t: number, timeframe: ChartTimeframe): string {
  if (timeframe === "1s" || timeframe === "1m") return format(new Date(t), "HH:mm:ss");
  if (timeframe === "5m" || timeframe === "1h" || timeframe === "4h" || timeframe === "24h") return format(new Date(t), "HH:mm");
  return format(new Date(t), "MMM d");
}

export function DTRDetail() {
  const { dtrId } = useParams();
  const { wallet, holdings, dtrs, mergeOnChainReserve, syncRealHolding, syncWalletFromChain } = useAppStore();
  const dtr = dtrs.find((d) => d.id === (dtrId || ""));
  const { toast } = useToast();
  const { connection } = useConnection();
  const walletCtx = useWallet();

  // Chart timeframe is local UI state -- it persists across live store updates
  // (trades, price ticks) since this component only re-renders, never remounts.
  const [timeframe, setTimeframe] = useState<ChartTimeframe>("24h");

  // Trading state
  const [tradeTab, setTradeTab] = useState<"buy" | "sell">("buy");
  const [buyAmount, setBuyAmount] = useState("");
  const [sellAmount, setSellAmount] = useState("");
  const [isProcessing, setIsProcessing] = useState(false);
  // devUSDC is the default DevNet settlement asset for mint (Buy) -- a real
  // balance read from chain, never simulated. See
  // buildBuyZapInstructionsDevUsdc / DEC "devUSDC default settlement asset".
  const [devUsdcBalanceRaw, setDevUsdcBalanceRaw] = useState<bigint>(0n);

  // Real (chain-backed) Reserves trade via the DevNet SOL zap adapter instead
  // of the simulated AMM curve -- see docs/protocol/FRONTEND_INTEGRATION.md
  // "Buy/Sell zap architecture". Everything below this flag is the ONLY
  // behavioral branch point; the surrounding JSX structure is unchanged.
  const isOnChain = !!dtr?.onChain;

  /** Re-fetches this Reserve's on-chain state + the connected wallet's real balance immediately after a confirmed tx, rather than waiting for RealReserveSync's next poll. */
  async function refreshRealReserveNow() {
    if (!dtr?.onChain) return;
    try {
      const programId = new PublicKey(dtr.onChain.programId);
      const reserveAddress = new PublicKey(dtr.onChain.reserve);
      const mints = dtr.onChain.assets.map((a) => new PublicKey(a.mint));
      const onChain = await fetchReserveOnChain(connection, programId, reserveAddress, mints);
      if (onChain) {
        mergeOnChainReserve(
          dtr.id,
          {
            reserveId: dtr.onChain.reserveId,
            reserve: dtr.onChain.reserve,
            reserveTokenMint: dtr.onChain.reserveTokenMint,
            mintAuthority: dtr.onChain.mintAuthority,
            vaultAuthority: dtr.onChain.vaultAuthority,
            assets: dtr.onChain.assets.map((a) => ({ mint: a.mint, symbol: a.symbol, decimals: a.decimals, weightBps: a.weightBps, reserveAsset: a.reserveAsset, vault: a.vault })),
          },
          onChain,
        );
      }
      if (walletCtx.publicKey) {
        const balanceRaw = await fetchTokenBalanceRaw(connection, new PublicKey(dtr.onChain.reserveTokenMint), walletCtx.publicKey);
        syncRealHolding(dtr.id, balanceRaw, dtr.nav);
        const solLamports = await connection.getBalance(walletCtx.publicKey, "confirmed");
        syncWalletFromChain({ connected: true, connecting: false, address: walletCtx.publicKey.toBase58(), provider: wallet.provider, solLamports });
        const devUsdcRaw = await fetchTokenBalanceRaw(connection, DEVUSDC_MINT, walletCtx.publicKey);
        setDevUsdcBalanceRaw(BigInt(devUsdcRaw));
      }
    } catch {
      // Best-effort immediate refresh; RealReserveSync's regular poll will catch up regardless.
    }
  }

  // Initial devUSDC balance read (refreshRealReserveNow only runs after a
  // confirmed tx) -- real, read live from chain, never simulated.
  useEffect(() => {
    if (!walletCtx.publicKey) {
      setDevUsdcBalanceRaw(0n);
      return;
    }
    let cancelled = false;
    fetchTokenBalanceRaw(connection, DEVUSDC_MINT, walletCtx.publicKey)
      .then((raw) => {
        if (!cancelled) setDevUsdcBalanceRaw(BigInt(raw));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [walletCtx.publicKey?.toBase58(), connection]);

  // Derived chart/market data. Kept above the "not found" early return (and fed safe
  // fallbacks when dtr is undefined) so hook call order never changes between renders.
  const priceHistory = dtr?.priceHistory ?? [];
  const trades = dtr?.trades ?? [];

  // Flatlines at the last known price when a timeframe has no real history, and leads
  // in from a flat baseline when it has only a little -- so a quiet window reads as
  // "nothing happened" and a single trade reads as a rise/fall, never a blank chart
  // or an isolated dot.
  const windowPoints = useMemo(() => buildLineSeries(priceHistory, timeframe), [priceHistory, timeframe]);

  const chartData = useMemo(
    () => sampleLinePoints(windowPoints, 300).map((p) => ({ ...p, dateStr: timeframeTickFormat(p.t, timeframe) })),
    [windowPoints, timeframe],
  );

  const orderBook = useMemo(
    () => buildSimulatedOrderBook(dtr?.tokenPrice ?? 0, dtr?.liquidityUsdc ?? 0),
    [dtr?.tokenPrice, dtr?.liquidityUsdc],
  );

  const recentTrades = useMemo(() => [...trades].reverse(), [trades]);

  if (!dtr) {
    return (
      <div className="container mx-auto px-4 py-24 text-center">
        <h1 className="text-3xl font-merge-display font-bold mb-4">Reserve Not Found</h1>
        <p className="text-muted-foreground mb-8">The requested Reserve does not exist or has been removed.</p>
        <Button asChild>
          <Link href="/">Return Home</Link>
        </Button>
      </div>
    );
  }

  const holding = holdings.find((h) => h.dtrId === dtr.id);
  const premiumDiscount = (dtr.tokenPrice - dtr.nav) / dtr.nav;
  const isPremium = premiumDiscount > 0;

  const chartMin = chartData.length ? Math.min(...chartData.map((d) => d.price)) : 0;
  const chartMax = chartData.length ? Math.max(...chartData.map((d) => d.price)) : 1;
  // A flatlined series has chartMin === chartMax; pad by at least a cent so the line
  // still renders inside the plot instead of collapsing onto an axis.
  const yPad = Math.max((chartMax - chartMin) * 0.05, chartMax * 0.01, 0.01);
  const yDomain = [chartMin - yPad, chartMax + yPad];

  // Pie chart data
  const pieData = dtr.composition.map(a => ({
    name: a.symbol,
    value: a.weight
  }));

  // Trading Calculations
  const numBuyAmount = parseFloat(buyAmount) || 0;
  const buyQuote = calcTokensReceived(numBuyAmount, dtr.tokenPrice, dtr.liquidityUsdc);
  // DevNet-only test-priced estimate (see zapPricing.ts) -- the server
  // independently recomputes the exact amounts from live chain state at
  // execution time; this is a preview only.
  // devUSDC is pegged $1 (Phase C) -- the settlement amount IS the USD
  // amount directly, no SOL-style price conversion needed.
  const estReserveTokensOut = isOnChain && dtr.nav > 0 ? numBuyAmount / dtr.nav : 0;

  const numSellAmount = parseFloat(sellAmount) || 0;
  const sellQuote = calcUsdcReceived(numSellAmount, dtr.tokenPrice, dtr.liquidityUsdc);
  // Canonical Sell estimate for a real (on-chain) Reserve: proportional
  // in-kind redemption into the Reserve's actual underlying asset(s),
  // computed from live on-chain vault balances/supply via the same
  // integer math the deployed program itself uses (see
  // packages/sdk/src/calculations.ts's computeRedemptionEntitlements) --
  // NOT a fixed synthetic SOL price. See
  // docs/project/DEVNET_IMPLEMENTATION_PLAN_2026-07-29.md item 8/9 for why
  // this replaced the old blended "~X SOL" headline.
  const sellEntitlements = (() => {
    if (!isOnChain || !dtr.onChain || numSellAmount <= 0) return [];
    const reserveTokensToRedeem = BigInt(Math.floor(numSellAmount * 1_000_000));
    const supply = BigInt(dtr.onChain.reserveTokenSupplyRaw || "0");
    if (reserveTokensToRedeem <= 0n || supply <= 0n) return [];
    const redemptionFeeBps = BigInt(dtr.onChain.redemptionFeeBps ?? 0);
    const vaultBalances = dtr.onChain.assets.map((a) => ({ mint: a.mint, vaultBalance: BigInt(dtr.onChain!.vaultBalancesRaw[a.mint] ?? "0") }));
    try {
      const entitlements = computeRedemptionEntitlements(reserveTokensToRedeem, redemptionFeeBps, supply, vaultBalances);
      return entitlements.map((e) => {
        const asset = dtr.onChain!.assets.find((a) => a.mint === e.mint);
        return {
          mint: e.mint,
          symbol: asset?.symbol ?? "Asset",
          amount: asset ? Number(e.entitlement) / 10 ** asset.decimals : 0,
        };
      });
    } catch {
      return [];
    }
  })();
  // The Reserve's real Sell execution today still settles as a fixed-rate
  // DevNet conversion into SOL (see packages/sdk/src/zapInstructions.ts) --
  // that mechanism is unchanged in this pass (Phase A is display/discovery
  // only). Shown as an explicitly-disclosed SECONDARY figure, never the
  // headline, and never implied to be a real market quote.
  const estSolOut = isOnChain ? (numSellAmount * dtr.nav) / SOL_TEST_PRICE_USD : 0;

  const handleBuy = async () => {
    if (!dtr.onChain) return;
    if (!walletCtx.publicKey) {
      toast({ variant: "destructive", title: "Connect Wallet", description: "Connect a wallet first." });
      return;
    }
    setIsProcessing(true);
    try {
      // devUSDC is the default DevNet settlement asset (see
      // buildBuyZapInstructionsDevUsdc): real devUSDC funds any devUSDC leg
      // this Reserve has directly from the user's own wallet; any other
      // asset the Reserve needs is still provided via the existing DevNet
      // test-asset faucet mechanism, exactly as before -- never a simulated
      // conversion between devUSDC and the other assets.
      const devUsdcAmountRaw = BigInt(Math.floor(numBuyAmount * 10 ** DEVUSDC.decimals));
      const { signature, quote } = await executeBuyZapDevUsdc({
        connection,
        wallet: walletCtx,
        reserveAddress: dtr.onChain.reserve,
        assetMints: dtr.onChain.assets.map((a) => a.mint),
        userPubkey: walletCtx.publicKey,
        devUsdcAmountRaw,
      });
      await refreshRealReserveNow();
      setBuyAmount("");
      const realLegs = (quote.legSources ?? []).filter((l) => l.source === "user-devusdc-balance").length;
      toast({
        title: "Buy confirmed on Solana DevNet",
        description: (
          <>
            <a href={explorerUrl("tx", signature)} target="_blank" rel="noreferrer" className="underline">
              View transaction on Solana Explorer (DevNet) &rarr;
            </a>
            {realLegs === 0 && (
              <p className="mt-1 text-xs">This Reserve has no devUSDC leg -- fully funded via the DevNet test-asset faucet mechanism, at no real cost to you.</p>
            )}
          </>
        ),
      });
    } catch (e) {
      toast({ variant: "destructive", title: "Buy Failed", description: e instanceof Error ? e.message : "The DevNet swap failed." });
    } finally {
      setIsProcessing(false);
    }
  };

  // Fail closed: this app only ever executes a real signed DevNet
  // transaction for mint/redeem (see handleBuy/handleSell above). A DTR
  // without verified on-chain state (dtr.onChain) has no genuine mechanism
  // to buy through -- previously this called a fully client-side,
  // no-signature "mock" trade (buyDTRToken) that reported a fabricated
  // "Order Executed" success against a fictional balance. Removed as part
  // of this corrective pass (see docs/project/PROJECT_STATUS.md); this
  // should be unreachable in practice since only genuine on-chain Reserves
  // are ever discoverable now, but the button must never silently fall
  // back to a fake trade if it somehow is.
  const handleBuyUnavailable = async () => {
    toast({
      variant: "destructive",
      title: "Not available",
      description: "This Reserve could not be verified on-chain -- no real interaction is available for it.",
    });
  };

  const handleSell = async () => {
    if (!dtr.onChain) return;
    if (!walletCtx.publicKey) {
      toast({ variant: "destructive", title: "Connect Wallet", description: "Connect a wallet first." });
      return;
    }
    setIsProcessing(true);
    try {
      const reserveTokensToRedeem = BigInt(Math.floor(numSellAmount * 1_000_000));
      const { signature } = await executeSellZap({
        connection,
        wallet: walletCtx,
        reserveAddress: dtr.onChain.reserve,
        assetMints: dtr.onChain.assets.map((a) => a.mint),
        userPubkey: walletCtx.publicKey,
        reserveTokensToRedeem,
      });
      await refreshRealReserveNow();
      setSellAmount("");
      toast({
        title: "Sell confirmed on Solana DevNet",
        description: (
          <a href={explorerUrl("tx", signature)} target="_blank" rel="noreferrer" className="underline">
            View transaction on Solana Explorer (DevNet) &rarr;
          </a>
        ),
      });
    } catch (e) {
      toast({ variant: "destructive", title: "Sell Failed", description: e instanceof Error ? e.message : "The DevNet swap failed." });
    } finally {
      setIsProcessing(false);
    }
  };

  // Same fail-closed reasoning as handleBuyUnavailable above.
  const handleSellUnavailable = async () => {
    toast({
      variant: "destructive",
      title: "Not available",
      description: "This Reserve could not be verified on-chain -- no real interaction is available for it.",
    });
  };

  const onBuyClick = isOnChain ? handleBuy : handleBuyUnavailable;
  const onSellClick = isOnChain ? handleSell : handleSellUnavailable;

  // devUSDC is the default settlement asset: only the FRACTION of a mint
  // attributable to this Reserve's own devUSDC leg (if it has one) is drawn
  // from the user's real devUSDC balance -- every other leg is still
  // DevNet-test-asset-faucet-funded, unchanged. Computed from the Reserve's
  // own known target weights (already available client-side), not a live
  // quote -- the server independently recomputes the exact amounts at
  // execution time regardless.
  const devUsdcAsset = isOnChain ? dtr.onChain!.assets.find((a) => a.mint === DEVUSDC.mint) : undefined;
  const devUsdcWeightFraction =
    devUsdcAsset && dtr.onChain!.totalTargetWeightBps > 0 ? devUsdcAsset.weightBps / dtr.onChain!.totalTargetWeightBps : 0;
  const devUsdcBalanceHuman = Number(devUsdcBalanceRaw) / 10 ** DEVUSDC.decimals;
  const requiredDevUsdcForBuy = numBuyAmount * devUsdcWeightFraction;
  // "Available" for the quick-select buttons: the largest total mint size
  // affordable given the real devUSDC balance, or a sensible default when
  // this Reserve has no devUSDC leg at all (not balance-constrained in that
  // case -- see the composition breakdown below, which discloses this).
  const buyAvailable = isOnChain ? (devUsdcWeightFraction > 0 ? devUsdcBalanceHuman / devUsdcWeightFraction : 100) : 0;
  // Only the actual devUSDC-leg requirement is balance-gated -- a Reserve
  // with no devUSDC leg at all has no real-balance constraint on this input.
  const buyInsufficientBalance = isOnChain ? requiredDevUsdcForBuy > devUsdcBalanceHuman : numBuyAmount > buyAvailable;

  const setBuyPct = (pct: number) => {
    if (wallet.connected) {
      setBuyAmount((buyAvailable * pct).toString());
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
                <AvatarFallback className="bg-primary/10 text-primary text-2xl font-merge-display font-bold">
                  {dtr.ticker.slice(0, 2)}
                </AvatarFallback>
              </Avatar>
              <div>
                <div className="flex items-center gap-3 mb-1">
                  <h1 className="text-4xl font-merge-display font-bold tracking-tight">{dtr.name}</h1>
                  <Badge variant="secondary" className="font-merge-mono text-sm">{dtr.ticker}</Badge>
                </div>
                <div className="flex items-center gap-3 text-sm text-muted-foreground mb-4">
                  <Badge variant="outline" className="bg-background/50 border-border">{dtr.category}</Badge>
                  <Badge variant={isOnChain ? "default" : "secondary"} className="uppercase text-[10px] tracking-wide">
                    {isOnChain ? "Live on Solana DevNet" : "Simulated Demo"}
                  </Badge>
                  <span>{isOnChain ? "Holder count not indexed" : `${dtr.holders.toLocaleString()} Holders`}</span>
                </div>
                <p className="text-muted-foreground max-w-xl leading-relaxed">
                  {dtr.description}
                </p>
              </div>
            </div>
            
            <div className="flex flex-col items-end gap-3 shrink-0">
              <div className="bg-card border border-card-border shadow-sm rounded-xl p-4 min-w-[200px]">
                <p className="text-xs text-muted-foreground mb-1 uppercase tracking-wider font-semibold">Token Price</p>
                <div className="flex items-baseline gap-2 mb-1">
                  <span className="text-3xl font-merge-mono font-bold text-foreground">{formatUsdc(dtr.tokenPrice)}</span>
                </div>
                <p className={`text-sm font-merge-mono flex items-center ${dtr.change24h >= 0 ? 'text-positive' : 'text-destructive'}`}>
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

          {isOnChain && dtr.onChain && (
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <span className="font-semibold">View on Solana Explorer:</span>
              <a href={explorerUrl("address", dtr.onChain.reserve)} target="_blank" rel="noreferrer" className="underline hover:text-primary">Reserve</a>
              <span aria-hidden="true">·</span>
              <a href={explorerUrl("address", dtr.onChain.reserveTokenMint)} target="_blank" rel="noreferrer" className="underline hover:text-primary">Reserve Token Mint</a>
              {dtr.onChain.assets.map((a) => (
                <span key={a.mint} className="flex items-center gap-2">
                  <span aria-hidden="true">·</span>
                  <a href={explorerUrl("address", a.vault)} target="_blank" rel="noreferrer" className="underline hover:text-primary">{a.symbol} Vault</a>
                </span>
              ))}
            </div>
          )}

          {isOnChain && dtr.onChain?.assetsResolvedFully === false && (
            <div className="rounded-lg border border-dashed p-3 text-sm" style={{ borderColor: "var(--warn, #d9a13c)" }}>
              This Reserve reports {dtr.onChain.assetCount} registered asset(s) on-chain, but only {dtr.onChain.assets.length} could
              be resolved by this discovery pass -- composition/AUM below may be incomplete, not wrong. See
              docs/protocol/FRONTEND_INTEGRATION.md "Canonical discovery" for why.
            </div>
          )}
          {isOnChain && dtr.chainStatus === "error" && (
            <div className="rounded-lg border border-dashed p-3 text-sm" style={{ borderColor: "var(--destructive, #e5484d)", color: "var(--destructive, #e5484d)" }}>
              Live DevNet data could not be refreshed{dtr.chainError ? `: ${dtr.chainError}` : "."} Figures below are the last known
              on-chain state, not necessarily current.
            </div>
          )}

          {/* Stats Grid */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <Card className="bg-secondary/40 border-transparent shadow-none">
              <CardContent className="p-4">
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-2">
                  AUM
                  <Tooltip>
                    <TooltipTrigger><Info className="w-3 h-3" /></TooltipTrigger>
                    <TooltipContent>Assets Under Management (Total value of underlying assets)</TooltipContent>
                  </Tooltip>
                </div>
                <p className="text-xl font-merge-mono font-semibold">{formatUsdc(dtr.aum, { compact: true })}</p>
              </CardContent>
            </Card>
            <Card className="bg-secondary/40 border-transparent shadow-none">
              <CardContent className="p-4">
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-2">
                  NAV per Token
                  <Tooltip>
                    <TooltipTrigger><Info className="w-3 h-3" /></TooltipTrigger>
                    <TooltipContent>Net Asset Value: The underlying value backing each token.</TooltipContent>
                  </Tooltip>
                </div>
                <p className="text-xl font-merge-mono font-semibold">{formatUsdc(dtr.nav)}</p>
              </CardContent>
            </Card>
            <Card className="bg-secondary/40 border-transparent shadow-none">
              <CardContent className="p-4">
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-2">
                  Prem/Discount
                  <Tooltip>
                    <TooltipTrigger><Info className="w-3 h-3" /></TooltipTrigger>
                    <TooltipContent>Difference between market price and NAV. Premium implies high demand.</TooltipContent>
                  </Tooltip>
                </div>
                <p className={`text-xl font-merge-mono font-semibold ${isPremium ? 'text-positive' : 'text-destructive'}`}>
                  {isPremium ? '+' : ''}{(premiumDiscount * 100).toFixed(2)}%
                </p>
              </CardContent>
            </Card>
            <Card className="bg-secondary/40 border-transparent shadow-none">
              <CardContent className="p-4">
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-2">
                  7D Performance
                </div>
                <p className={`text-xl font-merge-mono font-semibold ${dtr.change7d >= 0 ? 'text-positive' : 'text-destructive'}`}>
                  {dtr.change7d >= 0 ? '+' : ''}{dtr.change7d.toFixed(2)}%
                </p>
              </CardContent>
            </Card>
          </div>

          {/* Chart Section */}
          <Card className="bg-card border-card-border hover:shadow-md transition-shadow duration-300">
            <CardHeader className="flex flex-col gap-3 pb-2 lg:flex-row lg:items-center lg:justify-between">
              <CardTitle className="text-lg font-merge-display flex items-center gap-2">
                <Activity className="w-5 h-5 text-primary" /> Price History
              </CardTitle>
              <div className="flex items-center gap-2 overflow-x-auto no-scrollbar -mx-1 px-1 lg:mx-0 lg:px-0">
                <div className="flex shrink-0 bg-muted/50 p-1 rounded-md">
                  {CHART_TIMEFRAMES.map((tf) => (
                    <button
                      key={tf}
                      onClick={() => setTimeframe(tf)}
                      className={`px-2.5 py-1 text-xs font-medium rounded-sm transition-colors whitespace-nowrap ${
                        timeframe === tf
                          ? 'bg-background text-foreground shadow-sm'
                          : 'text-muted-foreground hover:text-foreground hover:bg-muted'
                      }`}
                    >
                      {tf}
                    </button>
                  ))}
                </div>
              </div>
            </CardHeader>
            <CardContent className="p-0 sm:p-6 sm:pt-0 h-[350px] w-full">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={chartData} margin={{ top: 20, right: 20, bottom: 20, left: 20 }}>
                  <defs>
                    <linearGradient id="priceGradient" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="hsl(var(--primary))" stopOpacity={0.16} />
                      <stop offset="100%" stopColor="hsl(var(--primary))" stopOpacity={0} />
                    </linearGradient>
                  </defs>
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
                    contentStyle={{ backgroundColor: 'hsl(var(--card))', borderColor: 'hsl(var(--card-border))', borderRadius: '0.75rem', boxShadow: 'var(--shadow-md)', color: 'hsl(var(--foreground))' }}
                    itemStyle={{ color: 'hsl(var(--primary))', fontWeight: 'bold' }}
                    labelStyle={{ color: 'hsl(var(--muted-foreground))', marginBottom: '4px' }}
                    formatter={(value) => [formatUsdc(Number(value)), "Price"]}
                  />
                  <Area
                    type="monotone"
                    dataKey="price"
                    stroke="hsl(var(--primary))"
                    strokeWidth={2}
                    fill="url(#priceGradient)"
                    dot={false}
                    isAnimationActive
                    animationDuration={350}
                    animationEasing="ease-out"
                    activeDot={{ r: 6, fill: "hsl(var(--primary))", stroke: "hsl(var(--background))", strokeWidth: 2 }}
                  />
                </AreaChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>

          {/* Composition Section */}
          <Card className="bg-card border-card-border hover:shadow-md transition-shadow duration-300">
            <CardHeader>
              <CardTitle className="text-lg font-merge-display flex items-center gap-2">
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
                        {pieData.map((_, index) => (
                          <Cell key={`cell-${index}`} fill={CHART_COLORS[index % CHART_COLORS.length]} />
                        ))}
                      </Pie>
                      <RechartsTooltip
                        formatter={(value) => [`${(Number(value) * 100).toFixed(1)}%`, "Weight"]}
                        contentStyle={{ backgroundColor: 'hsl(var(--card))', borderColor: 'hsl(var(--card-border))', borderRadius: '0.75rem', boxShadow: 'var(--shadow-md)', color: 'hsl(var(--foreground))' }}
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
                          <TableCell className="text-right font-merge-mono">
                            {(asset.weight * 100).toFixed(2)}%
                          </TableCell>
                          <TableCell className="text-right font-merge-mono text-muted-foreground hidden sm:table-cell">
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
          <Card className="bg-card border-card-border hover:shadow-md transition-shadow duration-300">
             <CardContent className="p-0">
               <Table>
                 <TableBody>
                   <TableRow className="border-border/50">
                     <TableCell className="py-4 text-muted-foreground">Contract Address</TableCell>
                     <TableCell className="text-right font-merge-mono text-xs">{dtr.dtrAddress}</TableCell>
                   </TableRow>
                   <TableRow className="border-border/50">
                     <TableCell className="py-4 text-muted-foreground">Manager Address</TableCell>
                     <TableCell className="text-right font-merge-mono text-xs">{dtr.managerAddress}</TableCell>
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
                      <span className="text-muted-foreground">Your devUSDC balance</span>
                      <span className="font-merge-mono font-medium">
                        {wallet.connected ? (isOnChain ? `${devUsdcBalanceHuman.toFixed(2)} devUSDC` : formatUsdc(buyAvailable)) : "—"}
                      </span>
                    </div>

                    <div className="relative">
                      <div className="absolute inset-y-0 right-3 flex items-center pointer-events-none text-muted-foreground font-medium text-sm">
                        {isOnChain ? "devUSDC" : "USDC"}
                      </div>
                      <Input
                        type="number"
                        placeholder="0.00"
                        className="h-14 bg-background border-border/60 text-lg font-merge-mono pr-16"
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

                    {isOnChain ? (
                      <div className="p-4 bg-muted/20 rounded-lg space-y-3 border border-border/40 mt-6">
                        <div className="flex justify-between text-sm">
                          <span className="text-muted-foreground flex items-center gap-1">
                            Settlement asset
                            <Tooltip>
                              <TooltipTrigger><Info className="w-3 h-3" /></TooltipTrigger>
                              <TooltipContent>devUSDC ("SSR Test USD") is the default DevNet settlement asset -- 1 devUSDC = $1 by design, no price feed involved.</TooltipContent>
                            </Tooltip>
                          </span>
                          <span className="font-merge-mono">devUSDC</span>
                        </div>
                        <div className="flex justify-between text-sm">
                          <span className="text-muted-foreground">Mint Fee</span>
                          <span className="font-merge-mono">{dtr.feeConfig.mintFeePct.toFixed(2)}%</span>
                        </div>
                        <div className="pt-3 border-t border-border/50 flex justify-between font-semibold">
                          <span>Est. You Receive</span>
                          <span className="font-merge-mono text-primary">~{formatTokenAmount(estReserveTokensOut)} {dtr.ticker}</span>
                        </div>
                        <div className="flex justify-between text-sm">
                          <span className="text-muted-foreground">Slippage tolerance</span>
                          <span className="font-merge-mono">2%</span>
                        </div>
                        <div className="pt-3 border-t border-border/50 space-y-1.5">
                          <p className="text-xs font-semibold text-muted-foreground">Reserve composition for this mint</p>
                          {dtr.onChain!.assets.map((a) => {
                            const isDevUsdc = a.mint === DEVUSDC.mint;
                            const fraction = dtr.onChain!.totalTargetWeightBps > 0 ? a.weightBps / dtr.onChain!.totalTargetWeightBps : 0;
                            return (
                              <div key={a.mint} className="flex justify-between text-xs">
                                <span>{a.symbol} ({(fraction * 100).toFixed(0)}%)</span>
                                <span className={isDevUsdc ? "text-primary" : "text-muted-foreground"}>
                                  {isDevUsdc ? "from your wallet (real devUSDC)" : "DevNet test-asset faucet (no real cost)"}
                                </span>
                              </div>
                            );
                          })}
                          {devUsdcWeightFraction === 0 && (
                            <p className="text-[11px] text-muted-foreground/80 pt-1">
                              This Reserve has no devUSDC leg -- the current protocol has no single-currency "Buy with devUSDC" path without a swap, so this mint is fully funded via the DevNet test-asset faucet mechanism instead, at no real cost to you.
                            </p>
                          )}
                        </div>
                      </div>
                    ) : (
                    <div className="p-4 bg-muted/20 rounded-lg space-y-3 border border-border/40 mt-6">
                      <div className="flex justify-between text-sm">
                        <span className="text-muted-foreground">Price</span>
                        <span className="font-merge-mono">{formatUsdc(dtr.tokenPrice)}</span>
                      </div>
                      <div className="flex justify-between text-sm">
                        <span className="text-muted-foreground">Gross Tokens</span>
                        <span className="font-merge-mono">{formatTokenAmount(buyQuote.grossAmount)} {dtr.ticker}</span>
                      </div>
                      <div className="flex justify-between text-sm">
                        <span className="text-muted-foreground flex items-center gap-1">
                          Trading Fee
                          <Tooltip>
                            <TooltipTrigger><Info className="w-3 h-3" /></TooltipTrigger>
                            <TooltipContent>SSR.FUN protocol fee (0.10%)</TooltipContent>
                          </Tooltip>
                        </span>
                        <span className="font-merge-mono text-destructive">-{formatTokenAmount(buyQuote.fee)} {dtr.ticker}</span>
                      </div>
                      <div className="pt-3 border-t border-border/50 flex justify-between font-semibold">
                        <span>You Receive</span>
                        <span className="font-merge-mono text-primary">{formatTokenAmount(buyQuote.netAmount)} {dtr.ticker}</span>
                      </div>
                      {numBuyAmount > 0 && (
                        <div className="flex justify-between text-sm">
                          <span className="text-muted-foreground flex items-center gap-1">
                            Price Impact
                            <Tooltip>
                              <TooltipTrigger><Info className="w-3 h-3" /></TooltipTrigger>
                              <TooltipContent>Buys push this Reserve's price up against its liquidity depth -- larger orders move it more.</TooltipContent>
                            </Tooltip>
                          </span>
                          <span className="font-merge-mono text-positive">+{buyQuote.priceImpactPct.toFixed(2)}% &rarr; {formatUsdc(buyQuote.newPrice)}</span>
                        </div>
                      )}
                    </div>
                    )}

                    <Button
                      className="w-full h-12 text-lg font-bold shadow-lg shadow-primary/20"
                      onClick={onBuyClick}
                      disabled={!wallet.connected || isProcessing || numBuyAmount <= 0 || buyInsufficientBalance}
                    >
                      {isProcessing ? (
                        <div className="flex items-center gap-2">
                          <div className="w-4 h-4 border-2 border-background border-t-transparent rounded-full animate-spin" /> Processing...
                        </div>
                      ) : !wallet.connected ? (
                        "Connect Wallet to Trade"
                      ) : buyInsufficientBalance ? (
                        "Insufficient devUSDC Balance"
                      ) : (
                        `Buy ${dtr.ticker}`
                      )}
                    </Button>
                    {isOnChain && (
                      <p className="text-[11px] text-muted-foreground/70 text-center mt-2">
                        Submits a real Solana DevNet transaction, signed by your wallet -- no Mainnet value.
                      </p>
                    )}
                  </TabsContent>

                  <TabsContent value="sell" className="mt-0 space-y-4">
                    <div className="flex justify-between items-center text-sm mb-2">
                      <span className="text-muted-foreground">Available</span>
                      <span className="font-merge-mono font-medium">
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
                        className="h-14 bg-background border-border/60 text-lg font-merge-mono pr-20"
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

                    {isOnChain ? (
                      <div className="p-4 bg-muted/20 rounded-lg space-y-3 border border-border/40 mt-6">
                        <div className="flex justify-between text-sm">
                          <span className="text-muted-foreground flex items-center gap-1">
                            Canonical redemption
                            <Tooltip>
                              <TooltipTrigger><Info className="w-3 h-3" /></TooltipTrigger>
                              <TooltipContent>Proportional, on-chain redemption into this Reserve's actual underlying asset(s) -- computed live from real vault balances and supply, not a synthetic price.</TooltipContent>
                            </Tooltip>
                          </span>
                        </div>
                        {sellEntitlements.length > 0 ? (
                          <div className="pt-1 space-y-1.5">
                            {sellEntitlements.map((e) => (
                              <div key={e.mint} className="flex justify-between font-semibold">
                                <span>Est. You Receive</span>
                                <span className="font-merge-mono text-foreground">~{e.amount.toFixed(6)} {e.symbol}</span>
                              </div>
                            ))}
                          </div>
                        ) : (
                          <p className="text-sm text-muted-foreground">Enter an amount to preview your in-kind redemption.</p>
                        )}
                        <div className="pt-3 border-t border-border/50 space-y-1.5">
                          <div className="flex justify-between text-xs text-muted-foreground">
                            <span className="flex items-center gap-1">
                              Current settlement (secondary, fixed-rate)
                              <Tooltip>
                                <TooltipTrigger><Info className="w-3 h-3" /></TooltipTrigger>
                                <TooltipContent>
                                  This DevNet test environment currently settles Sell by redeeming in-kind (above) and then converting
                                  that value to SOL at a FIXED DevNet test rate (${SOL_TEST_PRICE_USD.toFixed(2)}/SOL) -- not a real market
                                  quote or an actual MOCX/asset-to-SOL swap. Canonical in-kind redemption without this conversion step is
                                  planned for a future update (see the DevNet implementation plan).
                                </TooltipContent>
                              </Tooltip>
                            </span>
                            <span className="font-merge-mono">~{estSolOut.toFixed(5)} SOL @ fixed ${SOL_TEST_PRICE_USD.toFixed(2)}/SOL</span>
                          </div>
                        </div>
                      </div>
                    ) : (
                    <div className="p-4 bg-muted/20 rounded-lg space-y-3 border border-border/40 mt-6">
                      <div className="flex justify-between text-sm">
                        <span className="text-muted-foreground">Price</span>
                        <span className="font-merge-mono">{formatUsdc(dtr.tokenPrice)}</span>
                      </div>
                      <div className="flex justify-between text-sm">
                        <span className="text-muted-foreground">Gross USDC</span>
                        <span className="font-merge-mono">{formatUsdc(sellQuote.grossAmount)}</span>
                      </div>
                      <div className="flex justify-between text-sm">
                        <span className="text-muted-foreground flex items-center gap-1">
                          Trading Fee
                          <Tooltip>
                            <TooltipTrigger><Info className="w-3 h-3" /></TooltipTrigger>
                            <TooltipContent>SSR.FUN protocol fee (0.10%)</TooltipContent>
                          </Tooltip>
                        </span>
                        <span className="font-merge-mono text-destructive">-{formatUsdc(sellQuote.fee)}</span>
                      </div>
                      <div className="pt-3 border-t border-border/50 flex justify-between font-semibold">
                        <span>You Receive</span>
                        <span className="font-merge-mono text-foreground">{formatUsdc(sellQuote.netAmount)}</span>
                      </div>
                      {numSellAmount > 0 && (
                        <div className="flex justify-between text-sm">
                          <span className="text-muted-foreground flex items-center gap-1">
                            Price Impact
                            <Tooltip>
                              <TooltipTrigger><Info className="w-3 h-3" /></TooltipTrigger>
                              <TooltipContent>Sells push this Reserve's price down against its liquidity depth -- larger orders move it more.</TooltipContent>
                            </Tooltip>
                          </span>
                          <span className="font-merge-mono text-destructive">{sellQuote.priceImpactPct.toFixed(2)}% &rarr; {formatUsdc(sellQuote.newPrice)}</span>
                        </div>
                      )}
                    </div>
                    )}

                    <Button
                      variant="destructive"
                      className="w-full h-12 text-lg font-bold shadow-lg shadow-destructive/20"
                      onClick={onSellClick}
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
                    {isOnChain && (
                      <p className="text-[11px] text-muted-foreground/70 text-center mt-2">
                        Submits a real Solana DevNet transaction, signed by your wallet -- no Mainnet value.
                      </p>
                    )}
                  </TabsContent>
                </CardContent>
              </Tabs>
            </Card>
            
            {holding && holding.tokenBalance > 0 && (
              <Card className="mt-4 bg-secondary/40 border-transparent shadow-none">
                <CardHeader className="pb-3">
                  <CardTitle className="text-sm font-semibold">Your Position</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="flex justify-between text-sm">
                    <span className="text-muted-foreground">Balance</span>
                    <span className="font-merge-mono font-semibold">{formatTokenAmount(holding.tokenBalance)}</span>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span className="text-muted-foreground">Value</span>
                    <span className="font-merge-mono font-semibold">{formatUsdc(holding.tokenBalance * dtr.tokenPrice)}</span>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span className="text-muted-foreground">Avg Entry</span>
                    <span className="font-merge-mono text-muted-foreground">{formatUsdc(holding.avgPurchasePrice)}</span>
                  </div>
                  <div className="pt-2 border-t border-border/50 flex justify-between text-sm">
                    <span className="text-muted-foreground">Unrealized P&L</span>
                    <span className={`font-merge-mono font-semibold ${dtr.tokenPrice >= holding.avgPurchasePrice ? 'text-primary' : 'text-destructive'}`}>
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

      {/* Market Section: Simulated Order Book + Recent Trades */}
      <div className="mt-12 space-y-4">
        <div className="flex items-center gap-2">
          <BarChart3 className="w-5 h-5 text-primary" />
          <h2 className="text-2xl font-merge-display font-bold">Market</h2>
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <Card className="bg-card border-card-border">
            <CardHeader className="pb-3">
              <CardTitle className="text-base font-merge-display flex items-center gap-2">
                <Layers className="w-4 h-4 text-primary" /> Simulated Order Book
              </CardTitle>
              <CardDescription>
                Price levels derived mathematically from the current liquidity curve -- not live external orders.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-3 gap-2 text-[10px] uppercase tracking-wider text-muted-foreground pb-2 border-b border-border">
                <span>Price (USDC)</span>
                <span className="text-right">Amount ({dtr.ticker})</span>
                <span className="text-right">Total (USDC)</span>
              </div>
              <div className="pt-1 space-y-0.5">
                {[...orderBook.asks].reverse().map((level, i) => {
                  const maxCum = orderBook.asks[0]?.cumulativeUsdc || 1;
                  const depthPct = Math.min((level.cumulativeUsdc / maxCum) * 100, 100);
                  return (
                    <div key={`ask-${i}`} className="relative grid grid-cols-3 gap-2 text-xs font-merge-mono py-1 rounded">
                      <div className="absolute inset-y-0 right-0 bg-destructive/[0.08]" style={{ width: `${depthPct}%` }} />
                      <span className="relative text-destructive">{formatUsdc(level.price)}</span>
                      <span className="relative text-right text-muted-foreground">{formatTokenAmount(level.tokenAmount)}</span>
                      <span className="relative text-right text-muted-foreground">{formatUsdc(level.usdcTotal, { compact: true })}</span>
                    </div>
                  );
                })}
              </div>
              <div className="flex items-center justify-center gap-2 py-2.5 my-1 border-y border-border">
                <span className="text-sm font-merge-mono font-semibold">{formatUsdc(orderBook.midPrice)}</span>
                <span className="text-[10px] text-muted-foreground uppercase tracking-wider">Mid Price</span>
              </div>
              <div className="pb-1 space-y-0.5">
                {orderBook.bids.map((level, i) => {
                  const maxCum = orderBook.bids[orderBook.bids.length - 1]?.cumulativeUsdc || 1;
                  const depthPct = Math.min((level.cumulativeUsdc / maxCum) * 100, 100);
                  return (
                    <div key={`bid-${i}`} className="relative grid grid-cols-3 gap-2 text-xs font-merge-mono py-1 rounded">
                      <div className="absolute inset-y-0 right-0 bg-positive/[0.08]" style={{ width: `${depthPct}%` }} />
                      <span className="relative text-positive">{formatUsdc(level.price)}</span>
                      <span className="relative text-right text-muted-foreground">{formatTokenAmount(level.tokenAmount)}</span>
                      <span className="relative text-right text-muted-foreground">{formatUsdc(level.usdcTotal, { compact: true })}</span>
                    </div>
                  );
                })}
              </div>
            </CardContent>
          </Card>

          <Card className="bg-card border-card-border">
            <CardHeader className="pb-3">
              <CardTitle className="text-base font-merge-display flex items-center gap-2">
                <Activity className="w-4 h-4 text-primary" /> Recent Trades
              </CardTitle>
              <CardDescription>Real buys and sells from this session -- nothing here is invented history.</CardDescription>
            </CardHeader>
            <CardContent>
              {recentTrades.length === 0 ? (
                <div className="py-10 text-center">
                  <p className="text-sm text-muted-foreground">No trades yet this session.</p>
                  <p className="text-xs text-muted-foreground/70 mt-1">Buy or sell {dtr.ticker} to see activity appear here immediately.</p>
                </div>
              ) : (
                <>
                  <div className="grid grid-cols-5 gap-2 text-[10px] uppercase tracking-wider text-muted-foreground pb-2 border-b border-border">
                    <span>Time</span>
                    <span>Side</span>
                    <span className="text-right">Price</span>
                    <span className="text-right">Amount</span>
                    <span className="text-right">Value</span>
                  </div>
                  <div className="max-h-[320px] overflow-y-auto divide-y divide-border/60">
                    {recentTrades.slice(0, 50).map((trade) => (
                      <div key={trade.id} className="grid grid-cols-5 gap-2 text-xs font-merge-mono py-2 items-center">
                        <span className="text-muted-foreground">{format(new Date(trade.t), "HH:mm:ss")}</span>
                        <span className={trade.side === "buy" ? "text-positive font-semibold" : "text-destructive font-semibold"}>
                          {trade.side === "buy" ? "Buy" : "Sell"}
                        </span>
                        <span className="text-right">{formatUsdc(trade.price)}</span>
                        <span className="text-right text-muted-foreground">{formatTokenAmount(trade.tokenAmount)}</span>
                        <span className="text-right text-muted-foreground">{formatUsdc(trade.usdcAmount, { compact: true })}</span>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
