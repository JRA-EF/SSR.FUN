import { useEffect, useMemo, useRef, useState } from "react";
import { useParams, Link } from "wouter";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import { SOL_TEST_PRICE_USD, DEVUSDC, DEVUSDC_MINT, fetchReserveOnChain, fetchTokenBalanceRaw, computeRedemptionEntitlements } from "@ssr/sdk";
import { useAppStore, isManagerOrDelegate } from "@/store/useAppStore";
import { executeBuyZapDevUsdc, executeSellZap, ZapBuildError } from "@/lib/zapClient";
import { explorerUrl } from "@/lib/solana-config";
import {
  AmbiguousConfirmationError,
  BALANCE_CACHE_TTL_MS,
  canSubmitNewTransaction,
  getCached,
  invalidateCached,
  reconcileByBalanceChange,
  tokenBalanceCacheKey,
  txPhaseLabel,
  withReadConcurrencyLimit,
  type TxPhase,
} from "@/lib/rpcResilience";
import {
  buildLineSeries,
  buildSimulatedOrderBook,
  calcTokensReceived,
  calcUsdcReceived,
  buyAvailableFromDevUsdcBalance,
  isReservePureDevUsdc,
  formatUsdc,
  formatTokenAmount,
  sampleLinePoints,
} from "@/lib/calculations";
import { normalizeReserveCategory, type ChartTimeframe } from "@/lib/types";
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
  const { wallet, holdings, dtrs, mergeOnChainReserve, syncRealHolding, syncWalletFromChain, recordConfirmedTrade } = useAppStore();
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
  // devUSDC is the default DevNet settlement asset for mint (Buy) -- a real
  // balance read from chain, never simulated. See
  // buildBuyZapInstructionsDevUsdc / DEC "devUSDC default settlement asset".
  const [devUsdcBalanceRaw, setDevUsdcBalanceRaw] = useState<bigint>(0n);
  // Tracks whether the real devUSDC balance read has actually resolved yet,
  // so the percentage quick-select buttons can be disabled (and show a
  // "Loading balance..."/"Balance unavailable" state) instead of computing
  // off a default 0n that hasn't been confirmed against chain yet.
  const [devUsdcBalanceStatus, setDevUsdcBalanceStatus] = useState<"loading" | "ready" | "unavailable">("loading");

  // RPC-resilience pass (see docs/project/PROJECT_STATUS.md): Buy/Sell each
  // track their own submission phase instead of one shared boolean, so the
  // UI can show "Preparing transaction" / "Waiting for wallet approval" /
  // "Submitted -- confirming on DevNet" / "DevNet RPC is temporarily busy --
  // your transaction is still being verified" rather than a single generic
  // spinner -- and so canSubmitNewTransaction has one real state machine to
  // gate against instead of a boolean that can't distinguish "confirming" from
  // "genuinely stuck." A signature is recorded (and shown) the instant
  // submission succeeds, before confirmation even starts.
  const [buyPhase, setBuyPhase] = useState<TxPhase>("idle");
  const [buyPendingSignature, setBuyPendingSignature] = useState<string | null>(null);
  const buyPreDevUsdcRawRef = useRef<bigint>(0n);

  const [sellPhase, setSellPhase] = useState<TxPhase>("idle");
  const [sellPendingSignature, setSellPendingSignature] = useState<string | null>(null);
  const sellPreRtRawRef = useRef<bigint>(0n);

  const buyProcessing = !canSubmitNewTransaction(buyPhase);
  const sellProcessing = !canSubmitNewTransaction(sellPhase);

  // Real (chain-backed) Reserves trade via the DevNet SOL zap adapter instead
  // of the simulated AMM curve -- see docs/protocol/FRONTEND_INTEGRATION.md
  // "Buy/Sell zap architecture". Everything below this flag is the ONLY
  // behavioral branch point; the surrounding JSX structure is unchanged.
  const isOnChain = !!dtr?.onChain;

  /**
   * Re-fetches THIS Reserve's on-chain state + the connected wallet's real
   * balances immediately after a confirmed tx, rather than waiting for
   * RealReserveSync's next poll -- deliberately scoped to the one Reserve
   * that just changed, never every Reserve (see the "targeted refresh"
   * requirement in docs/project/PROJECT_STATUS.md's RPC-resilience pass).
   * Cache keys for this Reserve's mint/the wallet's devUSDC balance are
   * invalidated first so this always reads genuinely fresh values, not a
   * few-seconds-stale cached one -- then re-populates the same cache via
   * getCached so RealReserveSync's next tick reuses this result instead of
   * re-asking the RPC for something we just confirmed.
   */
  async function refreshRealReserveNow() {
    if (!dtr?.onChain) return;
    try {
      const programId = new PublicKey(dtr.onChain.programId);
      const reserveAddress = new PublicKey(dtr.onChain.reserve);
      const mints = dtr.onChain.assets.map((a) => new PublicKey(a.mint));
      const onChain = await withReadConcurrencyLimit(() => fetchReserveOnChain(connection, programId, reserveAddress, mints));
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
        const owner = walletCtx.publicKey;
        const rtMint = dtr.onChain.reserveTokenMint;
        const rtKey = tokenBalanceCacheKey(connection.rpcEndpoint, rtMint, owner.toBase58());
        const devKey = tokenBalanceCacheKey(connection.rpcEndpoint, DEVUSDC_MINT.toBase58(), owner.toBase58());
        invalidateCached(rtKey);
        invalidateCached(devKey);
        const balanceRaw = await getCached(rtKey, BALANCE_CACHE_TTL_MS, () =>
          withReadConcurrencyLimit(() => fetchTokenBalanceRaw(connection, new PublicKey(rtMint), owner)),
        );
        syncRealHolding(dtr.id, balanceRaw, dtr.nav);
        const solLamports = await connection.getBalance(owner, "confirmed");
        syncWalletFromChain({ connected: true, connecting: false, address: owner.toBase58(), provider: wallet.provider, solLamports });
        const devUsdcRaw = await getCached(devKey, BALANCE_CACHE_TTL_MS, () => withReadConcurrencyLimit(() => fetchTokenBalanceRaw(connection, DEVUSDC_MINT, owner)));
        setDevUsdcBalanceRaw(BigInt(devUsdcRaw));
        setDevUsdcBalanceStatus("ready");
      }
    } catch {
      // Best-effort immediate refresh; RealReserveSync's regular poll will catch up regardless.
    }
  }

  // Initial devUSDC balance read (refreshRealReserveNow only runs after a
  // confirmed tx) -- real, read live from chain, never simulated. Routed
  // through the shared cache/dedupe helper so this mount effect and
  // RealReserveSync's own per-Reserve balance loop collapse into one
  // request instead of each firing its own for the same (mint, owner).
  useEffect(() => {
    if (!walletCtx.publicKey) {
      setDevUsdcBalanceRaw(0n);
      setDevUsdcBalanceStatus("loading");
      return;
    }
    const owner = walletCtx.publicKey;
    let cancelled = false;
    setDevUsdcBalanceStatus("loading");
    getCached(tokenBalanceCacheKey(connection.rpcEndpoint, DEVUSDC_MINT.toBase58(), owner.toBase58()), BALANCE_CACHE_TTL_MS, () =>
      withReadConcurrencyLimit(() => fetchTokenBalanceRaw(connection, DEVUSDC_MINT, owner)),
    )
      .then((raw) => {
        if (!cancelled) {
          setDevUsdcBalanceRaw(BigInt(raw));
          setDevUsdcBalanceStatus("ready");
        }
      })
      .catch(() => {
        if (!cancelled) setDevUsdcBalanceStatus("unavailable");
      });
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

  /** One-shot reconciliation for an ambiguous ("unresolved") outcome: does the trader's REAL, freshly-read devUSDC balance actually show the spend this Buy would have made? If so, report success based on that observed on-chain state -- never based on an assumption. Used both automatically right after an AmbiguousConfirmationError and from the pending-verification banner's manual "Check status" button. */
  async function reconcileBuy(signature: string) {
    if (!walletCtx.publicKey || !dtr) return;
    const owner = walletCtx.publicKey;
    try {
      const key = tokenBalanceCacheKey(connection.rpcEndpoint, DEVUSDC_MINT.toBase58(), owner.toBase58());
      invalidateCached(key);
      const freshRaw = await withReadConcurrencyLimit(() => fetchTokenBalanceRaw(connection, DEVUSDC_MINT, owner));
      if (reconcileByBalanceChange(buyPreDevUsdcRawRef.current, BigInt(freshRaw), "decrease")) {
        // The real spent amount is the observed balance delta itself -- the
        // most authoritative figure available here (this whole function
        // only runs because normal confirmation was inconclusive).
        const spentRaw = buyPreDevUsdcRawRef.current - BigInt(freshRaw);
        const spentUsdc = Number(spentRaw > 0n ? spentRaw : 0n) / 10 ** DEVUSDC.decimals;
        setDevUsdcBalanceRaw(BigInt(freshRaw));
        setBuyPhase("confirmed");
        setBuyPendingSignature(null);
        await refreshRealReserveNow();
        recordConfirmedTrade(dtr.id, "buy", spentUsdc / (dtr.nav || 1), spentUsdc);
        setBuyAmount("");
        toast({
          title: "Buy confirmed on Solana DevNet",
          description: (
            <a href={explorerUrl("tx", signature)} target="_blank" rel="noreferrer" className="underline">
              View transaction on Solana Explorer (DevNet) &rarr;
            </a>
          ),
        });
      } else {
        toast({
          title: "Still verifying",
          description: "Your devUSDC balance hasn't changed yet -- the transaction may still be confirming, or may not have landed. Check the signature link before submitting another Buy.",
        });
      }
    } catch {
      // The reconciliation read itself failed (still congested) -- leave the pending-verification banner up; nothing to report either way yet.
    }
  }

  const handleBuy = async () => {
    if (!dtr.onChain) return;
    if (!walletCtx.publicKey) {
      toast({ variant: "destructive", title: "Connect Wallet", description: "Connect a wallet first." });
      return;
    }
    if (!canSubmitNewTransaction(buyPhase)) return; // Defensive -- the button is already disabled in this state.
    // Defensive -- the button is already disabled for this case, but never
    // rely on that alone: a genuine devUSDC -> other-Reserve-Asset
    // conversion isn't deployed on-chain, so Buy only genuinely executes for
    // a Reserve backed 100% by devUSDC. See isGenuineDevUsdcBuySupported.
    if (!isGenuineDevUsdcBuySupported) {
      toast({
        variant: "destructive",
        title: "Buy not available",
        description: "This Reserve isn't backed 100% by devUSDC, and a genuine devUSDC-to-Reserve-Asset conversion isn't deployed yet -- Buy is unavailable for it right now.",
      });
      return;
    }
    // devUSDC is the purchasing currency: the user's real devUSDC balance
    // funds the ENTIRE mint directly via mint_reserve_tokens_in_kind's own
    // transfer_checked -- never a simulated conversion, never a
    // faucet/authority-funded leg (guaranteed by the check above: every
    // asset in this Reserve is devUSDC itself).
    const devUsdcAmountRaw = BigInt(Math.floor(numBuyAmount * 10 ** DEVUSDC.decimals));
    // Checked against the trader's own real, already-fetched balance BEFORE
    // any network call -- an honest, immediate "insufficient devUSDC"
    // message, distinct from an RPC-congestion or swap-authority-SOL
    // failure, and cheaper than letting an on-chain transfer_checked fail.
    if (devUsdcAmountRaw > devUsdcBalanceRaw) {
      toast({
        variant: "destructive",
        title: "Insufficient devUSDC",
        description: `This wallet holds ${(Number(devUsdcBalanceRaw) / 10 ** DEVUSDC.decimals).toLocaleString()} devUSDC, less than the ${numBuyAmount.toLocaleString()} devUSDC requested. Claim more from the faucet or reduce the amount.`,
      });
      return;
    }
    setBuyPhase("preparing");
    setBuyPendingSignature(null);
    buyPreDevUsdcRawRef.current = devUsdcBalanceRaw;
    useAppStore.getState().setTxInFlight(true);
    try {
      const { signature } = await executeBuyZapDevUsdc({
        connection,
        wallet: walletCtx,
        reserveAddress: dtr.onChain.reserve,
        assetMints: dtr.onChain.assets.map((a) => a.mint),
        userPubkey: walletCtx.publicKey,
        devUsdcAmountRaw,
        onProgress: (e) => setBuyPhase(e.phase === "awaiting-wallet" ? "awaiting-wallet" : "confirming"),
      });
      setBuyPhase("confirmed");
      await refreshRealReserveNow();
      const spentUsdc = Number(devUsdcAmountRaw) / 10 ** DEVUSDC.decimals;
      recordConfirmedTrade(dtr.id, "buy", spentUsdc / (dtr.nav || 1), spentUsdc);
      setBuyAmount("");
      toast({
        title: "Buy confirmed on Solana DevNet",
        description: (
          <a href={explorerUrl("tx", signature)} target="_blank" rel="noreferrer" className="underline">
            View transaction on Solana Explorer (DevNet) &rarr;
          </a>
        ),
      });
    } catch (e) {
      if (e instanceof AmbiguousConfirmationError) {
        setBuyPhase("unresolved");
        setBuyPendingSignature(e.signature);
        toast({
          title: "DevNet RPC is temporarily busy",
          description: "No confirmation could be verified yet -- your transaction may still be confirming. Checking your real balance now.",
        });
        await reconcileBuy(e.signature);
      } else {
        setBuyPhase("failed");
        // Classify by the server's own distinguishing error code first --
        // never surface a raw RPC error string (e.g. "429 Connection rate
        // limits exceeded") as-is, and never let a swap-authority-side SOL
        // shortfall read as if the CONNECTED WALLET lacked SOL.
        if (e instanceof ZapBuildError && e.code === "rpc_congested") {
          toast({ variant: "destructive", title: "DevNet RPC congested", description: "Solana DevNet's RPC endpoint is temporarily rate-limited. Please wait a few seconds and try again." });
        } else if (e instanceof ZapBuildError && e.code === "swap_authority_low_sol") {
          toast({ variant: "destructive", title: "Swap adapter temporarily low on SOL", description: e.message });
        } else if (e instanceof ZapBuildError && e.code === "conversion_unsupported") {
          toast({ variant: "destructive", title: "Buy not available", description: e.message });
        } else {
          toast({ variant: "destructive", title: "Buy Failed", description: e instanceof Error ? e.message : "The DevNet swap failed." });
        }
      }
    } finally {
      useAppStore.getState().setTxInFlight(false);
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

  /** Same reasoning as reconcileBuy, but for the redeemed Reserve Token balance decreasing (Sell burns/redeems it) instead of devUSDC. */
  async function reconcileSell(signature: string) {
    if (!walletCtx.publicKey || !dtr?.onChain) return;
    const owner = walletCtx.publicKey;
    const rtMint = dtr.onChain.reserveTokenMint;
    try {
      const key = tokenBalanceCacheKey(connection.rpcEndpoint, rtMint, owner.toBase58());
      invalidateCached(key);
      const freshRaw = await withReadConcurrencyLimit(() => fetchTokenBalanceRaw(connection, new PublicKey(rtMint), owner));
      if (reconcileByBalanceChange(sellPreRtRawRef.current, BigInt(freshRaw), "decrease")) {
        // Real redeemed amount is the observed Reserve Token balance delta --
        // the most authoritative figure available (normal confirmation was
        // inconclusive, which is why this reconciliation path ran at all).
        const redeemedRaw = sellPreRtRawRef.current - BigInt(freshRaw);
        const redeemedTokens = Number(redeemedRaw > 0n ? redeemedRaw : 0n) / 1_000_000;
        setSellPhase("confirmed");
        setSellPendingSignature(null);
        await refreshRealReserveNow();
        recordConfirmedTrade(dtr.id, "sell", redeemedTokens, redeemedTokens * (dtr.nav || 1));
        setSellAmount("");
        toast({
          title: "Sell confirmed on Solana DevNet",
          description: (
            <a href={explorerUrl("tx", signature)} target="_blank" rel="noreferrer" className="underline">
              View transaction on Solana Explorer (DevNet) &rarr;
            </a>
          ),
        });
      } else {
        toast({
          title: "Still verifying",
          description: "Your Reserve Token balance hasn't changed yet -- the transaction may still be confirming, or may not have landed. Check the signature link before submitting another Sell.",
        });
      }
    } catch {
      // Reconciliation read itself failed (still congested) -- leave the pending-verification banner up.
    }
  }

  const handleSell = async () => {
    if (!dtr.onChain) return;
    if (!walletCtx.publicKey) {
      toast({ variant: "destructive", title: "Connect Wallet", description: "Connect a wallet first." });
      return;
    }
    if (!canSubmitNewTransaction(sellPhase)) return; // Defensive -- the button is already disabled in this state.
    if (numSellAmount > (holding?.tokenBalance ?? 0)) {
      toast({
        variant: "destructive",
        title: "Insufficient Reserve Tokens",
        description: `This wallet holds ${(holding?.tokenBalance ?? 0).toLocaleString()} ${dtr.ticker}, less than the ${numSellAmount.toLocaleString()} requested.`,
      });
      return;
    }
    setSellPhase("preparing");
    setSellPendingSignature(null);
    useAppStore.getState().setTxInFlight(true);
    try {
      sellPreRtRawRef.current = BigInt(
        await withReadConcurrencyLimit(() => fetchTokenBalanceRaw(connection, new PublicKey(dtr.onChain!.reserveTokenMint), walletCtx.publicKey!)),
      );
      const reserveTokensToRedeem = BigInt(Math.floor(numSellAmount * 1_000_000));
      const { signature } = await executeSellZap({
        connection,
        wallet: walletCtx,
        reserveAddress: dtr.onChain.reserve,
        assetMints: dtr.onChain.assets.map((a) => a.mint),
        userPubkey: walletCtx.publicKey,
        reserveTokensToRedeem,
        onProgress: (e) => setSellPhase(e.phase === "awaiting-wallet" ? "awaiting-wallet" : "confirming"),
      });
      setSellPhase("confirmed");
      await refreshRealReserveNow();
      recordConfirmedTrade(dtr.id, "sell", numSellAmount, numSellAmount * (dtr.nav || 1));
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
      if (e instanceof AmbiguousConfirmationError) {
        setSellPhase("unresolved");
        setSellPendingSignature(e.signature);
        toast({
          title: "DevNet RPC is temporarily busy",
          description: "No confirmation could be verified yet -- your transaction may still be confirming. Checking your real balance now.",
        });
        await reconcileSell(e.signature);
      } else {
        setSellPhase("failed");
        if (e instanceof ZapBuildError && e.code === "rpc_congested") {
          toast({ variant: "destructive", title: "DevNet RPC congested", description: "Solana DevNet's RPC endpoint is temporarily rate-limited. Please wait a few seconds and try again." });
        } else if (e instanceof ZapBuildError && e.code === "swap_authority_low_sol") {
          toast({ variant: "destructive", title: "Swap adapter temporarily low on SOL", description: e.message });
        } else {
          toast({ variant: "destructive", title: "Sell Failed", description: e instanceof Error ? e.message : "The DevNet swap failed." });
        }
      }
    } finally {
      useAppStore.getState().setTxInFlight(false);
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

  // devUSDC is SSR.fun's universal purchasing/settlement currency -- it is
  // NEVER required to be one of a Reserve's own underlying Reserve Assets.
  // The wallet's full real devUSDC balance is what's available to spend on
  // ANY purchasable Reserve, regardless of that Reserve's composition (see
  // docs/project/DECISION_LOG.md's Buy architecture correction). What differs
  // per-Reserve is whether Buy can genuinely EXECUTE right now -- see
  // isGenuineDevUsdcBuySupported below.
  const devUsdcBalanceHuman = Number(devUsdcBalanceRaw) / 10 ** DEVUSDC.decimals;
  // "Available" for the quick-select buttons: always the trader's real,
  // chain-confirmed devUSDC balance -- never a hardcoded fallback, and never
  // gated on this Reserve's asset composition.
  const buyAvailable = isOnChain ? buyAvailableFromDevUsdcBalance(devUsdcBalanceHuman) : 0;
  const buyInsufficientBalance = isOnChain && numBuyAmount > devUsdcBalanceHuman;
  // True when EVERY one of this Reserve's registered assets is devUSDC
  // itself -- the only composition with a genuine, fabrication-free path in
  // both directions today: mint_reserve_tokens_in_kind's own transfer_checked
  // moves the user's real devUSDC straight into the vault on Buy, and
  // redeem_reserve_tokens_in_kind deposits real devUSDC straight back into
  // the user's wallet on Sell -- no server-side minting, wrapping, or
  // fixed-price zap of any kind is involved for either direction. Any other
  // composition (mockX/Y/Z, wrapped SOL) has no genuine devUSDC <-> Reserve-Asset
  // conversion deployed on-chain: Buy is disabled for those rather than
  // silently minting those legs for free, and Sell still uses the existing
  // fixed-rate SOL settlement (unchanged in this pass -- see DEC-0054/0065).
  const isPureDevUsdcReserve =
    isOnChain && !!dtr.onChain && isReservePureDevUsdc(dtr.onChain.assets.map((a) => a.mint), DEVUSDC.mint);
  const isGenuineDevUsdcBuySupported = isPureDevUsdcReserve;
  // Reason the 25/50/75/Max quick-select buttons can't be used right now, if
  // any -- distinct from buyProcessing (mid-transaction) so the UI can show
  // an honest "why" instead of a plain disabled control. Deliberately NOT
  // gated on Reserve composition -- filling the input with a real
  // balance-derived amount is always meaningful, even for a Reserve whose
  // Buy execution is separately disabled below.
  const buyPctUnavailableReason: string | null = !wallet.connected
    ? null // handled by the existing !wallet.connected disabled check
    : devUsdcBalanceStatus === "loading"
      ? "Confirming your real devUSDC balance..."
      : devUsdcBalanceStatus === "unavailable"
        ? "Your devUSDC balance couldn't be read from DevNet right now."
        : null;

  const setBuyPct = (pct: number) => {
    if (wallet.connected && devUsdcBalanceStatus === "ready") {
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
                  <Badge variant="outline" className="bg-background/50 border-border">{normalizeReserveCategory(dtr.category)}</Badge>
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
                        {!wallet.connected
                          ? "—"
                          : !isOnChain
                            ? formatUsdc(buyAvailable)
                            : devUsdcBalanceStatus === "loading"
                              ? "Loading..."
                              : devUsdcBalanceStatus === "unavailable"
                                ? "Unavailable"
                                : `${devUsdcBalanceHuman.toFixed(2)} devUSDC`}
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
                        onChange={(e) => {
                          setBuyAmount(e.target.value);
                          if (canSubmitNewTransaction(buyPhase) && buyPhase !== "idle") {
                            setBuyPhase("idle");
                            setBuyPendingSignature(null);
                          }
                        }}
                        disabled={!wallet.connected || buyProcessing}
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
                          disabled={!wallet.connected || buyProcessing || !!buyPctUnavailableReason}
                          title={buyPctUnavailableReason ?? undefined}
                        >
                          {pct === 1 ? "Max" : `${pct * 100}%`}
                        </Button>
                      ))}
                    </div>
                    {wallet.connected && buyPctUnavailableReason && (
                      <p className="text-[11px] text-muted-foreground/80 -mt-2">{buyPctUnavailableReason}</p>
                    )}

                    {isOnChain && isGenuineDevUsdcBuySupported ? (
                      <div className="p-4 bg-muted/20 rounded-lg space-y-3 border border-border/40 mt-6">
                        <div className="flex justify-between text-sm">
                          <span className="text-muted-foreground flex items-center gap-1">
                            Settlement asset
                            <Tooltip>
                              <TooltipTrigger><Info className="w-3 h-3" /></TooltipTrigger>
                              <TooltipContent>devUSDC ("SSR Test USD") is the DevNet settlement asset -- 1 devUSDC = $1 by design, no price feed involved. This Reserve is backed 100% by devUSDC, so your entire input is genuinely deposited into its vault.</TooltipContent>
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
                      </div>
                    ) : isOnChain ? (
                      <div className="p-4 bg-muted/20 rounded-lg space-y-3 border border-destructive/30 mt-6">
                        <p className="text-sm font-semibold text-destructive">Buy not available for this Reserve</p>
                        <p className="text-xs text-muted-foreground">
                          devUSDC is SSR.fun's purchasing currency, but converting it into this Reserve's other underlying assets isn't supported on-chain yet.
                          Buy currently only works for a Reserve backed 100% by devUSDC.
                        </p>
                        <div className="pt-2 border-t border-border/50 space-y-1.5">
                          <p className="text-xs font-semibold text-muted-foreground">This Reserve's actual composition</p>
                          {dtr.onChain!.assets.map((a) => {
                            const fraction = dtr.onChain!.totalTargetWeightBps > 0 ? a.weightBps / dtr.onChain!.totalTargetWeightBps : 0;
                            return (
                              <div key={a.mint} className="flex justify-between text-xs">
                                <span>{a.symbol}</span>
                                <span className="text-muted-foreground">{(fraction * 100).toFixed(0)}% target weight</span>
                              </div>
                            );
                          })}
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

                    {buyPendingSignature && (
                      <div className="rounded-lg border border-dashed p-3 text-sm space-y-2" style={{ borderColor: "var(--warn, #d9a13c)" }}>
                        <p>DevNet RPC is temporarily busy -- your Buy transaction is still being verified. No new transaction has been submitted for it.</p>
                        <a href={explorerUrl("tx", buyPendingSignature)} target="_blank" rel="noreferrer" className="underline">
                          View signature on Solana Explorer (DevNet) &rarr;
                        </a>
                        <div>
                          <Button size="sm" variant="outline" onClick={() => void reconcileBuy(buyPendingSignature)}>
                            Check status
                          </Button>
                        </div>
                      </div>
                    )}

                    <Button
                      className="w-full h-12 text-lg font-bold shadow-lg shadow-primary/20"
                      onClick={onBuyClick}
                      disabled={
                        !wallet.connected ||
                        buyProcessing ||
                        numBuyAmount <= 0 ||
                        buyInsufficientBalance ||
                        (isOnChain && !isGenuineDevUsdcBuySupported)
                      }
                    >
                      {txPhaseLabel(buyPhase) ? (
                        <div className="flex items-center gap-2">
                          {(buyPhase === "preparing" || buyPhase === "awaiting-wallet" || buyPhase === "confirming" || buyPhase === "submitted") && (
                            <div className="w-4 h-4 border-2 border-background border-t-transparent rounded-full animate-spin" />
                          )}
                          {txPhaseLabel(buyPhase)}
                        </div>
                      ) : !wallet.connected ? (
                        "Connect Wallet to Trade"
                      ) : isOnChain && !isGenuineDevUsdcBuySupported ? (
                        "Buy Not Yet Supported"
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
                        onChange={(e) => {
                          setSellAmount(e.target.value);
                          if (canSubmitNewTransaction(sellPhase) && sellPhase !== "idle") {
                            setSellPhase("idle");
                            setSellPendingSignature(null);
                          }
                        }}
                        disabled={!wallet.connected || sellProcessing || !holding}
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
                          disabled={!wallet.connected || sellProcessing || !holding}
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
                        {isPureDevUsdcReserve ? (
                          <p className="text-[11px] text-muted-foreground/80 pt-1">
                            This Reserve is backed 100% by devUSDC -- redemption deposits real devUSDC directly into your wallet. No SOL
                            conversion, swap adapter, or fixed price is involved.
                          </p>
                        ) : (
                          <div className="pt-3 border-t border-border/50 space-y-1.5">
                            <div className="flex justify-between text-xs text-muted-foreground">
                              <span className="flex items-center gap-1">
                                Current settlement (secondary, fixed-rate)
                                <Tooltip>
                                  <TooltipTrigger><Info className="w-3 h-3" /></TooltipTrigger>
                                  <TooltipContent>
                                    This DevNet test environment currently settles Sell by redeeming in-kind (above) and then converting
                                    that value to SOL at a FIXED DevNet test rate (${SOL_TEST_PRICE_USD.toFixed(2)}/SOL) -- not a real market
                                    quote or an actual MOCX/asset-to-SOL swap. A genuine devUSDC-denominated settlement for a mixed-asset
                                    Reserve requires the same conversion layer Buy is currently missing (see DEC-0054/0065).
                                  </TooltipContent>
                                </Tooltip>
                              </span>
                              <span className="font-merge-mono">~{estSolOut.toFixed(5)} SOL @ fixed ${SOL_TEST_PRICE_USD.toFixed(2)}/SOL</span>
                            </div>
                          </div>
                        )}
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

                    {sellPendingSignature && (
                      <div className="rounded-lg border border-dashed p-3 text-sm space-y-2" style={{ borderColor: "var(--warn, #d9a13c)" }}>
                        <p>DevNet RPC is temporarily busy -- your Sell transaction is still being verified. No new transaction has been submitted for it.</p>
                        <a href={explorerUrl("tx", sellPendingSignature)} target="_blank" rel="noreferrer" className="underline">
                          View signature on Solana Explorer (DevNet) &rarr;
                        </a>
                        <div>
                          <Button size="sm" variant="outline" onClick={() => void reconcileSell(sellPendingSignature)}>
                            Check status
                          </Button>
                        </div>
                      </div>
                    )}

                    <Button
                      variant="destructive"
                      className="w-full h-12 text-lg font-bold shadow-lg shadow-destructive/20"
                      onClick={onSellClick}
                      disabled={!wallet.connected || sellProcessing || numSellAmount <= 0 || numSellAmount > (holding?.tokenBalance || 0)}
                    >
                      {txPhaseLabel(sellPhase) ? (
                        <div className="flex items-center gap-2">
                          {(sellPhase === "preparing" || sellPhase === "awaiting-wallet" || sellPhase === "confirming" || sellPhase === "submitted") && (
                            <div className="w-4 h-4 border-2 border-background border-t-transparent rounded-full animate-spin" />
                          )}
                          {txPhaseLabel(sellPhase)}
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
