import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { useParams, Link } from "wouter";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import {
  DEVUSDC_MINT,
  isReserveTradable,
  fetchReserveOnChain,
  fetchTokenBalanceRaw,
  discoverDelegatesForReserve,
  computeRedemptionEntitlements,
  computeDirectReserveTokensRequested,
  computeNetMintOutput,
  findReserve,
  findProtocolConfig,
  WRAPPED_SOL_MINT,
  type ZapAssetLeg,
} from "@ssr/sdk";
import { useAppStore, isManagerOrDelegate } from "@/store/useAppStore";
import { resolveDtrPageState, parseOnChainReserveId, TEST_ASSET_PRICES_USD, onChainDelegateFromDiscovered, computeMarketCap, RESERVE_TOKEN_DECIMALS, type AssetPriceInfo } from "@/lib/onChainReserve";
import { fetchAssetPricesUsd } from "@/lib/assetPricing";
import { buildDelegateCandidateWallets } from "@/lib/delegateDiscoveryCandidates";
import { executeBuyZapDevUsdc, executeSellZap, ZapBuildError, describeUnknownSignerMessage } from "@/lib/zapClient";
import { executeDirectMint, executeDirectRedeem } from "@/lib/directClient";
import { executeMultiAssetBuyMainnet, usdToReserveTokensRequested, MultiAssetBuyError } from "@/lib/multiAssetBuyClient";
import { executeMultiAssetSellMainnet } from "@/lib/multiAssetSellClient";
import { explorerUrl, IS_MAINNET, SSR_PROGRAM_ID, MAINNET_TREASURY_VAULT, MAINNET_USDC_MINT } from "@/lib/solana-config";
import { transactionConfirmedToast } from "@/components/TransactionConfirmation";
import {
  AmbiguousConfirmationError,
  BALANCE_CACHE_TTL_MS,
  canSubmitNewTransaction,
  getCached,
  invalidateCached,
  reconcileByBalanceChange,
  tokenBalanceCacheKey,
  txPhaseLabel,
  txPhaseShortLabel,
  withReadConcurrencyLimit,
  type TxPhase,
} from "@/lib/rpcResilience";
import {
  buildLineSeries,
  calcTokensReceived,
  calcUsdcReceived,
  buyAvailableFromDevUsdcBalance,
  isReservePureDevUsdc,
  formatUsdc,
  formatAssetPriceUsd,
  formatUsdcOrUnavailable,
  formatTokenAmount,
  sampleLinePoints,
  calcAssetPnlPct,
  calcAllTimeChangePct,
} from "@/lib/calculations";
import { normalizeReserveCategory, type ChartTimeframe, type OnChainReserveMeta } from "@/lib/types";
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  ComposedChart,
  Bar,
  ReferenceLine,
  XAxis,
  YAxis,
  Tooltip as RechartsTooltip,
} from "recharts";
import { format } from "date-fns";
import { ChevronLeft, Layers, BarChart3, Activity, PenLine } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { InfoTip } from "@/components/InfoTip";
import { useToast } from "@/hooks/use-toast";
import { useLandingStats } from "@/hooks/useLandingStats";
import { ChartTimeframeSelector, DEFAULT_CHART_TIMEFRAME } from "@/components/ChartTimeframeSelector";
import { applyDesignDemo, demoPriceHistory, isDesignDemoEnabled } from "@/lib/designDemo";
import { buildCandleSeries, ema, type Candle } from "@/lib/candles";
import { WeightPill, SSR_TILE_COLORS } from "@/components/WeightTreemap";

/* Candlestick glyph for the Recharts range-Bar: the bar's y/height map the
   candle's [low, high] band, so open/close are interpolated inside it. A
   flat candle (high === low) renders as a doji tick instead of vanishing. */
function CandleShape(props: {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  payload?: Candle;
}) {
  const { x = 0, y = 0, width = 0, height = 0, payload } = props;
  if (!payload) return null;
  const { open, close, high, low, up } = payload;
  const color = up ? "hsl(var(--positive))" : "hsl(var(--destructive))";
  const cx = x + width / 2;
  const span = high - low;
  const yAt = (v: number) => (span > 0 ? y + ((high - v) / span) * height : y);
  const bodyTop = yAt(Math.max(open, close));
  const bodyH = Math.max(yAt(Math.min(open, close)) - bodyTop, 1.5);
  const bodyW = Math.max(Math.min(width * 0.62, 13), 3);
  return (
    <g>
      <line x1={cx} x2={cx} y1={y} y2={y + Math.max(height, 1)} stroke={color} strokeWidth={1.5} strokeLinecap="round" />
      <rect x={cx - bodyW / 2} y={bodyTop} width={bodyW} height={bodyH} rx={1.5} fill={color} />
    </g>
  );
}

function CandleTooltip({ active, payload }: { active?: boolean; payload?: Array<{ payload: Candle & { dateStr: string } }> }) {
  if (!active || !payload?.length) return null;
  const c = payload[0].payload;
  return (
    <div className="rounded-xl border border-card-border bg-card px-3 py-2 shadow-md text-xs">
      <p className="text-muted-foreground mb-1">{c.dateStr}</p>
      {([["Open", c.open], ["High", c.high], ["Low", c.low], ["Close", c.close]] as const).map(([k, v]) => (
        <p key={k} className="flex justify-between gap-4">
          <span className="text-muted-foreground">{k}</span>
          <span className={`font-merge-mono font-semibold ${c.up ? "text-positive" : "text-destructive"}`}>{formatUsdc(v)}</span>
        </p>
      ))}
    </div>
  );
}

/* Inline per-asset chart for the expandable composition rows: the same clean
   line treatment as Price History's Line view (thin primary line over a soft
   fading fill) — no candles, no EMA — sized for an expanded table row. */
function AssetMiniChart({ seed, endPrice, synthetic }: { seed: string; endPrice: number; synthetic: boolean }) {
  const data = useMemo(() => {
    const now = Date.now();
    const points = synthetic
      ? demoPriceHistory(seed, endPrice, now)
      : [
          { t: now - 30 * 86_400_000, price: endPrice },
          { t: now, price: endPrice },
        ];
    return sampleLinePoints(points, 140).map((p) => ({ ...p, dateStr: format(new Date(p.t), "MMM d") }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seed, endPrice, synthetic]);
  if (data.length < 2) return null;
  const lo = Math.min(...data.map((d) => d.price));
  const hi = Math.max(...data.map((d) => d.price));
  const pad = Math.max((hi - lo) * 0.06, hi * 0.005);
  const gradId = `miniPriceGradient-${seed.replace(/[^a-zA-Z0-9]/g, "")}`;
  return (
    <ResponsiveContainer width="100%" height="100%">
      <AreaChart data={data} margin={{ top: 12, right: 8, bottom: 8, left: 16 }}>
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#97abef" stopOpacity={0.3} />
            <stop offset="100%" stopColor="#97abef" stopOpacity={0} />
          </linearGradient>
        </defs>
        <XAxis dataKey="dateStr" stroke="hsl(var(--muted-foreground))" fontSize={11} tickLine={false} axisLine={false} minTickGap={44} />
        <YAxis
          orientation="right"
          domain={[lo - pad, hi + pad]}
          stroke="hsl(var(--muted-foreground))"
          fontSize={11}
          tickCount={3}
          tickLine={false}
          axisLine={false}
          tickFormatter={(v: number) => formatAssetPriceUsd(v)}
          width={70}
        />
        <Area
          type="monotone"
          dataKey="price"
          stroke="hsl(var(--primary))"
          strokeWidth={2}
          fill={`url(#${gradId})`}
          dot={false}
          activeDot={false}
          isAnimationActive={false}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}

/* Chart event marker: a subtle pill riding a dashed reference line where a
   creator note landed (fee change, rebalance, …). Clicking it jumps to the
   "Notes from the Creator" section at the bottom of the page. */
function NoteMarkerLabel(props: { viewBox?: { x: number; y: number; height: number }; text?: string; level?: number }) {
  const { viewBox, text = "", level = 0 } = props;
  if (!viewBox) return null;
  const width = text.length * 6.4 + 18;
  const cy = viewBox.y + viewBox.height - 12 - level * 26;
  return (
    <g
      style={{ cursor: "pointer" }}
      onClick={() => document.getElementById("section-notes")?.scrollIntoView({ behavior: "smooth", block: "start" })}
      role="link"
      aria-label={`${text} — jump to Notes from the Creator`}
    >
      <rect x={viewBox.x - width / 2} y={cy - 11} rx={11} ry={11} width={width} height={22} fill="hsl(var(--card))" stroke="hsl(var(--border))" />
      <text x={viewBox.x} y={cy + 3.5} textAnchor="middle" fontSize={10.5} fontWeight={600} fill="hsl(var(--muted-foreground))">
        {text}
      </text>
    </g>
  );
}

/* Section navigation: one long light pill spanning the chart column, holding
   a small pill per page section. A rounded highlight slides between items as
   the cursor moves across them (fading out on leave), and clicking scrolls
   smoothly to that section. */
const SECTION_NAV_ITEMS = [
  { id: "section-chart", label: "Chart" },
  { id: "section-about", label: "About" },
  { id: "section-composition", label: "Composition" },
  { id: "section-addresses", label: "Addresses" },
  { id: "section-market", label: "Market" },
  { id: "section-notes", label: "Notes" },
] as const;

function SectionNav() {
  const containerRef = useRef<HTMLDivElement>(null);
  const [highlight, setHighlight] = useState({ left: 0, width: 0, visible: false });
  const moveTo = (el: HTMLElement) => {
    const container = containerRef.current;
    if (!container) return;
    const r = el.getBoundingClientRect();
    const cr = container.getBoundingClientRect();
    setHighlight({ left: r.left - cr.left, width: r.width, visible: true });
  };
  return (
    <nav
      ref={containerRef}
      aria-label="Page sections"
      onMouseLeave={() => setHighlight((h) => ({ ...h, visible: false }))}
      className="relative flex items-center flex-1 min-w-0 h-10 px-1.5 rounded-full bg-card/70 border border-border/50"
    >
      <div
        aria-hidden="true"
        className="absolute top-1.5 bottom-1.5 rounded-full bg-secondary pointer-events-none transition-all duration-200 ease-out"
        style={{ left: highlight.left, width: highlight.width, opacity: highlight.visible ? 1 : 0 }}
      />
      {SECTION_NAV_ITEMS.map((item) => (
        <button
          key={item.id}
          type="button"
          onMouseEnter={(e) => moveTo(e.currentTarget)}
          onClick={() => document.getElementById(item.id)?.scrollIntoView({ behavior: "smooth", block: "start" })}
          className="relative z-10 flex-1 h-7 rounded-full text-xs font-medium text-muted-foreground hover:text-foreground whitespace-nowrap transition-colors"
        >
          {item.label}
        </button>
      ))}
    </nav>
  );
}

/** Axis tick label, chosen by how fine the selected timeframe's resolution is. */
function timeframeTickFormat(t: number, timeframe: ChartTimeframe): string {
  if (timeframe === "1s" || timeframe === "1m") return format(new Date(t), "HH:mm:ss");
  if (timeframe === "5m" || timeframe === "1h" || timeframe === "4h" || timeframe === "24h") return format(new Date(t), "HH:mm");
  return format(new Date(t), "MMM d");
}

// Cluster-aware settlement asset: DevNet's zero-value devUSDC test token vs
// Mainnet's real USDC -- both 6 decimals, so only the mint address and
// display label actually differ. Mainnet Reserves are USDC-only for this
// launch (see docs/project/DECISION_LOG.md DEC-0116/DEC-0117); every
// devUSDC-branded label/balance in this file resolves through these three
// constants so the live product never shows "devUSDC" or DevNet-only copy.
const SETTLEMENT_MINT = IS_MAINNET ? new PublicKey(MAINNET_USDC_MINT) : DEVUSDC_MINT;
const SETTLEMENT_DECIMALS = 6;
const SETTLEMENT_SYMBOL = IS_MAINNET ? "USDC" : "devUSDC";
const CLUSTER_LABEL = IS_MAINNET ? "Mainnet" : "DevNet";

/**
 * The Buy INPUT asset is always the settlement currency (real USDC on
 * Mainnet, devUSDC on DevNet) -- the product's funding invariant (DEC-0151,
 * see docs/protocol/FRONTEND_INTEGRATION.md's "Mainnet funding invariant"):
 * a user supplies only USDC; any Reserve whose composition isn't purely USDC
 * is bought through the USDC-funded path (multiAssetBuyClient.ts's
 * executeMultiAssetBuyMainnet -- USDC -> Jupiter swap per non-USDC leg ->
 * deposit -> mint), which works identically for one leg or ten. An earlier
 * version of this function made a single-asset non-USDC Reserve (e.g.
 * "alpha", 100% SSR) demand the user ALREADY HOLD its underlying asset --
 * honest for the old direct-deposit path it routed to, but a violation of
 * the invariant this pass establishes; that path now serves only pure-USDC
 * Reserves, for which the settlement asset is trivially correct.
 */
function resolveBuyAsset(_onChain: OnChainReserveMeta | undefined): { mint: PublicKey; decimals: number; symbol: string } {
  return { mint: SETTLEMENT_MINT, decimals: SETTLEMENT_DECIMALS, symbol: SETTLEMENT_SYMBOL };
}

export function DTRDetail() {
  const { dtrId } = useParams();
  const { wallet, holdings, dtrs, quarantinedReserves, chainDiscoveryStatus, mergeOnChainReserve, setOnChainDelegates, syncRealHolding, syncWalletFromChain, recordConfirmedTrade, setWalletModalOpen } = useAppStore();
  const pageState = resolveDtrPageState(dtrId, dtrs, quarantinedReserves, chainDiscoveryStatus);
  const dtr = pageState.kind === "found" ? pageState.dtr : undefined;
  const quarantined = pageState.kind === "quarantined" ? pageState.info : undefined;
  const { toast } = useToast();
  const { connection } = useConnection();

  // Covers the rarer gap resolveDtrPageState's chainDiscoveryStatus check
  // doesn't: a discovery pass already completed ("ready") but this
  // particular (very recently created/resumed) Reserve wasn't included in
  // it yet -- the next background poll will pick it up, but a direct-link
  // visitor shouldn't see a dead-end "Reserve Not Found" in the meantime.
  // One bounded, existence-only on-chain read (no asset resolution needed,
  // hence the empty candidate-mint list) decides whether to keep showing the
  // "still indexing" panel or the genuine terminal state.
  const [directCheck, setDirectCheck] = useState<"idle" | "checking" | "confirmed-absent">("idle");
  useEffect(() => {
    if (pageState.kind !== "not-found") {
      if (directCheck !== "idle") setDirectCheck("idle");
      return;
    }
    const reserveId = parseOnChainReserveId(dtrId);
    if (reserveId === null) return; // not a real on-chain id shape -- genuinely nothing to check.
    let cancelled = false;
    setDirectCheck("checking");
    const [reserveAddress] = findReserve(reserveId, SSR_PROGRAM_ID);
    fetchReserveOnChain(connection, SSR_PROGRAM_ID, reserveAddress, [])
      .then((onChain) => {
        if (cancelled) return;
        // Found on-chain but not yet in the store: leave state as
        // "checking" (rendered identically to "indexing") -- RealReserveSync's
        // next poll will merge it in and this component re-renders normally.
        // Only a confirmed absence should ever unlock the terminal state.
        if (!onChain) setDirectCheck("confirmed-absent");
      })
      .catch(() => {
        // Transport failure -- inconclusive, not confirmation of absence.
        // Leave as "checking" rather than falsely declaring not-found.
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageState.kind, dtrId, connection]);
  const landingStats = useLandingStats();
  const reserveStats = dtr?.onChain ? landingStats.data?.perReserve[dtr.onChain.reserve] : undefined;
  const walletCtx = useWallet();

  // Chart timeframe is local UI state -- it persists across live store updates
  // (trades, price ticks) since this component only re-renders, never remounts.
  const [timeframe, setTimeframe] = useState<ChartTimeframe>(DEFAULT_CHART_TIMEFRAME);

  // Trading state
  const [tradeTab, setTradeTab] = useState<"buy" | "sell">("buy");
  const [buyAmount, setBuyAmount] = useState("");
  const [sellAmount, setSellAmount] = useState("");
  // Which percentage pill (0.25/0.5/0.75/1) is currently selected per side —
  // stays highlighted after the click; cleared when the amount is typed by hand.
  const [buyPctSelected, setBuyPctSelected] = useState<number | null>(null);
  const [sellPctSelected, setSellPctSelected] = useState<number | null>(null);
  // SETTLEMENT_MINT is the settlement asset for mint (Buy) -- a real
  // balance read from chain, never simulated. See SETTLEMENT_MINT's own
  // header comment above for the DevNet/Mainnet split.
  const [settlementBalanceRaw, setSettlementBalanceRaw] = useState<bigint>(0n);
  // Tracks whether the real settlement-asset balance read has actually
  // resolved yet, so the percentage quick-select buttons can be disabled
  // (and show a "Loading balance..."/"Balance unavailable" state) instead of
  // computing off a default 0n that hasn't been confirmed against chain yet.
  const [settlementBalanceStatus, setSettlementBalanceStatus] = useState<"loading" | "ready" | "unavailable">("loading");

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
  // Synchronous same-tick duplicate-click/concurrent-attempt guard for Buy
  // (DEC-0154) -- see handleBuyMultiAssetMainnet; React state alone leaves a
  // pre-render window a fast double-click can slip through.
  const buySubmittingRef = useRef(false);
  const [buyPendingSignature, setBuyPendingSignature] = useState<string | null>(null);
  const buyPreSettlementRawRef = useRef<bigint>(0n);
  // Fine-grained step label for a multi-asset Buy (multiAssetBuyClient.ts's
  // executeMultiAssetBuyMainnet spans several separately-confirmed
  // transactions: wrap SOL, one swap per non-USDC/non-SOL leg, then the
  // final mint) -- shown alongside buyPhase's own generic in-flight label
  // (see txPhaseLabel) rather than replacing it, so canSubmitNewTransaction/
  // the button's disabled state keep working unchanged.
  const [multiAssetBuyStep, setMultiAssetBuyStep] = useState<string | null>(null);

  const [sellPhase, setSellPhase] = useState<TxPhase>("idle");
  const [sellPendingSignature, setSellPendingSignature] = useState<string | null>(null);
  const sellPreRtRawRef = useRef<bigint>(0n);
  // Fine-grained step label for a USDC-settled multi-asset Sell -- same
  // short-label-in-button / full-sentence-below-it split as the Buy side.
  const [multiAssetSellStep, setMultiAssetSellStep] = useState<string | null>(null);

  const buyProcessing = !canSubmitNewTransaction(buyPhase);
  const sellProcessing = !canSubmitNewTransaction(sellPhase);

  // Real (chain-backed) Reserves trade via the DevNet SOL zap adapter instead
  // of the simulated AMM curve -- see docs/protocol/FRONTEND_INTEGRATION.md
  // "Buy/Sell zap architecture". Everything below this flag is the ONLY
  // behavioral branch point; the surrounding JSX structure is unchanged.
  const isOnChain = !!dtr?.onChain;
  // WD-01 fix: a wound-down Reserve stays visible (reserveEligibility.ts no
  // longer quarantines it) instead of disappearing -- Buy is disabled here
  // (also already blocked on-chain: mint_reserve_tokens_in_kind requires
  // exactly Active) while Sell/redeem stays fully available, since
  // require_redemption_allowed already permits it during WindDown BY DESIGN
  // (close_reserve requires supply to reach zero, i.e. holders must be able
  // to claim out while winding down) -- this is what actually lets prior
  // holders claim their share instead of the Reserve just vanishing.
  const isWindingDown = isOnChain && dtr.onChain?.status === "windDown";

  /**
   * Re-fetches THIS Reserve's on-chain state + the connected wallet's real
   * balances immediately after a confirmed tx, rather than waiting for
   * RealReserveSync's next poll -- deliberately scoped to the one Reserve
   * that just changed, never every Reserve (see the "targeted refresh"
   * requirement in docs/project/PROJECT_STATUS.md's RPC-resilience pass).
   * Cache keys for this Reserve's mint/the wallet's settlement-asset balance are
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
        // Best-effort, same reasoning as RealReserveSync.tsx's own pricing
        // fetch -- a failure here must never block this refresh; it just
        // falls back to an empty price map, and mergeOnChainIntoDTR/
        // computeAumFromPrices report the honest "unavailable" state rather
        // than a stale or fabricated number.
        const priceByMint: Record<string, AssetPriceInfo> = IS_MAINNET
          ? await fetchAssetPricesUsd(onChain.assets.map((a) => ({ mint: a.assetMint, decimals: a.decimals }))).catch(() => ({}))
          : {};
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
          priceByMint,
          IS_MAINNET,
        );
        // Re-verify delegates directly too (mergeOnChainReserve never
        // touches delegatesOnChain -- see onChainReserve.ts's
        // mergeOnChainIntoDTR) so isManagerOrDelegate's "Manage Reserve"
        // gating on this page stays correct right after a manual refresh,
        // not just after RealReserveSync's next background poll tick.
        const delegates = await withReadConcurrencyLimit(() =>
          discoverDelegatesForReserve(connection, programId, reserveAddress, buildDelegateCandidateWallets(dtr.onChain!.reserve, onChain.manager, wallet.address)),
        );
        setOnChainDelegates(dtr.id, delegates.map(onChainDelegateFromDiscovered), onChain.delegateCount);
      }
      if (walletCtx.publicKey) {
        const owner = walletCtx.publicKey;
        const rtMint = dtr.onChain.reserveTokenMint;
        const rtKey = tokenBalanceCacheKey(connection.rpcEndpoint, rtMint, owner.toBase58());
        const buyAsset = resolveBuyAsset(dtr.onChain);
        const settlementKey = tokenBalanceCacheKey(connection.rpcEndpoint, buyAsset.mint.toBase58(), owner.toBase58());
        invalidateCached(rtKey);
        invalidateCached(settlementKey);
        const balanceRaw = await getCached(rtKey, BALANCE_CACHE_TTL_MS, () =>
          withReadConcurrencyLimit(() => fetchTokenBalanceRaw(connection, new PublicKey(rtMint), owner)),
        );
        syncRealHolding(dtr.id, balanceRaw, dtr.nav);
        const solLamports = await connection.getBalance(owner, "confirmed");
        syncWalletFromChain({ connected: true, connecting: false, address: owner.toBase58(), provider: wallet.provider, solLamports });
        const settlementRaw = await getCached(settlementKey, BALANCE_CACHE_TTL_MS, () => withReadConcurrencyLimit(() => fetchTokenBalanceRaw(connection, buyAsset.mint, owner)));
        setSettlementBalanceRaw(BigInt(settlementRaw));
        setSettlementBalanceStatus("ready");
      }
    } catch {
      // Best-effort immediate refresh; RealReserveSync's regular poll will catch up regardless.
    }
    // Holder count/24h volume must reflect a confirmed Buy/Sell too (a full
    // exit changes who's a holder; any trade changes 24h volume) -- forces
    // past landing-stats.ts's 60s cache rather than waiting for it to expire
    // on its own. Best-effort: a failure here just leaves the previous
    // figures in place, exactly like every other read in this function.
    landingStats.refetch(true);
  }

  // Initial settlement-asset balance read (refreshRealReserveNow only runs
  // after a confirmed tx) -- real, read live from chain, never simulated.
  // Routed through the shared cache/dedupe helper so this mount effect and
  // RealReserveSync's own per-Reserve balance loop collapse into one
  // request instead of each firing its own for the same (mint, owner).
  useEffect(() => {
    if (!walletCtx.publicKey) {
      // Design preview (never on Mainnet): no real wallet adapter is present,
      // so seed a playable 10,000 devUSDC balance for styling the populated
      // panel states. On Mainnet only real, chain-read balances may render.
      if (!IS_MAINNET && isDesignDemoEnabled()) {
        setSettlementBalanceRaw(BigInt(10_000 * 10 ** SETTLEMENT_DECIMALS));
        setSettlementBalanceStatus("ready");
        return;
      }
      setSettlementBalanceRaw(0n);
      setSettlementBalanceStatus("loading");
      return;
    }
    const owner = walletCtx.publicKey;
    let cancelled = false;
    setSettlementBalanceStatus("loading");
    const buyAsset = resolveBuyAsset(dtr?.onChain);
    getCached(tokenBalanceCacheKey(connection.rpcEndpoint, buyAsset.mint.toBase58(), owner.toBase58()), BALANCE_CACHE_TTL_MS, () =>
      withReadConcurrencyLimit(() => fetchTokenBalanceRaw(connection, buyAsset.mint, owner)),
    )
      .then((raw) => {
        if (!cancelled) {
          setSettlementBalanceRaw(BigInt(raw));
          setSettlementBalanceStatus("ready");
        }
      })
      .catch(() => {
        if (!cancelled) setSettlementBalanceStatus("unavailable");
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [walletCtx.publicKey?.toBase58(), connection, dtr?.onChain?.assets[0]?.mint, dtr?.onChain?.reserve]);

  // Derived chart/market data. Kept above the "not found" early return (and fed safe
  // fallbacks when dtr is undefined) so hook call order never changes between renders.
  // Design-preview overlay (?demo=1, DevNet-only): a flat fixture Reserve charts a
  // synthetic series instead, disclosed beside the chart -- see designDemo.ts.
  const designDemo = dtr ? applyDesignDemo(dtr, IS_MAINNET) : null;
  const priceHistory = designDemo?.priceHistory ?? dtr?.priceHistory ?? [];
  // All-time performance: current Token Price vs. the earliest point of the
  // history. On Mainnet that earliest point is the server-served launch
  // anchor (the Reserve's holdings at their entry prices -- the same
  // baseline as the Composition table's per-asset P&L), so this is the
  // value-weighted aggregate of those rows. Until the server history has
  // been merged at least once (priceHistoryRecordedFrom undefined) the only
  // point is this browser's own first observation, which would read as a
  // misleading 0% -- shown as "--" instead. DevNet keeps its per-browser
  // history (fixture prices never move, so 0.00% is the genuine answer).
  const allTimeChangePct = designDemo
    ? calcAllTimeChangePct(designDemo.priceHistory, designDemo.priceHistory[designDemo.priceHistory.length - 1]?.price)
    : dtr && (!IS_MAINNET || dtr.priceHistoryRecordedFrom !== undefined)
      ? calcAllTimeChangePct(priceHistory, dtr.nav)
      : null;
  const trades = dtr?.trades ?? [];
  // Creator change log: illustrative entries in design preview; real Reserves
  // have no recorded notes yet, so they render the honest empty state.
  const creatorNotes = designDemo?.creatorNotes ?? [];

  // Flatlines at the last known REAL price when a timeframe's own window has no
  // point strictly inside it (anchored to a genuine prior observation -- "nothing
  // happened since we last saw a real price," never invented), and leads in from
  // that same real baseline when the window's history starts partway through.
  // A Reserve with fewer than 2 ever-recorded real price points still renders a
  // client-side-only flatline anchored to its current genuine NAV (`isFallback:
  // true`, never persisted) -- only a Reserve with NEITHER real history NOR a
  // valid current NAV reports `unavailable: true` (see calculations.ts's
  // buildLineSeries). Recomputed independently on every (priceHistory, timeframe,
  // nav) change -- this component's own local state, never shared with any other
  // chart instance.
  const lineSeries = useMemo(
    () => buildLineSeries(priceHistory, timeframe, dtr && dtr.nav > 0 ? dtr.nav : null),
    [priceHistory, timeframe, dtr?.nav],
  );

  const chartData = useMemo(
    () =>
      sampleLinePoints(lineSeries.points, 300).map((p, i) => ({
        ...p,
        dateStr: timeframeTickFormat(p.t, timeframe),
        // Unique per point: duplicate category values break ReferenceLine's
        // x lookup, so the axis key carries an invisible index suffix that
        // the tick formatter strips back off.
        xKey: `${timeframeTickFormat(p.t, timeframe)}\u200b${i}`,
      })),
    [lineSeries, timeframe],
  );

  // Candles view: same windowed series, bucketed to OHLC. Chart style is a
  // per-page toggle (Line | Candles) defaulting to candles whenever the
  // window has genuine movement to show.
  const [chartStyle, setChartStyle] = useState<"line" | "candles">("candles");
  // Composition rows expand in place (click toggles) to reveal a per-asset
  // line chart; clicking the open row again collapses it.
  const [expandedAsset, setExpandedAsset] = useState<string | null>(null);
  const candleData = useMemo(() => {
    const candles = buildCandleSeries(lineSeries.points, 36);
    const ema8 = ema(candles.map((c) => c.close), 8);
    return candles.map((c, i) => ({
      ...c,
      ema8: ema8[i],
      dateStr: timeframeTickFormat(c.t, timeframe),
      xKey: `${timeframeTickFormat(c.t, timeframe)}\u200b${i}`,
    }));
  }, [lineSeries, timeframe]);
  const candlesUsable = candleData.length > 1 && !lineSeries.isFallback;
  const showCandles = chartStyle === "candles" && candlesUsable;
  // Honest disclosure for a window that reaches back before the server
  // started recording this Reserve (Mainnet): the series there runs in a
  // straight line from the launch value (holdings at entry prices) to the
  // first recorded point -- real endpoints, but not recorded movement.
  const preRecordedSegmentNote = useMemo(() => {
    if (designDemo || !dtr || lineSeries.isFallback || lineSeries.points.length < 2) return null;
    const recordedFrom = dtr.priceHistoryRecordedFrom;
    if (recordedFrom === undefined) return null;
    const windowStart = lineSeries.points[0].t;
    if (recordedFrom !== null && windowStart >= recordedFrom - 60_000) return null;
    const from = recordedFrom === null ? null : new Date(recordedFrom).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
    return from
      ? `Recorded price history starts ${from}; the earlier segment runs straight from the launch value.`
      : "Recorded price history begins with the next server refresh; this line runs straight from the launch value to now.";
  }, [designDemo, dtr, lineSeries]);
  // First genuinely recorded observation, marked on the chart when the design
  // preview's synthetic backfill extends further into the past than the real
  // series does (the same "launch" annotation Reserve-style charts carry).
  // Creator-note markers within the current chart window: dashed line + pill
  // per note, hyperlinking down to the Notes section.
  const noteMarkers = useMemo(() => {
    if (!designDemo || creatorNotes.length === 0) return [];
    const source = showCandles ? candleData : chartData;
    if (source.length < 2) return [];
    const start = source[0].t;
    const markers: Array<{ key: number; xKey: string; tag: string; level: number }> = [];
    for (const note of creatorNotes) {
      if (note.t < start || note.t > source[source.length - 1].t) continue;
      let best: { xKey: string } | null = null;
      for (const p of source) {
        if (p.t <= note.t) best = p;
        else break;
      }
      if (best) markers.push({ key: note.t, xKey: best.xKey, tag: note.tag, level: markers.length % 2 });
    }
    return markers;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [designDemo, creatorNotes, showCandles, candleData, chartData]);

  const launchMarker = useMemo(() => {
    if (!designDemo || !dtr || dtr.priceHistory.length === 0) return null;
    const t = dtr.priceHistory[0].t;
    const source = showCandles ? candleData : chartData;
    if (!source.length) return null;
    let best: { xKey: string } | null = null;
    for (const p of source) {
      if (p.t <= t) best = p;
      else break;
    }
    return best && best !== source[source.length - 1] ? best.xKey : null;
  }, [designDemo, dtr?.priceHistory, showCandles, candleData, chartData]);

  const recentTrades = useMemo(() => [...trades].reverse(), [trades]);

  if (!dtr) {
    // A genuinely-existing on-chain Reserve that failed the canonical public
    // eligibility check (packages/sdk's evaluateReserveEligibility) --
    // opened directly by address/id rather than surfaced through Discover.
    // Deliberately shows nothing else: no chart, no stats, no trading
    // controls, no diagnostic detail -- just the honest quarantine message
    // and a way back.
    if (quarantined) {
      return (
        <div className="container mx-auto px-4 py-24 text-center">
          <h1 className="text-3xl font-merge-display font-bold mb-4">Legacy Reserve</h1>
          <p className="text-muted-foreground mb-8">This legacy DevNet Reserve is not supported by the current SSR test environment.</p>
          <Button asChild>
            <Link href="/discover">Back to Discover</Link>
          </Button>
        </div>
      );
    }
    // Still-indexing: either resolveDtrPageState itself already knows
    // discovery hasn't completed a pass yet, or it has but the bounded
    // direct on-chain check above hasn't yet confirmed genuine absence.
    // Never render the terminal "Not Found" state while either is true --
    // see resolveDtrPageState's root-cause comment (onChainReserve.ts).
    const stillIndexing = pageState.kind === "indexing" || (pageState.kind === "not-found" && directCheck !== "confirmed-absent" && parseOnChainReserveId(dtrId) !== null);
    if (stillIndexing) {
      return (
        <div className="container mx-auto px-4 py-24 text-center">
          <h1 className="text-3xl font-merge-display font-bold mb-4">Verifying on {CLUSTER_LABEL}...</h1>
          <p className="text-muted-foreground mb-8">This Reserve was just created or resumed and is still being confirmed on Solana {CLUSTER_LABEL}. It will appear automatically in a moment.</p>
        </div>
      );
    }
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

  // "Price unavailable" is only genuine pricing failure (a materially-held
  // asset this pass couldn't get a valid Pyth/Jupiter quote for), never a
  // simulated DTR or a DevNet Reserve (neither ever go through the real
  // pricing pipeline -- see onChainReserve.ts's computeAumFromPrices).
  const pricingUnavailable = isOnChain && IS_MAINNET && dtr.onChain?.priceSource === "unavailable";
  const marketCap = computeMarketCap(dtr.onChain?.reserveTokenSupplyRaw ?? "0", dtr.tokenPrice);
  const priceSourceLabel = dtr.onChain?.priceSource === "pyth" ? "Pyth" : dtr.onChain?.priceSource === "jupiter" ? "Jupiter" : dtr.onChain?.priceSource === "mixed" ? "Pyth + Jupiter" : null;
  const priceAgeLabel = (() => {
    if (!dtr.onChain?.priceAsOf) return null;
    const ageSec = Math.max(0, Math.floor((Date.now() - dtr.onChain.priceAsOf) / 1000));
    if (ageSec < 60) return `${ageSec}s ago`;
    if (ageSec < 3600) return `${Math.floor(ageSec / 60)}m ago`;
    return `${Math.floor(ageSec / 3600)}h ago`;
  })();

  const chartMin = showCandles
    ? Math.min(...candleData.map((c) => c.low))
    : chartData.length
      ? Math.min(...chartData.map((d) => d.price))
      : 0;
  const chartMax = showCandles
    ? Math.max(...candleData.map((c) => c.high))
    : chartData.length
      ? Math.max(...chartData.map((d) => d.price))
      : 1;
  // A flatlined series has chartMin === chartMax; pad by at least a cent so the line
  // still renders inside the plot instead of collapsing onto an axis.
  const yPad = Math.max((chartMax - chartMin) * 0.05, chartMax * 0.01, 0.01);
  const yDomain = [chartMin - yPad, chartMax + yPad];

  // A rebalance can drive an asset's target weight to exactly 0% without
  // removing its on-chain registration (update_targets only changes intent,
  // per DEC-0017 -- see managementClient.ts) -- once an asset is no longer
  // part of the intended composition, it shouldn't keep cluttering this
  // card's pie slice/row. Filters the DISPLAY only; dtr.composition itself
  // (used elsewhere, e.g. ManageDTR.tsx's Rebalance tab, which needs to show
  // a 0%-weight asset so it can be edited) is untouched.
  // Design preview (?demo=1): a flat fixture Reserve shows the illustrative
  // 7-asset basket instead, disclosed on the card -- see designDemo.ts.
  const compositionDisplay = designDemo ? designDemo.composition : dtr.composition.filter((a) => a.weight > 0);

  // Trading Calculations
  const numBuyAmount = parseFloat(buyAmount) || 0;
  const buyQuote = calcTokensReceived(numBuyAmount, dtr.tokenPrice, dtr.liquidityUsdc);
  // The Buy asset for a real (on-chain) Reserve -- the single asset it
  // actually holds (see packages/sdk/src/directInstructions.ts's
  // requireSingleAssetReserve; every Mainnet Reserve today is single-asset).
  const buyDepositAsset = isOnChain ? dtr.onChain?.assets[0] : undefined;
  /**
   * Reconciled directly against the program: this is the EXACT same integer
   * math buildDirectMintInstructions (packages/sdk/src/directInstructions.ts)
   * uses to build the real transaction -- computeDirectReserveTokensRequested
   * mirrors mint_reserve_tokens_in_kind's own on-chain ratio, then
   * computeNetMintOutput mirrors its ceiling-rounded Mint Fee. Deliberately
   * NOT derived from USD price/NAV: the actual on-chain instruction is a
   * proportional in-kind deposit of the Reserve's own asset (no oracle
   * involved at all), so basing the estimate on real vault balances/supply
   * instead of a USD conversion makes the two impossible to disagree, and
   * keeps this estimate available even during a Pyth/Jupiter outage. `null`
   * means a genuine "Quote unavailable" (not yet seeded, or no deposit
   * asset resolved) -- never silently shown as 0.
   */
  const estReserveTokensOutReal: number | null = (() => {
    if (numBuyAmount <= 0) return 0; // Nothing typed yet -- a neutral "0," never the alarming "Quote unavailable."
    if (!isOnChain || !dtr.onChain) return isOnChain ? null : 0;
    const supply = BigInt(dtr.onChain.reserveTokenSupplyRaw || "0");
    if (supply <= 0n) return null;
    // Any Reserve bought through the USDC-funded path (every Mainnet
    // Reserve that isn't purely USDC -- single-asset SSR included, DEC-0151
    // -- plus any multi-asset Reserve) takes numBuyAmount as a USD amount,
    // so the quote is NAV-based, mirroring exactly what
    // handleBuyMultiAssetMainnet actually submits (usdToReserveTokensRequested).
    if (dtr.onChain.assets.length > 1 || (IS_MAINNET && dtr.onChain.assets[0] && dtr.onChain.assets[0].mint !== MAINNET_USDC_MINT)) {
      if (!(dtr.nav > 0)) return null;
      try {
        const gross = usdToReserveTokensRequested(numBuyAmount, dtr.nav, RESERVE_TOKEN_DECIMALS);
        const feeBps = BigInt(dtr.onChain.effectiveMintFeeTotalBps ?? dtr.onChain.mintFeeBps ?? 0);
        const { netOut } = computeNetMintOutput(gross, feeBps);
        return Number(netOut) / 10 ** RESERVE_TOKEN_DECIMALS;
      } catch {
        return null;
      }
    }
    if (!buyDepositAsset) return null;
    const vaultBalance = BigInt(dtr.onChain.vaultBalancesRaw[buyDepositAsset.mint] ?? "0");
    if (vaultBalance <= 0n) return null;
    const amountInRaw = BigInt(Math.floor(numBuyAmount * 10 ** buyDepositAsset.decimals));
    if (amountInRaw <= 0n) return null;
    try {
      const gross = computeDirectReserveTokensRequested(amountInRaw, vaultBalance, supply);
      const feeBps = BigInt(dtr.onChain.effectiveMintFeeTotalBps ?? dtr.onChain.mintFeeBps ?? 0);
      const { netOut } = computeNetMintOutput(gross, feeBps);
      return Number(netOut) / 10 ** RESERVE_TOKEN_DECIMALS;
    } catch {
      return null;
    }
  })();
  // Design preview (?demo=1): the flat fixtures can't produce a genuine
  // quote (no NAV / vault data), so substitute an illustrative estimate at
  // token price with the 0.50% mint fee applied — the panel styles the
  // populated state instead of "Quote unavailable". Real mode is untouched:
  // null still means genuinely unavailable.
  const estReserveTokensOut: number | null =
    estReserveTokensOutReal !== null
      ? estReserveTokensOutReal
      : designDemo && numBuyAmount > 0
        ? (numBuyAmount * 0.995) / (dtr.tokenPrice > 0 ? dtr.tokenPrice : 1)
        : null;

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
  const sellEntitlementsReal = (() => {
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
  // Design preview: fabricate the in-kind redemption preview from the
  // illustrative composition when the real math has nothing to show.
  const sellEntitlements =
    sellEntitlementsReal.length > 0
      ? sellEntitlementsReal
      : designDemo && numSellAmount > 0
        ? designDemo.composition.map((a) => ({
            mint: a.symbol,
            symbol: a.symbol,
            amount: (numSellAmount * (dtr.tokenPrice > 0 ? dtr.tokenPrice : 1) * a.weight * 0.995) / a.priceUsd,
          }))
        : sellEntitlementsReal;
  // DevNet only: for a mixed-composition Reserve, Sell redeems in-kind for
  // real then converts every non-settlement leg's DevNet test-price USD
  // value into freshly-minted devUSDC (see
  // packages/sdk/src/zapInstructions.ts's buildSellZapInstructionsDevUsdc)
  // -- since the settlement asset is $1-pegged by design, the total received
  // is simply this redemption's total USD value. Mainnet Reserves are
  // USDC-only (see SETTLEMENT_MINT above), so this branch never actually
  // renders there -- isPureSettlementReserve is always true for them. An
  // estimate only (the real amount is computed server-side from live vault
  // balances at execution time), shown as an explicitly secondary figure,
  // never implied to be a real market quote.
  const estSettlementOut = isOnChain
    ? numSellAmount * (dtr.nav > 0 ? dtr.nav : designDemo ? (dtr.tokenPrice > 0 ? dtr.tokenPrice : 1) : 0)
    : 0;

  /** One-shot reconciliation for an ambiguous ("unresolved") outcome: does the trader's REAL, freshly-read settlement-asset balance actually show the spend this Buy would have made? If so, report success based on that observed on-chain state -- never based on an assumption. Used both automatically right after an AmbiguousConfirmationError and from the pending-verification banner's manual "Check status" button. */
  async function reconcileBuy(signature: string) {
    if (!walletCtx.publicKey || !dtr) return;
    const owner = walletCtx.publicKey;
    const buyAsset = resolveBuyAsset(dtr.onChain);
    try {
      const key = tokenBalanceCacheKey(connection.rpcEndpoint, buyAsset.mint.toBase58(), owner.toBase58());
      invalidateCached(key);
      const freshRaw = await withReadConcurrencyLimit(() => fetchTokenBalanceRaw(connection, buyAsset.mint, owner));
      if (reconcileByBalanceChange(buyPreSettlementRawRef.current, BigInt(freshRaw), "decrease")) {
        // The real spent amount is the observed balance delta itself -- the
        // most authoritative figure available here (this whole function
        // only runs because normal confirmation was inconclusive).
        const spentRaw = buyPreSettlementRawRef.current - BigInt(freshRaw);
        const spentUsdc = Number(spentRaw > 0n ? spentRaw : 0n) / 10 ** buyAsset.decimals;
        setSettlementBalanceRaw(BigInt(freshRaw));
        setBuyPhase("confirmed");
        setBuyPendingSignature(null);
        await refreshRealReserveNow();
        recordConfirmedTrade(dtr.id, "buy", spentUsdc / (dtr.nav || 1), spentUsdc);
        setBuyAmount("");
        toast(transactionConfirmedToast(signature, "Buy confirmed"));
      } else {
        toast({
          title: "Still verifying",
          description: `Your ${buyAsset.symbol} balance hasn't changed yet -- the transaction may still be confirming, or may not have landed. Check the signature link before submitting another Buy.`,
        });
      }
    } catch {
      // The reconciliation read itself failed (still congested) -- leave the pending-verification banner up; nothing to report either way yet.
    }
  }

  /** Every account this page itself can already name, for describeUnknownSignerMessage's client-side fallback relabeling -- see that function's header for why this is a fallback, not the primary fix. */
  function knownAccountsForErrorMessages(): Record<string, string> {
    const known: Record<string, string> = {};
    if (dtr?.onChain) {
      known["Reserve"] = dtr.onChain.reserve;
      known["Reserve Token mint"] = dtr.onChain.reserveTokenMint;
      known["mint authority"] = dtr.onChain.mintAuthority;
      known["vault authority"] = dtr.onChain.vaultAuthority;
      known["Reserve manager"] = dtr.onChain.manager;
    }
    if (walletCtx.publicKey) known["connected wallet"] = walletCtx.publicKey.toBase58();
    return known;
  }

  const handleBuy = async () => {
    if (!dtr.onChain) return;
    if (!walletCtx.publicKey) {
      toast({ variant: "destructive", title: "Connect Wallet", description: "Connect a wallet first." });
      return;
    }
    if (!canSubmitNewTransaction(buyPhase)) return; // Defensive -- the button is already disabled in this state.
    // Defensive -- the button is already disabled for this case (an
    // ineligible Reserve is filtered out of the catalogue before this page
    // could ever be opened for it), but never rely on that alone. See
    // isSettlementBuySupported.
    if (!isSettlementBuySupported) {
      toast({
        variant: "destructive",
        title: "Buy not available",
        description: "This Reserve holds an asset outside the supported DevNet economy (devUSDC/mockX/mockY/mockZ), so Buy is unavailable for it.",
      });
      return;
    }
    // devUSDC is the purchasing currency: the user's real devUSDC balance
    // funds the ENTIRE mint directly via mint_reserve_tokens_in_kind's own
    // transfer_checked -- never a simulated conversion, never a
    // faucet/authority-funded leg (guaranteed by the check above: every
    // asset in this Reserve is devUSDC itself).
    const devUsdcAmountRaw = BigInt(Math.floor(numBuyAmount * 10 ** SETTLEMENT_DECIMALS));
    // Checked against the trader's own real, already-fetched balance BEFORE
    // any network call -- an honest, immediate "insufficient devUSDC"
    // message, distinct from an RPC-congestion or swap-authority-SOL
    // failure, and cheaper than letting an on-chain transfer_checked fail.
    if (devUsdcAmountRaw > settlementBalanceRaw) {
      toast({
        variant: "destructive",
        title: "Insufficient devUSDC",
        description: `This wallet holds ${(Number(settlementBalanceRaw) / 10 ** SETTLEMENT_DECIMALS).toLocaleString()} devUSDC, less than the ${numBuyAmount.toLocaleString()} devUSDC requested. Claim more from the faucet or reduce the amount.`,
      });
      return;
    }
    setBuyPhase("preparing");
    setBuyPendingSignature(null);
    buyPreSettlementRawRef.current = settlementBalanceRaw;
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
      const spentUsdc = Number(devUsdcAmountRaw) / 10 ** SETTLEMENT_DECIMALS;
      recordConfirmedTrade(dtr.id, "buy", spentUsdc / (dtr.nav || 1), spentUsdc);
      setBuyAmount("");
      toast(transactionConfirmedToast(signature, "Buy confirmed"));
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
          toast({ variant: "destructive", title: `${CLUSTER_LABEL} RPC congested`, description: `Solana ${CLUSTER_LABEL}'s RPC endpoint is temporarily rate-limited. Please wait a few seconds and try again.` });
        } else if (e instanceof ZapBuildError && e.code === "swap_authority_low_sol") {
          toast({ variant: "destructive", title: "Swap adapter temporarily low on SOL", description: e.message });
        } else if (e instanceof ZapBuildError && e.code === "conversion_unsupported") {
          toast({ variant: "destructive", title: "Buy not available", description: e.message });
        } else {
          const raw = e instanceof Error ? e.message : "The DevNet swap failed.";
          // Full technical detail (server-side status text, decoded on-chain
          // error name, etc) always goes to the console -- the toast itself
          // shows only the plain-language required copy, never a raw
          // instruction name or internal phase.
          console.error("Buy failed:", describeUnknownSignerMessage(raw, knownAccountsForErrorMessages()));
          toast({ variant: "destructive", title: "Buy Failed", description: "Your purchase could not be completed. No funds were moved." });
        }
      }
    } finally {
      useAppStore.getState().setTxInFlight(false);
    }
  };

  // Mainnet direct Buy: no swap, no server co-signer -- see
  // packages/sdk/src/directInstructions.ts's header for why. Requires the
  // wallet's real balance of this Reserve's OWN sole asset (USDC for a
  // USDC-only Reserve; some other real Mainnet mint, e.g. SSR for "alpha",
  // otherwise -- see resolveBuyAsset above) to fund the entire deposit
  // directly. There is no swap step: the input box is always denominated in
  // that real deposit asset, never converted from/to USDC.
  const handleBuyMainnet = async () => {
    if (!dtr.onChain) return;
    if (!walletCtx.publicKey) {
      toast({ variant: "destructive", title: "Connect Wallet", description: "Connect a wallet first." });
      return;
    }
    if (!canSubmitNewTransaction(buyPhase)) return;
    if (buySubmittingRef.current) return; // same-tick duplicate-click guard (DEC-0154), matching handleBuyMultiAssetMainnet
    buySubmittingRef.current = true;
    const buyAsset = resolveBuyAsset(dtr.onChain);
    const usdcAmountRaw = BigInt(Math.floor(numBuyAmount * 10 ** buyAsset.decimals));
    setBuyPhase("preparing");
    setBuyPendingSignature(null);
    useAppStore.getState().setTxInFlight(true);
    try {
      const reserveAddress = new PublicKey(dtr.onChain.reserve);
      // Every one of this Reserve's ALREADY-KNOWN registered asset mints --
      // never just USDC. fetchReserveOnChain only resolves an asset whose
      // mint is passed as a candidate (its ReserveAsset PDA is derived
      // per-candidate, not enumerated independently -- see
      // packages/sdk/src/readOnly.ts's fetchReserveOnChain), so a Reserve
      // whose sole asset genuinely isn't USDC (e.g. "alpha", 100% SSR) would
      // resolve to an empty asset list and fail outright if only USDC were
      // ever passed here.
      const live = await fetchReserveOnChain(connection, SSR_PROGRAM_ID, reserveAddress, dtr.onChain.assets.map((a) => new PublicKey(a.mint)));
      if (!live) throw new Error("Could not read this Reserve's live on-chain state.");
      const assets: ZapAssetLeg[] = live.assets.map((a) => ({
        mint: a.assetMint,
        decimals: a.decimals,
        reserveAsset: a.reserveAsset,
        vault: a.vault,
        vaultBalanceRaw: a.vaultBalanceRaw,
      }));
      const [protocolConfig] = findProtocolConfig(SSR_PROGRAM_ID);
      const { signature } = await executeDirectMint({
        connection,
        wallet: walletCtx,
        protocolConfig,
        protocolFeeDestination: new PublicKey(MAINNET_TREASURY_VAULT),
        reserve: reserveAddress,
        reserveTokenMint: new PublicKey(dtr.onChain.reserveTokenMint),
        mintAuthority: new PublicKey(dtr.onChain.mintAuthority),
        assets,
        reserveTokenSupplyRaw: live.reserveTokenSupplyRaw,
        amountIn: usdcAmountRaw,
        onProgress: (e) => setBuyPhase(e.phase === "awaiting-wallet" ? "awaiting-wallet" : "confirming"),
      });
      setBuyPhase("confirmed");
      await refreshRealReserveNow();
      const spentUsdc = Number(usdcAmountRaw) / 10 ** buyAsset.decimals;
      recordConfirmedTrade(dtr.id, "buy", spentUsdc / (dtr.nav || 1), spentUsdc);
      setBuyAmount("");
      toast(transactionConfirmedToast(signature, "Buy confirmed"));
    } catch (e) {
      if (e instanceof AmbiguousConfirmationError) {
        setBuyPhase("unresolved");
        setBuyPendingSignature(e.signature);
        toast({ title: "Mainnet RPC is temporarily busy", description: "No confirmation could be verified yet -- your transaction may still be confirming. Checking your real balance now." });
        await reconcileBuy(e.signature);
      } else {
        setBuyPhase("failed");
        const raw = e instanceof Error ? e.message : "The purchase failed.";
        console.error("Buy failed:", raw);
        // onBuyClick only ever routes here for a genuinely single-asset
        // Reserve (see isMultiAssetMainnetReserve/handleBuyMultiAssetMainnet
        // below) -- this specific failure should be unreachable from the UI;
        // kept as a named, honest fallback rather than a generic message, in
        // case this Reserve's client-cached asset list was stale when routing
        // decided which handler to call.
        const isSingleAssetGap = raw.includes("no supported way to buy into or sell from a multi-asset Reserve");
        toast({
          variant: "destructive",
          title: "Buy Failed",
          description: isSingleAssetGap
            ? "This Reserve holds more than one asset and needs the multi-asset Buy path -- please reload the page and try again."
            : `Your purchase could not be completed: ${raw} No funds were moved.`,
        });
      }
    } finally {
      buySubmittingRef.current = false;
      useAppStore.getState().setTxInFlight(false);
    }
  };

  /**
   * Buy for a genuinely multi-asset Mainnet Reserve (e.g. BETA) -- see
   * multiAssetBuyClient.ts's header for the full funding/mint model. Unlike
   * handleBuyMainnet, `numBuyAmount` here is a USD amount to invest (see
   * resolveBuyAsset's multi-asset branch, which is why buyAssetForDisplay is
   * USDC for this Reserve), and the flow spans several separate wallet
   * approvals (wrap SOL if needed, one swap per other non-USDC leg, then the
   * final mint) -- multiAssetBuyStep shows which one is in flight.
   */
  const handleBuyMultiAssetMainnet = async () => {
    if (!dtr.onChain) return;
    if (!walletCtx.publicKey) {
      toast({ variant: "destructive", title: "Connect Wallet", description: "Connect a wallet first." });
      return;
    }
    if (!canSubmitNewTransaction(buyPhase)) return;
    // Synchronous, same-tick guard against a fast double-click or a
    // concurrent buy/resume for the same purchase -- buyPhase (React
    // state) only takes effect after the next render, exactly the gap
    // CreateDTR.tsx's submittingRef already closes for launches (DEC-0154
    // requirement: prevent duplicate clicks/concurrent attempts).
    if (buySubmittingRef.current) return;
    buySubmittingRef.current = true;
    if (!(dtr.nav > 0)) {
      buySubmittingRef.current = false;
      toast({ variant: "destructive", title: "Pricing Unavailable", description: "This Reserve's current price isn't available right now -- try again shortly." });
      return;
    }
    setBuyPhase("preparing");
    setBuyPendingSignature(null);
    setMultiAssetBuyStep(null);
    useAppStore.getState().setTxInFlight(true);
    try {
      const reserveAddress = new PublicKey(dtr.onChain.reserve);
      const live = await fetchReserveOnChain(connection, SSR_PROGRAM_ID, reserveAddress, dtr.onChain.assets.map((a) => new PublicKey(a.mint)));
      if (!live) throw new Error("Could not read this Reserve's live on-chain state.");
      const assets: ZapAssetLeg[] = live.assets.map((a) => ({
        mint: a.assetMint,
        decimals: a.decimals,
        reserveAsset: a.reserveAsset,
        vault: a.vault,
        vaultBalanceRaw: a.vaultBalanceRaw,
      }));
      const [protocolConfig] = findProtocolConfig(SSR_PROGRAM_ID);
      const reserveTokensRequested = usdToReserveTokensRequested(numBuyAmount, dtr.nav, RESERVE_TOKEN_DECIMALS);
      const { signature, alreadyMinted } = await executeMultiAssetBuyMainnet({
        connection,
        wallet: walletCtx,
        protocolConfig,
        protocolFeeDestination: new PublicKey(MAINNET_TREASURY_VAULT),
        reserve: reserveAddress,
        reserveTokenMint: new PublicKey(dtr.onChain.reserveTokenMint),
        mintAuthority: new PublicKey(dtr.onChain.mintAuthority),
        assets,
        reserveTokenSupplyRaw: live.reserveTokenSupplyRaw,
        reserveTokensRequested,
        effectiveMintFeeTotalBps: BigInt(dtr.onChain.effectiveMintFeeTotalBps ?? dtr.onChain.mintFeeBps ?? 0),
        assetPricesUsd: dtr.onChain.assetPricesUsd ?? {},
        onProgress: (e) => {
          if (e.phase === "building") {
            setMultiAssetBuyStep("Building every transaction of your purchase (one request)...");
            setBuyPhase("preparing");
          } else if (e.phase === "single-transaction") {
            setMultiAssetBuyStep("One transaction: your USDC is swapped, deposited, and your Reserve Tokens minted -- a single wallet approval.");
            setBuyPhase("preparing");
          } else if (e.phase === "enabling-one-approval-trading") {
            setMultiAssetBuyStep("One-time setup: enabling one-approval trading for this Reserve (a small separate approval), then your purchase completes in a single transaction.");
            setBuyPhase("awaiting-wallet");
          } else if (e.phase === "swapping") {
            setMultiAssetBuyStep(`Swapping your USDC into Reserve asset ${e.index + 1} of ${e.total}...`);
            setBuyPhase("awaiting-wallet");
          } else if (e.phase === "minting") {
            setMultiAssetBuyStep("Depositing into the Reserve and minting your tokens...");
            setBuyPhase("preparing");
          } else if (e.phase === "confirming") {
            // Signed and on the wire: the wallet prompt is over; we re-broadcast
            // until it lands, so the button must say "confirming", not "approve".
            setMultiAssetBuyStep(`Confirming ${e.what} on Solana Mainnet (${e.signature.slice(0, 8)}...)...`);
            setBuyPhase("confirming");
          } else {
            setBuyPhase("awaiting-wallet");
          }
        },
      });
      setMultiAssetBuyStep(null);
      setBuyPhase("confirmed");
      await refreshRealReserveNow();
      recordConfirmedTrade(dtr.id, "buy", numBuyAmount / (dtr.nav || 1), numBuyAmount);
      setBuyAmount("");
      toast(
        alreadyMinted
          ? { title: "Purchase already completed", description: "A previous attempt's mint had already landed on-chain -- your Reserve Tokens were already in your wallet, and nothing was purchased or minted twice." }
          : transactionConfirmedToast(signature, "Buy confirmed"),
      );
    } catch (e) {
      setMultiAssetBuyStep(null);
      if (e instanceof AmbiguousConfirmationError) {
        setBuyPhase("unresolved");
        setBuyPendingSignature(e.signature);
        toast({ title: "Mainnet RPC is temporarily busy", description: "No confirmation could be verified yet -- your transaction may still be confirming. Checking your real balance now." });
        await reconcileBuy(e.signature);
      } else {
        setBuyPhase("failed");
        const raw = e instanceof Error ? e.message : "The purchase failed.";
        console.error("Multi-asset Buy failed:", raw);
        // The on-chain-verified state report (multiAssetBuyPlan.ts's
        // buildBuyStateReport) -- what succeeded, what is held, whether
        // the Reserve Token was minted, and what retry will actually do.
        // NEVER a blanket "your funds are safe" claim: every line below
        // comes from balances re-read from Mainnet after the failure; when
        // even that read failed, the message says the state is unverified
        // instead of guessing.
        const report = e instanceof MultiAssetBuyError ? e.report : null;
        const reportLines = report
          ? `This purchase stopped at: ${report.failedStage}. Verified on-chain after the failure: ${report.legs.map((l) => `${l.mint.slice(0, 4)}...${l.mint.slice(-4)} -- this purchase acquired ${l.purchaseAcquiredRaw} of the ${l.requiredRaw} raw needed${l.fundedEnough ? " (fully funded)" : ""}`).join("; ")}. Reserve Tokens minted: ${report.reserveTokenMinted ? "YES -- already in your wallet" : "no"}. ${report.retrySummary}`
          : "The post-failure on-chain state check itself could not complete -- verify your balances on Explorer before retrying.";
        toast({
          variant: "destructive",
          title: "Buy Failed",
          description: `${raw} ${reportLines}`,
        });
      }
    } finally {
      buySubmittingRef.current = false;
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
        toast(transactionConfirmedToast(signature, "Sell confirmed"));
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
      toast(transactionConfirmedToast(signature, "Sell confirmed"));
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
          toast({ variant: "destructive", title: `${CLUSTER_LABEL} RPC congested`, description: `Solana ${CLUSTER_LABEL}'s RPC endpoint is temporarily rate-limited. Please wait a few seconds and try again.` });
        } else if (e instanceof ZapBuildError && e.code === "swap_authority_low_sol") {
          toast({ variant: "destructive", title: "Swap adapter temporarily low on SOL", description: e.message });
        } else {
          const raw = e instanceof Error ? e.message : "The DevNet swap failed.";
          // Same reasoning as handleBuy's fallback above: full detail to the
          // console, only the required plain-language copy in the toast.
          console.error("Sell failed:", describeUnknownSignerMessage(raw, knownAccountsForErrorMessages()));
          toast({ variant: "destructive", title: "Sell Failed", description: "Your redemption could not be completed. No funds were moved." });
        }
      }
    } finally {
      useAppStore.getState().setTxInFlight(false);
    }
  };

  // Mainnet direct Sell: no swap, no server co-signer -- see
  // packages/sdk/src/directInstructions.ts's header. redeem_reserve_tokens_in_kind
  // pays the user's own USDC ATA directly.
  const handleSellMainnet = async () => {
    if (!dtr.onChain) return;
    if (!walletCtx.publicKey) {
      toast({ variant: "destructive", title: "Connect Wallet", description: "Connect a wallet first." });
      return;
    }
    if (!canSubmitNewTransaction(sellPhase)) return;
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
      const reserveAddress = new PublicKey(dtr.onChain.reserve);
      // Every one of this Reserve's ALREADY-KNOWN registered asset mints --
      // never just USDC. fetchReserveOnChain only resolves an asset whose
      // mint is passed as a candidate (its ReserveAsset PDA is derived
      // per-candidate, not enumerated independently -- see
      // packages/sdk/src/readOnly.ts's fetchReserveOnChain), so a Reserve
      // whose sole asset genuinely isn't USDC (e.g. "alpha", 100% SSR) would
      // resolve to an empty asset list and fail outright if only USDC were
      // ever passed here.
      const live = await fetchReserveOnChain(connection, SSR_PROGRAM_ID, reserveAddress, dtr.onChain.assets.map((a) => new PublicKey(a.mint)));
      if (!live) throw new Error("Could not read this Reserve's live on-chain state.");
      const assets: ZapAssetLeg[] = live.assets.map((a) => ({
        mint: a.assetMint,
        decimals: a.decimals,
        reserveAsset: a.reserveAsset,
        vault: a.vault,
        vaultBalanceRaw: a.vaultBalanceRaw,
      }));
      const reserveTokensToRedeem = BigInt(Math.floor(numSellAmount * 1_000_000));
      // A Reserve composed purely of USDC redeems USDC directly -- no swap
      // step exists or is needed. Every other composition routes through
      // the USDC-settled sell (DEC-0158): redeem the in-kind basket, then
      // sell each non-USDC leg into USDC via Jupiter -- atomically in one
      // wallet approval where it fits.
      const isPureUsdcReserve = assets.length === 1 && assets[0].mint === MAINNET_USDC_MINT;
      if (isPureUsdcReserve) {
        const { signature } = await executeDirectRedeem({
          connection,
          wallet: walletCtx,
          reserve: reserveAddress,
          reserveTokenMint: new PublicKey(dtr.onChain.reserveTokenMint),
          vaultAuthority: new PublicKey(dtr.onChain.vaultAuthority),
          assets,
          reserveTokenSupplyRaw: live.reserveTokenSupplyRaw,
          redemptionFeeBps: BigInt(live.redemptionFeeBps),
          reserveTokensToRedeem,
          onProgress: (e) => setSellPhase(e.phase === "awaiting-wallet" ? "awaiting-wallet" : "confirming"),
        });
        setSellPhase("confirmed");
        await refreshRealReserveNow();
        recordConfirmedTrade(dtr.id, "sell", numSellAmount, numSellAmount * (dtr.nav || 1));
        setSellAmount("");
        toast(transactionConfirmedToast(signature, "Sell confirmed"));
      } else {
        const result = await executeMultiAssetSellMainnet({
          connection,
          wallet: walletCtx,
          reserve: reserveAddress,
          reserveTokenMint: new PublicKey(dtr.onChain.reserveTokenMint),
          vaultAuthority: new PublicKey(dtr.onChain.vaultAuthority),
          assets,
          reserveTokenSupplyRaw: live.reserveTokenSupplyRaw,
          redemptionFeeBps: BigInt(live.redemptionFeeBps),
          reserveTokensToRedeem,
          onProgress: (e) => {
            if (e.phase === "building") {
              setMultiAssetSellStep("Building every transaction of your sale (one request)...");
              setSellPhase("preparing");
            } else if (e.phase === "confirming") {
              setMultiAssetSellStep(`Confirming ${e.what} on Solana Mainnet (${e.signature.slice(0, 8)}...)...`);
              setSellPhase("confirming");
            } else if (e.phase === "single-transaction") {
              setMultiAssetSellStep("One transaction: your Reserve Tokens are redeemed and every asset sold into USDC -- a single wallet approval.");
              setSellPhase("preparing");
            } else if (e.phase === "redeeming") {
              setMultiAssetSellStep("Redeeming your Reserve Tokens for the Reserve's assets...");
              setSellPhase("preparing");
            } else if (e.phase === "swapping") {
              setMultiAssetSellStep(`Selling Reserve asset ${e.index + 1} of ${e.total} into USDC...`);
              setSellPhase("awaiting-wallet");
            } else {
              setSellPhase("awaiting-wallet");
            }
          },
        });
        setMultiAssetSellStep(null);
        setSellPhase("confirmed");
        await refreshRealReserveNow();
        const usdcReceived = Number(result.usdcReceivedRaw) / 1e6;
        recordConfirmedTrade(dtr.id, "sell", numSellAmount, usdcReceived);
        setSellAmount("");
        toast({
          title: "Sell confirmed",
          description: `You received ${usdcReceived.toFixed(2)} USDC (verified from your wallet's real balance). Signature: ${result.signature}`,
        });
      }
    } catch (e) {
      if (e instanceof AmbiguousConfirmationError) {
        setSellPhase("unresolved");
        setSellPendingSignature(e.signature);
        toast({ title: "Mainnet RPC is temporarily busy", description: "No confirmation could be verified yet -- your transaction may still be confirming. Checking your real balance now." });
        await reconcileSell(e.signature);
      } else {
        setMultiAssetSellStep(null);
        setSellPhase("failed");
        const raw = e instanceof Error ? e.message : "The redemption failed.";
        console.error("Sell failed:", raw);
        // Same gap/reasoning as handleBuyMainnet's catch above -- see
        // isMultiAssetSellUnsupported's own header for why this should be
        // unreachable from the UI; kept as an honest fallback regardless.
        const isSingleAssetGap = raw.includes("no supported way to buy into or sell from a multi-asset Reserve");
        toast({
          variant: "destructive",
          title: "Sell Failed",
          description: isSingleAssetGap
            ? "This Reserve holds more than one asset -- there is no supported way to sell/redeem from a multi-asset Reserve on Mainnet yet. No funds were moved."
            : `Your redemption could not be completed: ${raw} No funds were moved.`,
        });
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

  const onSellClick = isOnChain ? (IS_MAINNET ? handleSellMainnet : handleSell) : handleSellUnavailable;

  // On DevNet, SETTLEMENT_MINT (devUSDC) is SSR.fun's universal purchasing
  // currency, never required to be one of a Reserve's own underlying assets
  // (see docs/project/DECISION_LOG.md's Buy architecture correction). On
  // Mainnet that held for every Reserve only while every Reserve was
  // genuinely USDC-only; a Reserve like "alpha" (100% SSR) breaks that, so
  // resolveBuyAsset above is what actually decides the deposit currency, and
  // settlementBalanceRaw is already fetched against THAT mint (see
  // refreshRealReserveNow/the initial-mount effect above) -- this just
  // converts it to human units with the matching decimals.
  const buyAssetForDisplay = resolveBuyAsset(dtr.onChain);
  // Wrapped SOL is a real exception to "settlementBalanceRaw is already
  // fetched against THAT mint" above: fetchTokenBalanceRaw reads an SPL
  // token-account balance, but a normal wallet holds NATIVE SOL, not
  // pre-wrapped SOL -- confirmed live: "Insufficient SOL Balance" shown for
  // a wallet that genuinely held 3.4472 real SOL (2026-08-24, road-to-mainnet
  // MMT-01), because this was reading (and directClient.ts's Buy transaction
  // was requiring) an SPL balance nothing had ever funded. wallet.sol is the
  // store's own real, chain-synced NATIVE balance (see syncWalletFromChain);
  // use it here instead whenever the deposit asset is wrapped SOL. The Buy
  // transaction itself now wraps the deposited amount as part of minting
  // (see directClient.ts's executeDirectMint), so this balance check is
  // finally checking the same thing the transaction actually needs.
  const isBuyAssetWrappedSol = buyAssetForDisplay.mint.equals(WRAPPED_SOL_MINT);
  const settlementBalanceHuman = isBuyAssetWrappedSol ? wallet.sol : Number(settlementBalanceRaw) / 10 ** buyAssetForDisplay.decimals;
  // "Available" for the quick-select buttons: always the trader's real,
  // chain-confirmed settlement-asset balance -- never a hardcoded fallback,
  // and never gated on this Reserve's asset composition. When depositing
  // native SOL, reserve a small buffer for this same transaction's own
  // network fee/rent -- unlike every other deposit asset, wrapping SOL
  // spends directly out of the SAME balance the fee is paid from, so
  // offering the full balance as "Max" would leave nothing to pay the fee
  // with and the transaction would fail outright.
  const SOL_FEE_RESERVE = 0.01;
  const buyAvailable = isOnChain ? buyAvailableFromDevUsdcBalance(isBuyAssetWrappedSol ? settlementBalanceHuman - SOL_FEE_RESERVE : settlementBalanceHuman) : 0;
  const buyInsufficientBalance = isOnChain && numBuyAmount > settlementBalanceHuman;
  // True when EVERY one of this Reserve's registered assets is the
  // settlement asset itself -- the only composition where Buy/Sell involve
  // no swap-authority conversion at all: mint_reserve_tokens_in_kind's own
  // transfer_checked moves the user's real settlement-asset balance straight
  // into the vault on Buy, and redeem_reserve_tokens_in_kind deposits it
  // straight back into the user's wallet on Sell. Mainnet Reserves are
  // USDC-only for this launch (see SETTLEMENT_MINT above), so this is always
  // true for them. Used only for messaging nuance below (which disclosure to
  // show), not for gating -- see isSettlementBuySupported.
  const isPureSettlementReserve =
    isOnChain && !!dtr.onChain && isReservePureDevUsdc(dtr.onChain.assets.map((a) => a.mint), SETTLEMENT_MINT.toBase58());
  // True for ANY Reserve composed entirely of site-wide supported assets
  // (see packages/sdk/src/tradableAssets.ts, the same eligibility check that
  // already determines whether a Reserve is discoverable/visible anywhere on
  // the site at all). On DevNet a non-settlement leg is funded by the swap
  // authority minting that exact test asset to the buyer (Buy) or converting
  // the redeemed amount into devUSDC for the seller (Sell) -- see
  // api/devnet/swap-sign.ts. In practice this should always be true for any
  // Reserve that reaches this page, since an ineligible Reserve is filtered
  // out of the app's catalogue entirely before it could ever be opened here;
  // kept as an explicit, independently-checked gate rather than assumed.
  //
  // NOTE (DEC-0158): both Buy and Sell now have full multi-asset Mainnet
  // paths (multiAssetBuyClient.ts / multiAssetSellClient.ts) -- being
  // multi-asset no longer gates anything; routing is decided by
  // composition (pure-USDC vs USDC-settled) below.
  // The USDC-funded Buy path (multiAssetBuyClient.ts) serves EVERY Mainnet
  // Reserve except one composed purely of USDC (which deposits USDC
  // directly, no swap) -- the funding invariant (DEC-0151): a buyer supplies
  // only USDC; any needed constituent asset is acquired by a real Jupiter
  // swap inside the flow, never demanded from the buyer's own holdings.
  // Confirmed live gap this closes: ALPHA (100% SSR) previously demanded the
  // buyer already hold SSR itself.
  const isUsdcFundedBuyMainnetReserve =
    IS_MAINNET && isOnChain && !!dtr.onChain && dtr.onChain.assets.length > 0 && !(dtr.onChain.assets.length === 1 && dtr.onChain.assets[0].mint === MAINNET_USDC_MINT);
  const onBuyClick = isOnChain ? (IS_MAINNET ? (isUsdcFundedBuyMainnetReserve ? handleBuyMultiAssetMainnet : handleBuyMainnet) : handleBuy) : handleBuyUnavailable;
  // True for ANY Reserve composed entirely of site-wide supported assets
  // (see packages/sdk/src/tradableAssets.ts, the same eligibility check that
  // already determines whether a Reserve is discoverable/visible anywhere on
  // the site at all). On DevNet a non-settlement leg is funded by the swap
  // authority minting that exact test asset to the buyer (Buy) or converting
  // the redeemed amount into devUSDC for the seller (Sell) -- see
  // api/devnet/swap-sign.ts. In practice this should always be true for any
  // Reserve that reaches this page, since an ineligible Reserve is filtered
  // out of the app's catalogue entirely before it could ever be opened here;
  // kept as an explicit, independently-checked gate rather than assumed.
  const isSettlementBuySupported = isOnChain && !!dtr.onChain && isReserveTradable(dtr.onChain.assets.map((a) => a.mint));
  // Sell is supported for every on-chain Reserve (DEC-0158): a pure-USDC
  // Reserve redeems USDC directly; every other composition routes through
  // the USDC-settled sell (redeem in-kind + sell each leg into USDC via
  // Jupiter -- multiAssetSellClient.ts).
  const isSettlementSellSupported = isOnChain && !!dtr.onChain;
  // Reason the 25/50/75/Max quick-select buttons can't be used right now, if
  // any -- distinct from buyProcessing (mid-transaction) so the UI can show
  // an honest "why" instead of a plain disabled control. Deliberately NOT
  // gated on Reserve composition -- filling the input with a real
  // balance-derived amount is always meaningful, even for a Reserve whose
  // Buy execution is separately disabled below.
  const buyPctUnavailableReason: string | null = !wallet.connected
    ? null // handled by the existing !wallet.connected disabled check
    : settlementBalanceStatus === "loading"
      ? `Confirming your real ${buyAssetForDisplay.symbol} balance...`
      : settlementBalanceStatus === "unavailable"
        ? `Your ${buyAssetForDisplay.symbol} balance couldn't be read from ${CLUSTER_LABEL} right now.`
        : null;

  const setBuyPct = (pct: number) => {
    if (wallet.connected && settlementBalanceStatus === "ready") {
      setBuyAmount((buyAvailable * pct).toString());
      setBuyPctSelected(pct);
    }
  };

  const setSellPct = (pct: number) => {
    if (wallet.connected && holding) {
      setSellAmount((holding.tokenBalance * pct).toString());
      setSellPctSelected(pct);
    }
  };

  return (
    <div className="container mx-auto px-4 md:px-8 py-8">
      {/* Top row mirrors the page grid so the section-nav pill's right edge
          lines up exactly with the chart card's. Sticky just below the main
          nav (60px tall) so the section pills stay reachable while scrolling;
          top is inline because FABLE's unlayered resets outrank layered
          Tailwind utilities on some elements. */}
      <div
        className="grid grid-cols-1 lg:grid-cols-3 gap-8 mb-6 sticky z-30 py-2.5 -mx-2 px-2 rounded-b-2xl"
        // top = the main nav's full height (60px row + 1px border) so the bar
        // stays flush against it while scrolling; opaque page-ground background
        // so it never reads as a separate translucent band.
        style={{ top: 61, background: "hsl(var(--background))" }}
      >
        <div className="lg:col-span-2 flex items-center gap-4">
          <Link href="/" className="inline-flex items-center text-sm text-muted-foreground hover:text-primary transition-colors shrink-0">
            <ChevronLeft className="w-4 h-4 mr-1" /> Back to Directory
          </Link>
          <SectionNav />
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        {/* Left Column: Details & Charts */}
        <div className="lg:col-span-2 space-y-8">
          {/* Chart + stat sheets: one visual unit — the stat cards tuck
              under the chart card like pages sliding out of a folder. */}
          <div id="section-chart" className="scroll-mt-32">
            {/* Chart Section */}
            <Card className="relative z-10 bg-card border-card-border hover:shadow-md transition-shadow duration-300">
              <CardHeader className="flex flex-col gap-3 pb-2 max-sm:p-4 max-sm:gap-2 max-sm:pb-1">
                {/* Reserve identity lives in the chart card (top-left) now that
                    the chart leads the page, in line with the Buy/Sell panel. */}
                <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1.5">
                  <div className="flex items-center gap-2.5">
                    <Avatar className="h-8 w-8 border border-border">
                      {dtr.logoUrl && <AvatarImage src={dtr.logoUrl} alt={dtr.ticker} />}
                      <AvatarFallback className="bg-primary/10 text-primary text-xs font-merge-display font-bold">
                        {dtr.ticker.slice(0, 2)}
                      </AvatarFallback>
                    </Avatar>
                    <h1 className="text-2xl max-sm:text-lg font-merge-display font-bold tracking-tight">{dtr.name}</h1>
                    <Badge variant="secondary" className="font-merge-mono text-sm">{dtr.ticker}</Badge>
                  </div>
                  <div className="text-right max-sm:text-left shrink-0">
                    <p className="text-[10px] text-muted-foreground uppercase tracking-wider font-semibold">Token Price</p>
                    <div className="flex items-baseline justify-end max-sm:justify-start gap-1.5">
                      <span className={`font-merge-mono font-semibold text-foreground ${pricingUnavailable ? "text-sm" : "text-base"}`}>
                        {formatUsdcOrUnavailable(dtr.tokenPrice, !pricingUnavailable)}
                      </span>
                      {!pricingUnavailable && (
                        <span
                          className={`text-xs font-merge-mono ${allTimeChangePct === null ? "text-muted-foreground" : allTimeChangePct >= 0 ? "text-positive" : "text-destructive"}`}
                          title="All-time change in Token Price since launch"
                        >
                          {allTimeChangePct === null ? "—" : `${allTimeChangePct >= 0 ? "+" : ""}${allTimeChangePct.toFixed(2)}%`}
                        </span>
                      )}
                    </div>
                    {isOnChain && IS_MAINNET && priceSourceLabel && (
                      <p className="text-[11px] text-muted-foreground/70 mt-1">
                        via {priceSourceLabel}{priceAgeLabel ? ` · updated ${priceAgeLabel}` : ""}
                        {dtr.onChain?.priceSource === "mixed" && " (per-asset)"}
                      </p>
                    )}
                    {pricingUnavailable && dtr.onChain?.unpricedAssetMints && dtr.onChain.unpricedAssetMints.length > 0 && (
                      <p className="text-[11px] text-muted-foreground/70 mt-1">
                        No verified Pyth or Jupiter price for {dtr.onChain.assets.find((a) => a.mint === dtr.onChain!.unpricedAssetMints![0])?.symbol ?? "this Reserve's asset"} right now.
                      </p>
                    )}
                  </div>
                </div>
                <div className="flex flex-col gap-3 max-sm:gap-2 lg:flex-row lg:items-center lg:justify-between">
                <CardTitle className="text-lg max-sm:text-base font-merge-display flex items-center gap-2">
                  <Activity className="w-5 h-5 max-sm:w-4 max-sm:h-4 text-primary" /> Price History
                </CardTitle>
                <div className="flex flex-wrap items-center gap-3">
                  <ChartTimeframeSelector timeframe={timeframe} onChange={setTimeframe} />
                  <div className="flex items-center gap-1" role="group" aria-label="Chart style">
                    {(["line", "candles"] as const).map((style) => (
                      <button
                        key={style}
                        type="button"
                        onClick={() => setChartStyle(style)}
                        aria-pressed={chartStyle === style}
                        disabled={style === "candles" && !candlesUsable}
                        className={`inline-flex h-7 items-center rounded-md px-2 text-xs font-medium capitalize transition-colors disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                          (style === "candles") === showCandles
                            ? "text-foreground font-semibold"
                            : "text-muted-foreground hover:text-foreground"
                        }`}
                      >
                        {style}
                      </button>
                    ))}
                  </div>
                  {showCandles && (
                    <span className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
                      <span className="inline-block w-4 h-[2px] rounded-full" style={{ background: "#97abef" }} aria-hidden="true" />
                      EMA 8
                    </span>
                  )}
                </div>
                </div>
              </CardHeader>
              <CardContent className="p-0 sm:p-6 sm:pt-0 h-[350px] w-full relative">
                {lineSeries.unavailable ? (
                  <div className="h-full w-full flex flex-col items-center justify-center gap-2 text-center px-6">
                    <p className="text-sm font-semibold text-muted-foreground">Price unavailable</p>
                    <p className="text-xs text-muted-foreground/80 max-w-xs">
                      This Reserve's current NAV could not be read. Its price chart will appear once a valid NAV is available.
                    </p>
                  </div>
                ) : (
                  <>
                    {designDemo ? (
                      <p className="absolute top-1 sm:top-2 left-1/2 -translate-x-1/2 text-[11px] text-muted-foreground/70 z-10">
                        Design preview — synthetic data, not recorded trades.
                      </p>
                    ) : lineSeries.isFallback ? (
                      <p className="absolute top-1 sm:top-2 left-1/2 -translate-x-1/2 text-[11px] text-muted-foreground/70 z-10">
                        No price movement recorded yet.
                      </p>
                    ) : preRecordedSegmentNote && (
                      <p className="absolute top-1 sm:top-2 left-1/2 -translate-x-1/2 text-[11px] text-muted-foreground/70 z-10 whitespace-nowrap max-w-full truncate px-2">
                        {preRecordedSegmentNote}
                      </p>
                    )}
                    <ResponsiveContainer width="100%" height="100%">
                    {showCandles ? (
                      <ComposedChart data={candleData} margin={{ top: 20, right: 8, bottom: 20, left: 20 }}>
                        <XAxis
                          dataKey="xKey"
                          stroke="hsl(var(--muted-foreground))"
                          fontSize={12}
                          tickLine={false}
                          axisLine={false}
                          minTickGap={40}
                          tickFormatter={(v: string) => v.split("\u200b")[0]}
                        />
                        <YAxis
                          orientation="right"
                          domain={yDomain}
                          stroke="hsl(var(--muted-foreground))"
                          fontSize={12}
                          tickCount={4}
                          tickLine={false}
                          axisLine={false}
                          tickFormatter={(value) => `$${value.toFixed(2)}`}
                          width={62}
                        />
                        {/* isAnimationActive off: the tooltip snaps to the cursor
                            instead of flying between candles. */}
                        <RechartsTooltip content={<CandleTooltip />} isAnimationActive={false} cursor={{ stroke: "hsl(var(--muted-foreground))", strokeDasharray: "4 4" }} />
                        {noteMarkers.map((m) => (
                          <ReferenceLine
                            key={m.key}
                            x={m.xKey}
                            ifOverflow="visible"
                            stroke="hsl(var(--muted-foreground))"
                            strokeDasharray="4 4"
                            strokeOpacity={0.5}
                            label={<NoteMarkerLabel text={m.tag} level={m.level} />}
                          />
                        ))}
                        {launchMarker && (
                          <ReferenceLine
                            x={launchMarker}
                            stroke="hsl(var(--muted-foreground))"
                            strokeDasharray="4 4"
                            label={<NoteMarkerLabel text="Reserve Launch" level={2} />}
                          />
                        )}
                        <defs>
                          {/* Line fades out toward the left: full periwinkle at the
                              recent (right) edge, dissolving into the chart's past. */}
                          <linearGradient id="emaStroke" x1="0" y1="0" x2="1" y2="0">
                            <stop offset="0%" stopColor="#97abef" stopOpacity={0} />
                            <stop offset="55%" stopColor="#97abef" stopOpacity={0.55} />
                            <stop offset="100%" stopColor="#97abef" stopOpacity={0.95} />
                          </linearGradient>
                          {/* Soft vertical wash under the line: page-paper #f0f2f8 at the
                              top fading into the card's white below. */}
                          <linearGradient id="emaFill" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="0%" stopColor="#97abef" stopOpacity={0.22} />
                            <stop offset="100%" stopColor="#97abef" stopOpacity={0} />
                          </linearGradient>
                        </defs>
                        {/* Declared before the candles so the whole EMA layer renders
                            BENEATH them — a backdrop guide, not a foreground series. */}
                        <Area
                          type="monotone"
                          dataKey="ema8"
                          stroke="url(#emaStroke)"
                          strokeWidth={1.75}
                          fill="url(#emaFill)"
                          dot={false}
                          activeDot={false}
                          connectNulls={false}
                          isAnimationActive={false}
                        />
                        <Bar dataKey="range" shape={<CandleShape />} isAnimationActive={false} />
                      </ComposedChart>
                    ) : (
                    <AreaChart data={chartData} margin={{ top: 20, right: 8, bottom: 20, left: 20 }}>
                      <defs>
                        <linearGradient id="priceGradient" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor="hsl(var(--primary))" stopOpacity={0.16} />
                          <stop offset="100%" stopColor="hsl(var(--primary))" stopOpacity={0} />
                        </linearGradient>
                      </defs>
                      <XAxis
                        dataKey="xKey"
                        stroke="hsl(var(--muted-foreground))"
                        fontSize={12}
                        tickLine={false}
                        axisLine={false}
                        minTickGap={30}
                        tickFormatter={(v: string) => v.split("\u200b")[0]}
                      />
                      <YAxis
                        orientation="right"
                        domain={yDomain}
                        stroke="hsl(var(--muted-foreground))"
                        fontSize={12}
                        tickCount={4}
                        tickLine={false}
                        axisLine={false}
                        tickFormatter={(value) => `$${value.toFixed(2)}`}
                        width={62}
                      />
                      <RechartsTooltip
                        isAnimationActive={false}
                        contentStyle={{ backgroundColor: 'hsl(var(--card))', borderColor: 'hsl(var(--card-border))', borderRadius: '0.75rem', boxShadow: 'var(--shadow-md)', color: 'hsl(var(--foreground))' }}
                        itemStyle={{ color: 'hsl(var(--primary))', fontWeight: 'bold' }}
                        labelStyle={{ color: 'hsl(var(--muted-foreground))', marginBottom: '4px' }}
                        formatter={(value) => [formatUsdc(Number(value)), "Price"]}
                      />
                      {noteMarkers.map((m) => (
                        <ReferenceLine
                          key={m.key}
                          x={m.xKey}
                          ifOverflow="visible"
                          stroke="hsl(var(--muted-foreground))"
                          strokeDasharray="4 4"
                          strokeOpacity={0.5}
                          label={<NoteMarkerLabel text={m.tag} level={m.level} />}
                        />
                      ))}
                      {launchMarker && (
                        <ReferenceLine
                          x={launchMarker}
                          stroke="hsl(var(--muted-foreground))"
                          strokeDasharray="4 4"
                          label={<NoteMarkerLabel text="Reserve Launch" level={2} />}
                        />
                      )}
                      <Area
                        type="monotone"
                        dataKey="price"
                        stroke="hsl(var(--primary))"
                        strokeWidth={2}
                        fill="url(#priceGradient)"
                        dot={false}
                        isAnimationActive={false}
                        activeDot={{ r: 6, fill: "hsl(var(--primary))", stroke: "hsl(var(--background))", strokeWidth: 2 }}
                      />
                    </AreaChart>
                    )}
                    </ResponsiveContainer>
                  </>
                )}
              </CardContent>
            </Card>
            {/* Stats Grid -- AUM and Prem/Discount removed per explicit request
                (2026-08-24, road-to-mainnet MCR-01): Market Cap already showed
                the same number as AUM (both are Circulating Supply x Token
                Price today -- there's no secondary market yet, so Token Price
                IS NAV, per Market Cap's own InfoTip), and Prem/Discount is
                always ~0% for the same reason -- neither carried information
                Market Cap didn't already show. */}
            {/* One full-width periwinkle band flowing out from under the chart
                card: its top 16px hide behind the (opaque, z-10) card, only its
                rounded bottom shows — a sheet sliding out of the folder. */}
            <div
              className="-mt-4 rounded-b-xl px-6 pt-9 pb-4"
              style={{ background: "linear-gradient(180deg, hsl(var(--secondary) / 0.7) 0%, hsl(var(--card)) 100%)" }}
            >
              <div className="grid grid-cols-2 md:grid-cols-3 md:divide-x md:divide-foreground/10">
                <div className="md:pr-6">
                  <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-1.5">
                    Market Cap
                    <InfoTip label="More information about Market Cap">Circulating Reserve Token supply x Token Price. Token Price here IS this protocol's internal NAV -- there's no secondary market yet, every Buy/Sell executes at NAV.</InfoTip>
                  </div>
                  <p className={`font-merge-mono font-semibold ${pricingUnavailable ? 'text-sm' : 'text-lg'}`}>{formatUsdcOrUnavailable(marketCap, !pricingUnavailable, { compact: true })}</p>
                </div>
                <div className="md:px-6">
                  <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-1.5">
                    All-Time Performance
                    <InfoTip label="More information about All-Time Performance">Change in Token Price since this Reserve launched: today's price versus the value of its holdings at the prices they were first added at -- the same baseline as the P&L % column in the Reserve Composition table below.</InfoTip>
                  </div>
                  <p className={`font-merge-mono font-semibold ${allTimeChangePct === null ? 'text-sm text-muted-foreground' : allTimeChangePct >= 0 ? 'text-lg text-positive' : 'text-lg text-destructive'}`}>
                    {allTimeChangePct === null ? 'Not yet available' : `${allTimeChangePct >= 0 ? '+' : ''}${allTimeChangePct.toFixed(2)}%`}
                  </p>
                </div>
                <div className="md:px-6">
                  <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-1.5">
                    All-Time Volume
                    <InfoTip label="More information about All-Time Volume">Sum of every confirmed Buy and Sell for this Reserve since it launched{IS_MAINNET ? ", valued in USD at the time each trade was recorded." : ", valued at fixed DevNet test prices."}</InfoTip>
                  </div>
                  <p className="text-lg font-merge-mono font-semibold">
                    {isOnChain ? (
                      reserveStats ? (
                        typeof reserveStats.volumeAllTimeUsd === "number" ? (
                          <>
                            {formatUsdc(reserveStats.volumeAllTimeUsd, { compact: true })}
                            {landingStats.stale && <span className="text-xs text-muted-foreground font-normal"> (stale)</span>}
                          </>
                        ) : (
                          <span className="text-sm text-muted-foreground font-normal">Unavailable</span>
                        )
                      ) : landingStats.status === "loading" ? (
                        <span className="text-sm text-muted-foreground font-normal">Loading…</span>
                      ) : (
                        <span className="text-sm text-muted-foreground font-normal">Unavailable</span>
                      )
                    ) : (
                      formatUsdc(0, { compact: true })
                    )}
                  </p>
                </div>
              </div>
            </div>
          </div>
          
          {/* About Section — the Reserve's name/avatar moved into the chart
              card above; this block keeps the badges, holders, and description.
              px-6 aligns its text with the inner padding of the cards around
              it (it has no card chrome of its own). */}
          <div id="section-about" className="flex flex-col md:flex-row md:items-start justify-between gap-6 px-6 scroll-mt-32">
            <div className="flex items-start gap-5">
              <div>
                <h2 className="text-lg font-merge-display font-semibold tracking-tight mb-5">About this Reserve</h2>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm text-muted-foreground mb-5">
                  <Badge variant="outline" className="bg-background/50 border-border">{normalizeReserveCategory(dtr.category)}</Badge>
                  {isWindingDown && (
                    <Badge variant="outline" className="uppercase text-[10px] tracking-wide border-amber-500/50 text-amber-600 dark:text-amber-400">
                      Wind Down
                    </Badge>
                  )}
                  <Badge variant={isOnChain ? "default" : "secondary"} className="uppercase text-[10px] tracking-wide">
                    {isOnChain ? `Live on Solana ${CLUSTER_LABEL}` : "Simulated Demo"}
                  </Badge>
                  <span>
                    {isOnChain ? (
                      reserveStats ? (
                        <>
                          {reserveStats.holders.toLocaleString()} {reserveStats.holders === 1 ? "Holder" : "Holders"}
                          {landingStats.stale && <span title="This figure may be a few minutes old"> (stale)</span>}
                        </>
                      ) : landingStats.status === "loading" ? (
                        "Loading holder count…"
                      ) : (
                        "Holder count unavailable"
                      )
                    ) : (
                      `${dtr.holders.toLocaleString()} Holders`
                    )}
                  </span>
                </div>
                <p className="text-muted-foreground leading-relaxed">
                  {dtr.description}
                </p>
              </div>
            </div>
            
            <div className="flex flex-col items-end gap-3 shrink-0">
              {isManagerOrDelegate(dtr, wallet.address) && (
                <Button asChild variant="outline" className="w-full border-primary/50 text-primary hover:bg-primary/10">
                  <Link href={`/dtr/${dtr.id}/manage`}>Manage Reserve</Link>
                </Button>
              )}
            </div>
          </div>

          {isOnChain && dtr.onChain && (
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground px-6">
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
              Live {CLUSTER_LABEL} data could not be refreshed{dtr.chainError ? `: ${dtr.chainError}` : "."} Figures below are the last known
              on-chain state, not necessarily current.
            </div>
          )}
          {isWindingDown && (
            <div className="rounded-lg border border-dashed p-3 text-sm" style={{ borderColor: "var(--warn, #d9a13c)" }}>
              New purchases are disabled. Existing holders can continue to redeem their Reserve Tokens -- your full proportional share,
              at any time before this Reserve closes; there is no deadline forced by this UI.
            </div>
          )}



          {/* Composition Section */}
          <Card id="section-composition" className="bg-card border-card-border hover:shadow-md transition-shadow duration-300 scroll-mt-32">
            <CardHeader>
              <CardTitle className="text-lg font-merge-display flex items-center gap-2">
                <Layers className="w-5 h-5 text-primary" /> Reserve Composition
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex flex-col gap-5">
                <div className="w-full">
                  <WeightPill items={compositionDisplay.map((a) => ({ symbol: a.symbol, weight: a.weight }))} />
                  {designDemo && (
                    <p className="mt-1.5 text-[11px] text-muted-foreground/70">
                      Design preview — illustrative composition.
                    </p>
                  )}
                </div>

                <div className="flex-1 w-full overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow className="border-border/50">
                        <TableHead>Asset</TableHead>
                        <TableHead className="text-right">Weight</TableHead>
                        <TableHead className="text-right hidden sm:table-cell">Price</TableHead>
                        <TableHead className="text-right hidden sm:table-cell">Value in Reserve</TableHead>
                        <TableHead className="text-right hidden sm:table-cell">
                          P&amp;L %
                        </TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {compositionDisplay.map((asset) => {
                        // Row dot matches the asset's treemap tile: colors are
                        // assigned by descending-weight rank in both places.
                        const weightRank = [...compositionDisplay]
                          .sort((a, b) => b.weight - a.weight)
                          .findIndex((s) => s.symbol === asset.symbol);
                        const tileColor = SSR_TILE_COLORS[weightRank % SSR_TILE_COLORS.length].bg;
                        // Design preview rows carry their own illustrative
                        // price/value/P&L (see designDemo.ts).
                        const demoAsset = designDemo?.composition.find((d) => d.symbol === asset.symbol);
                        // Real on-chain assets carry a mint (matched by
                        // symbol against dtr.onChain.assets), which is what
                        // both the real balance-based value and the P&L %
                        // calc need. A purely simulated/demo Reserve has no
                        // real balances at all, so it keeps the prior
                        // weight-of-AUM estimate and shows no P&L (nothing
                        // to compute it from).
                        const onChainAsset = dtr.onChain?.assets.find((a) => a.symbol === asset.symbol);
                        // On Mainnet, price each asset from the SAME real,
                        // validated Pyth/Jupiter data AUM/Token Price already
                        // use (dtr.onChain.assetPricesUsd -- see
                        // onChainReserve.ts's extractAssetPricesUsd), never
                        // the DevNet-only TEST_ASSET_PRICES_USD fixture
                        // table, which has no real entry for most Mainnet
                        // assets and silently priced every one of them at $0
                        // here (2026-08-24, road-to-mainnet MCR-01) even
                        // after DEC-0134 fixed this same class of bug for
                        // AUM/Token Price/the Buy estimate elsewhere on this
                        // page. `unitPriceUsd` is null (never fabricated 0)
                        // when this pass genuinely couldn't price the asset.
                        const unitPriceUsd = demoAsset
                          ? demoAsset.priceUsd
                          : !onChainAsset
                            ? null
                            : IS_MAINNET
                              ? (dtr.onChain!.assetPricesUsd?.[onChainAsset.mint] ?? null)
                              : (TEST_ASSET_PRICES_USD[onChainAsset.mint] ?? null);
                        const balance = onChainAsset ? Number(dtr.onChain!.vaultBalancesRaw[onChainAsset.mint] ?? "0") / 10 ** onChainAsset.decimals : null;
                        const valueUsd = demoAsset
                          ? demoAsset.valueUsd
                          : onChainAsset
                            ? (unitPriceUsd !== null ? balance! * unitPriceUsd : null)
                            : asset.weight * dtr.aum;
                        // P&L baseline: the asset's ENTRY price -- on Mainnet
                        // the server-captured price it had when it was first
                        // seen inside this Reserve (assetEntryPricesUsd, see
                        // entryPriceClient.ts); on DevNet the same fixture
                        // table as the current price, so 0.00% is genuine
                        // there (fixture prices never move). calcAssetPnlPct
                        // returns null (rendered "--") when either side is
                        // missing -- never a fabricated 0%.
                        const entryPriceUsd = !onChainAsset
                          ? null
                          : IS_MAINNET
                            ? (dtr.onChain!.assetEntryPricesUsd?.[onChainAsset.mint] ?? null)
                            : (TEST_ASSET_PRICES_USD[onChainAsset.mint] ?? null);
                        const pnlPct = demoAsset ? demoAsset.pnlPct : calcAssetPnlPct(unitPriceUsd, entryPriceUsd);
                        const isExpanded = expandedAsset === asset.symbol;
                        return (
                          <Fragment key={asset.symbol}>
                          <TableRow
                            className={`border-border/50 cursor-pointer transition-colors ${isExpanded ? "bg-secondary/40" : "hover:bg-secondary/30"}`}
                            onClick={() => setExpandedAsset((cur) => (cur === asset.symbol ? null : asset.symbol))}
                            aria-expanded={isExpanded}
                          >
                            <TableCell className="font-medium">
                              <div className="flex items-center gap-2">
                                <div className="w-3 h-3 rounded-full" style={{ backgroundColor: tileColor }} />
                                {asset.name} <span className="text-muted-foreground font-normal ml-1">{asset.symbol}</span>
                              </div>
                            </TableCell>
                            <TableCell className="text-right font-merge-mono font-semibold text-primary">
                              {(asset.weight * 100).toFixed(2)}%
                            </TableCell>
                            <TableCell className="text-right font-merge-mono text-muted-foreground hidden sm:table-cell">
                              {onChainAsset || demoAsset ? formatAssetPriceUsd(unitPriceUsd) : "—"}
                            </TableCell>
                            <TableCell className="text-right font-merge-mono text-muted-foreground hidden sm:table-cell">
                              {valueUsd === null ? "Price unavailable" : formatUsdc(valueUsd, { compact: true })}
                            </TableCell>
                            <TableCell className="text-right font-merge-mono hidden sm:table-cell">
                              {pnlPct === null ? (
                                <span className="text-muted-foreground">&mdash;</span>
                              ) : (
                                <span className={pnlPct > 0 ? "text-positive" : pnlPct < 0 ? "text-destructive" : "text-muted-foreground"}>
                                  {pnlPct > 0 ? "+" : ""}{pnlPct.toFixed(2)}%
                                </span>
                              )}
                            </TableCell>
                          </TableRow>
                          {isExpanded && (
                            <TableRow className="border-border/50 hover:bg-transparent">
                              <TableCell colSpan={5} className="p-0">
                                <div className="animate-in fade-in slide-in-from-top-2 duration-300">
                                  <div className="h-[220px] py-2">
                                    <AssetMiniChart
                                      seed={`asset:${dtr.id}:${asset.symbol}`}
                                      endPrice={unitPriceUsd ?? 1}
                                      synthetic={Boolean(designDemo)}
                                    />
                                  </div>
                                  {/* Same stat trio as the main chart's band, scoped to this asset. */}
                                  <div
                                    className="px-6 pt-3 pb-4"
                                    style={{ background: "linear-gradient(180deg, hsl(var(--secondary) / 0.7) 0%, hsl(var(--card)) 100%)" }}
                                  >
                                    {/* Mobile only: the table hides its Price / Value / P&L columns
                                        below sm, so the expanded panel surfaces them here. */}
                                    <div className="sm:hidden grid grid-cols-2 gap-x-4 gap-y-3 pb-3 mb-3" style={{ borderBottom: "1px solid hsl(var(--foreground) / 0.08)" }}>
                                      <div>
                                        <p className="text-xs text-muted-foreground mb-1">Price</p>
                                        <p className="text-base font-merge-mono font-semibold">{onChainAsset || demoAsset ? formatAssetPriceUsd(unitPriceUsd) : "—"}</p>
                                      </div>
                                      <div>
                                        <p className="text-xs text-muted-foreground mb-1">Value in Reserve</p>
                                        <p className="text-base font-merge-mono font-semibold">{valueUsd === null ? "—" : formatUsdc(valueUsd, { compact: true })}</p>
                                      </div>
                                      <div>
                                        <p className="text-xs text-muted-foreground mb-1">P&L %</p>
                                        {pnlPct === null ? (
                                          <p className="text-base font-merge-mono font-semibold text-muted-foreground">—</p>
                                        ) : (
                                          <p className={`text-base font-merge-mono font-semibold ${pnlPct > 0 ? "text-positive" : pnlPct < 0 ? "text-destructive" : "text-muted-foreground"}`}>
                                            {pnlPct > 0 ? "+" : ""}{pnlPct.toFixed(2)}%
                                          </p>
                                        )}
                                      </div>
                                    </div>
                                    <div className="grid grid-cols-2 md:grid-cols-3 md:divide-x md:divide-foreground/10">
                                      <div className="md:pr-6">
                                        <p className="text-xs text-muted-foreground mb-1">Market Cap</p>
                                        <p className="text-base font-merge-mono font-semibold">
                                          {demoAsset ? formatUsdc(demoAsset.marketCapUsd, { compact: true }) : "—"}
                                        </p>
                                      </div>
                                      <div className="md:px-6">
                                        <p className="text-xs text-muted-foreground mb-1">7D Performance</p>
                                        {demoAsset ? (
                                          <p className={`text-base font-merge-mono font-semibold ${demoAsset.change7dPct >= 0 ? "text-positive" : "text-destructive"}`}>
                                            {demoAsset.change7dPct >= 0 ? "+" : ""}{demoAsset.change7dPct.toFixed(2)}%
                                          </p>
                                        ) : (
                                          <p className="text-base font-merge-mono font-semibold text-muted-foreground">+0.00%</p>
                                        )}
                                      </div>
                                      <div className="md:px-6">
                                        <p className="text-xs text-muted-foreground mb-1">24h Volume</p>
                                        <p className="text-base font-merge-mono font-semibold">
                                          {demoAsset ? formatUsdc(demoAsset.volume24hUsd, { compact: true }) : (
                                            <span className="text-sm text-muted-foreground font-normal">Unavailable</span>
                                          )}
                                        </p>
                                      </div>
                                    </div>
                                  </div>
                                  {designDemo && (
                                    <p className="pb-2 text-center text-[11px] text-muted-foreground/70">
                                      Design preview — synthetic {asset.symbol} data, not recorded prices.
                                    </p>
                                  )}
                                </div>
                              </TableCell>
                            </TableRow>
                          )}
                          </Fragment>
                        );
                      })}
                    </TableBody>
                  </Table>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Info Table */}
          <Card id="section-addresses" className="bg-card border-card-border hover:shadow-md transition-shadow duration-300 scroll-mt-32">
             <CardContent className="p-0">
               <Table>
                 <TableBody>
                   <TableRow className="border-border/50">
                     <TableCell className="py-4 pl-6 text-muted-foreground">Contract Address</TableCell>
                     <TableCell className="text-right pr-6 font-merge-mono text-xs">{dtr.dtrAddress}</TableCell>
                   </TableRow>
                   <TableRow className="border-border/50">
                     <TableCell className="py-4 pl-6 text-muted-foreground">Manager Address</TableCell>
                     <TableCell className="text-right pr-6 font-merge-mono text-xs">{dtr.managerAddress}</TableCell>
                   </TableRow>
                 </TableBody>
               </Table>
             </CardContent>
          </Card>

        </div>

        {/* Right Column: Trading Panel */}
        <div className="lg:col-span-1">
          {/* z-20 beats the chart card's z-10 so button ripples expanding past
              the panel animate OVER the chart, not behind it. */}
          <div className="sticky top-24 z-20">
            <Card className="border-border shadow-xl bg-card">
              <Tabs value={isWindingDown ? "sell" : tradeTab} onValueChange={(v) => setTradeTab(v as "buy" | "sell")} className="w-full">
                <CardHeader className="pb-4">
                  <TabsList className="grid w-full grid-cols-2">
                    <TabsTrigger value="buy" disabled={isWindingDown} className="buy-tab font-bold data-[state=active]:text-primary disabled:opacity-40 disabled:cursor-not-allowed" title={isWindingDown ? "This Reserve is winding down -- new Buys are disabled." : undefined}>
                      Buy
                    </TabsTrigger>
                    <TabsTrigger value="sell" className="font-bold data-[state=active]:text-destructive">Sell</TabsTrigger>
                  </TabsList>
                </CardHeader>
                
                <CardContent>
                  <TabsContent value="buy" className="mt-0 space-y-4">
                    <div className="flex justify-between items-center text-sm mb-2">
                      <span className="text-muted-foreground">Your {buyAssetForDisplay.symbol} balance</span>
                      <span className="font-merge-mono font-medium">
                        {!wallet.connected
                          ? "—"
                          : !isOnChain
                            ? formatUsdc(buyAvailable)
                            : settlementBalanceStatus === "loading"
                              ? "Loading..."
                              : settlementBalanceStatus === "unavailable"
                                ? "Unavailable"
                                : `${settlementBalanceHuman.toFixed(2)} ${buyAssetForDisplay.symbol}`}
                      </span>
                    </div>

                    <div className="relative">
                      <div className="absolute inset-y-0 right-3 flex items-center pointer-events-none text-muted-foreground font-medium text-sm">
                        {isOnChain ? buyAssetForDisplay.symbol : "USDC"}
                      </div>
                      <Input
                        type="number"
                        placeholder="0.00"
                        className="h-14 bg-background border-border/60 text-lg font-merge-mono pr-16"
                        value={buyAmount}
                        onChange={(e) => {
                          setBuyAmount(e.target.value);
                          setBuyPctSelected(null);
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
                          aria-pressed={buyPctSelected === pct}
                          className={`h-7 rounded-full text-xs font-medium ${
                            buyPctSelected === pct
                              ? "border-primary bg-primary/10 text-primary font-semibold"
                              : "border-border bg-background text-muted-foreground hover:border-primary/40 hover:bg-primary/5 hover:text-primary"
                          }`}
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

                    {isOnChain && isSettlementBuySupported ? (
                      <div className="p-4 bg-muted/20 rounded-lg space-y-3 border border-border/40 mt-6">
                        <div className="flex justify-between text-sm">
                          <span className="text-muted-foreground flex items-center gap-1">
                            Deposit asset
                            <InfoTip label="More information about the deposit asset">
                              {IS_MAINNET
                                ? isUsdcFundedBuyMainnetReserve
                                  ? `Your USDC input funds this Reserve's ${dtr.onChain?.assets.length === 1 ? "underlying asset" : `${dtr.onChain?.assets.length ?? "several"} underlying assets`} for you (via a real Jupiter swap for any part that isn't already USDC or SOL you hold), then mints your Reserve Tokens in one final step. ${dtr.onChain?.assets.length === 1 ? "Two wallet approvals are expected -- one for the swap, one for the mint." : "Several wallet approvals are expected."} You never need to buy the underlying asset${dtr.onChain?.assets.length === 1 ? "" : "s"} yourself.`
                                  : "USDC is this Reserve's sole asset -- your entire input is deposited directly into its vault. No conversion or swap is involved."
                                : `devUSDC ("SSR Test USD") is the DevNet settlement asset -- 1 devUSDC = $1 by design, no price feed involved.${
                                    isPureSettlementReserve
                                      ? " This Reserve is backed 100% by devUSDC, so your entire input is genuinely deposited into its vault."
                                      : " This Reserve holds other DevNet test assets too -- your devUSDC funds the devUSDC-denominated share directly, and the swap adapter mints the exact amount of each other asset this Reserve's allocation requires."
                                  }`}
                            </InfoTip>
                          </span>
                          <span className="font-merge-mono">{SETTLEMENT_SYMBOL}</span>
                        </div>
                        <div className="flex justify-between text-sm">
                          <span className="text-muted-foreground">Mint Fee</span>
                          <span className="font-merge-mono">{dtr.feeConfig.mintFeePct.toFixed(2)}%</span>
                        </div>
                        <div className="pt-3 border-t border-border/50 flex justify-between font-semibold">
                          <span>Est. You Receive</span>
                          {/* A numeric estimate reads as data (mono, primary); the
                              unavailable state is prose — body font, muted, not bold. */}
                          {estReserveTokensOut === null ? (
                            <span className="font-sans font-normal text-muted-foreground">Quote unavailable</span>
                          ) : (
                            <span className="font-merge-mono text-primary">{`~${formatTokenAmount(estReserveTokensOut)} ${dtr.ticker}`}</span>
                          )}
                        </div>
                        <div className="flex justify-between text-sm">
                          <span className="text-muted-foreground">Slippage tolerance</span>
                          <span className="font-merge-mono">2%</span>
                        </div>
                      </div>
                    ) : isOnChain ? (
                      // Defensive fallback only -- a Reserve holding any asset outside the
                      // supported set is excluded from discovery entirely (see
                      // src/merge/lib/onChainReserve.ts's mergeDiscoveredReserves), so this
                      // page should never actually be reachable for one. Kept as an explicit,
                      // honest state rather than assumed unreachable.
                      <div className="p-4 bg-muted/20 rounded-lg space-y-3 border border-destructive/30 mt-6">
                        <p className="text-sm font-semibold text-destructive">Buy not available for this Reserve</p>
                        <p className="text-xs text-muted-foreground">
                          {IS_MAINNET
                            ? "This Reserve holds an asset outside SSR.fun's currently supported Mainnet assets (USDC), so no genuine Buy path exists for it."
                            : "This Reserve holds an asset outside SSR.fun's currently supported DevNet test assets (devUSDC, mockX, mockY, mockZ), so no genuine Buy path exists for it."}
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
                          <InfoTip label="More information about the trading fee">SSR.FUN protocol fee (0.10%)</InfoTip>
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
                            <InfoTip label="More information about price impact">Buys push this Reserve's price up against its liquidity depth -- larger orders move it more.</InfoTip>
                          </span>
                          <span className="font-merge-mono text-positive">+{buyQuote.priceImpactPct.toFixed(2)}% &rarr; {formatUsdc(buyQuote.newPrice)}</span>
                        </div>
                      )}
                    </div>
                    )}

                    {buyPendingSignature && (
                      <div className="rounded-lg border border-dashed p-3 text-sm space-y-2" style={{ borderColor: "var(--warn, #d9a13c)" }}>
                        <p>{CLUSTER_LABEL} RPC is temporarily busy -- your Buy transaction is still being verified. No new transaction has been submitted for it.</p>
                        <a href={explorerUrl("tx", buyPendingSignature)} target="_blank" rel="noreferrer" className="underline">
                          View signature on Solana Explorer ({CLUSTER_LABEL}) &rarr;
                        </a>
                        <div>
                          <Button size="sm" variant="outline" onClick={() => void reconcileBuy(buyPendingSignature)}>
                            Check status
                          </Button>
                        </div>
                      </div>
                    )}

                    <Button
                      className="w-full h-12 text-lg font-bold rounded-full shadow-lg shadow-action/20"
                      // Disconnected is NOT a disabled state: the CTA reads
                      // "Connect Wallet to Trade" and genuinely starts the
                      // connect flow at full action-color strength.
                      onClick={!wallet.connected ? () => setWalletModalOpen(true) : onBuyClick}
                      disabled={
                        wallet.connected &&
                        (buyProcessing ||
                          numBuyAmount <= 0 ||
                          buyInsufficientBalance ||
                          (isOnChain && !isSettlementBuySupported) ||
                          (isOnChain && estReserveTokensOut === null))
                      }
                    >
                      {txPhaseShortLabel(buyPhase) ? (
                        // The button shows only a SHORT phase word -- it is a
                        // fixed-height single-line control. The full step
                        // sentence wraps in the status line rendered below
                        // the button instead (it overflowed the button when
                        // rendered here, live-reported 2026-08-26).
                        <div className="flex items-center gap-2">
                          {(buyPhase === "preparing" || buyPhase === "awaiting-wallet" || buyPhase === "confirming" || buyPhase === "submitted") && (
                            <div className="w-4 h-4 border-2 border-background border-t-transparent rounded-full animate-spin" />
                          )}
                          {txPhaseShortLabel(buyPhase)}
                        </div>
                      ) : !wallet.connected ? (
                        "Connect Wallet to Trade"
                      ) : isOnChain && !isSettlementBuySupported ? (
                        "Buy Not Yet Supported"
                      ) : isOnChain && numBuyAmount > 0 && estReserveTokensOut === null ? (
                        "Quote Unavailable"
                      ) : buyInsufficientBalance ? (
                        `Insufficient ${buyAssetForDisplay.symbol} Balance`
                      ) : (
                        `Buy ${dtr.ticker}`
                      )}
                    </Button>
                    {txPhaseShortLabel(buyPhase) ? (
                      // While a purchase is in flight, the caption slot shows
                      // the detailed step (wrapping freely) instead of the
                      // static submits-a-real-transaction note.
                      <p className="text-[11px] text-muted-foreground text-center mt-2 break-words" aria-live="polite">
                        {multiAssetBuyStep ?? txPhaseLabel(buyPhase, CLUSTER_LABEL)}
                      </p>
                    ) : (
                      isOnChain && (
                        <p className="text-[11px] text-muted-foreground/70 text-center mt-2">
                          {IS_MAINNET
                            ? "Submits a real Solana Mainnet transaction, signed by your wallet."
                            : "Submits a real Solana DevNet transaction, signed by your wallet -- no Mainnet value."}
                        </p>
                      )
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
                          setSellPctSelected(null);
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
                          aria-pressed={sellPctSelected === pct}
                          className={`h-7 rounded-full text-xs font-medium ${
                            sellPctSelected === pct
                              ? "border-primary bg-primary/10 text-primary font-semibold"
                              : "border-border bg-background text-muted-foreground hover:border-primary/40 hover:bg-primary/5 hover:text-primary"
                          }`}
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
                            <InfoTip label="More information about canonical redemption">
                              Proportional, on-chain redemption into this Reserve's actual underlying asset(s) -- computed live from real vault balances and supply, not a synthetic price.
                              {IS_MAINNET && !isPureSettlementReserve ? ` Every redeemed asset is then sold into ${SETTLEMENT_SYMBOL} in the same purchase, so what you receive is ${SETTLEMENT_SYMBOL}.` : ""}
                            </InfoTip>
                          </span>
                        </div>
                        {sellEntitlements.length > 0 ? (
                          <div className="pt-1 space-y-1.5">
                            {sellEntitlements.map((e) => (
                              <div key={e.mint} className={`flex justify-between ${isPureSettlementReserve ? "font-semibold" : "text-xs text-muted-foreground"}`}>
                                <span>{isPureSettlementReserve ? "Est. You Receive" : "Redeems"}</span>
                                <span className={`font-merge-mono ${isPureSettlementReserve ? "text-foreground" : ""}`}>~{e.amount.toFixed(6)} {e.symbol}</span>
                              </div>
                            ))}
                          </div>
                        ) : (
                          <p className="text-sm text-muted-foreground">Enter an amount to preview what you'll receive.</p>
                        )}
                        {isPureSettlementReserve ? (
                          <p className="text-[11px] text-muted-foreground/80 pt-1">
                            This Reserve is backed 100% by {SETTLEMENT_SYMBOL} -- redemption deposits real {SETTLEMENT_SYMBOL} directly into your wallet. No
                            conversion or swap adapter is involved.
                          </p>
                        ) : IS_MAINNET ? (
                          // USDC-settled sell (DEC-0158/DEC-0161): the redeemed assets
                          // above are sold into USDC as part of the same sale --
                          // the USDC figure is the headline; the per-asset rows
                          // above show what backs it.
                          sellEntitlements.length > 0 ? (
                            <div className="pt-3 border-t border-border/50 space-y-1.5">
                              <div className="flex justify-between font-semibold">
                                <span className="flex items-center gap-1">
                                  Est. You Receive
                                  <InfoTip label={`More information about ${SETTLEMENT_SYMBOL} settlement`}>
                                    The redeemed assets above are sold into {SETTLEMENT_SYMBOL} at live market prices as part of the same sale. The estimate uses the
                                    Reserve's current value; the exact amount depends on live routing and is verified from your wallet's real balance.
                                  </InfoTip>
                                </span>
                                <span className="font-merge-mono text-foreground">~{estSettlementOut.toFixed(2)} {SETTLEMENT_SYMBOL}</span>
                              </div>
                              <p className="text-[11px] text-muted-foreground/80">
                                You receive {SETTLEMENT_SYMBOL} -- your Reserve Tokens are redeemed and every asset is sold into {SETTLEMENT_SYMBOL} in the same sale.
                              </p>
                            </div>
                          ) : null
                        ) : (
                          <div className="pt-3 border-t border-border/50 space-y-1.5">
                            <div className="flex justify-between text-xs text-muted-foreground">
                              <span className="flex items-center gap-1">
                                Settled in {SETTLEMENT_SYMBOL}
                                <InfoTip label={`More information about ${SETTLEMENT_SYMBOL} settlement`}>
                                  Redeems in-kind (above) first -- any {SETTLEMENT_SYMBOL} entitlement lands directly in your wallet, and every other
                                  asset is converted into {SETTLEMENT_SYMBOL} at its DevNet test price and paid to you as well, so you always receive
                                  100% of this redemption's value in {SETTLEMENT_SYMBOL}.
                                </InfoTip>
                              </span>
                              <span className="font-merge-mono">~{estSettlementOut.toFixed(2)} {SETTLEMENT_SYMBOL}</span>
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
                          <InfoTip label="More information about the trading fee">SSR.FUN protocol fee (0.10%)</InfoTip>
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
                            <InfoTip label="More information about price impact">Sells push this Reserve's price down against its liquidity depth -- larger orders move it more.</InfoTip>
                          </span>
                          <span className="font-merge-mono text-destructive">{sellQuote.priceImpactPct.toFixed(2)}% &rarr; {formatUsdc(sellQuote.newPrice)}</span>
                        </div>
                      )}
                    </div>
                    )}

                    {sellPendingSignature && (
                      <div className="rounded-lg border border-dashed p-3 text-sm space-y-2" style={{ borderColor: "var(--warn, #d9a13c)" }}>
                        <p>{CLUSTER_LABEL} RPC is temporarily busy -- your Sell transaction is still being verified. No new transaction has been submitted for it.</p>
                        <a href={explorerUrl("tx", sellPendingSignature)} target="_blank" rel="noreferrer" className="underline">
                          View signature on Solana Explorer ({CLUSTER_LABEL}) &rarr;
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
                      className="w-full h-12 text-lg font-bold rounded-full shadow-lg shadow-destructive/20"
                      // Same rule as Buy: disconnected opens the connect flow.
                      onClick={!wallet.connected ? () => setWalletModalOpen(true) : onSellClick}
                      disabled={
                        wallet.connected &&
                        (sellProcessing ||
                          numSellAmount <= 0 ||
                          numSellAmount > (holding?.tokenBalance || 0) ||
                          (isOnChain && !isSettlementSellSupported))
                      }
                    >
                      {txPhaseShortLabel(sellPhase) ? (
                        // Same short-label-in-button rule as Buy above.
                        <div className="flex items-center gap-2">
                          {(sellPhase === "preparing" || sellPhase === "awaiting-wallet" || sellPhase === "confirming" || sellPhase === "submitted") && (
                            <div className="w-4 h-4 border-2 border-background border-t-transparent rounded-full animate-spin" />
                          )}
                          {txPhaseShortLabel(sellPhase)}
                        </div>
                      ) : !wallet.connected ? (
                        "Connect Wallet to Trade"
                      ) : isOnChain && !isSettlementSellSupported ? (
                        "Sell Not Yet Supported"
                      ) : numSellAmount > (holding?.tokenBalance || 0) ? (
                        "Insufficient Balance"
                      ) : (
                        `Sell ${dtr.ticker}`
                      )}
                    </Button>
                    {txPhaseShortLabel(sellPhase) ? (
                      <p className="text-[11px] text-muted-foreground text-center mt-2 break-words" aria-live="polite">
                        {multiAssetSellStep ?? txPhaseLabel(sellPhase, CLUSTER_LABEL)}
                      </p>
                    ) : (
                      isOnChain && (
                        <p className="text-[11px] text-muted-foreground/70 text-center mt-2">
                          {IS_MAINNET
                            ? "Submits a real Solana Mainnet transaction, signed by your wallet."
                            : "Submits a real Solana DevNet transaction, signed by your wallet -- no Mainnet value."}
                        </p>
                      )
                    )}
                  </TabsContent>
                </CardContent>
              </Tabs>
            </Card>
            
            {holding && holding.tokenBalance > 0 && (
              /* Your Position is the panel's most important card — it runs on
                 the SSR navy→indigo gradient (the marketing site's dark-band
                 treatment) in both themes, with light ink. */
              <Card
                className="mt-4 border-transparent shadow-sm"
                style={{ background: "linear-gradient(135deg, #070429 0%, #1c1465 60%, #2e3f92 100%)" }}
              >
                <CardHeader className="pb-3">
                  <CardTitle className="text-sm font-semibold" style={{ color: "#eef1fc" }}>Your Position</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="flex justify-between text-sm">
                    <span style={{ color: "#a7b2dc" }}>Balance</span>
                    <span className="font-merge-mono font-semibold" style={{ color: "#ffffff" }}>{formatTokenAmount(holding.tokenBalance)}</span>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span style={{ color: "#a7b2dc" }}>Value</span>
                    <span className="font-merge-mono font-semibold" style={{ color: "#ffffff" }}>{formatUsdc(holding.tokenBalance * dtr.tokenPrice)}</span>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span style={{ color: "#a7b2dc" }}>Avg Entry</span>
                    <span className="font-merge-mono" style={{ color: "#c9d3f7" }}>{formatUsdc(holding.avgPurchasePrice)}</span>
                  </div>
                  <div className="pt-2 flex justify-between text-sm" style={{ borderTop: "1px solid rgba(151, 171, 239, 0.25)" }}>
                    <span style={{ color: "#a7b2dc" }}>Unrealized P&L</span>
                    <span
                      className="font-merge-mono font-semibold"
                      style={{ color: dtr.tokenPrice >= holding.avgPurchasePrice ? "#4fe3a3" : "#ff8598" }}
                    >
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

      {/* Market Section: Recent Trades */}
      <div id="section-market" className="mt-12 space-y-4 scroll-mt-32">
        <div className="flex items-center gap-2">
          <BarChart3 className="w-5 h-5 text-primary" />
          <h2 className="text-2xl font-merge-display font-bold">Market</h2>
        </div>
        <div className="grid grid-cols-1 gap-6">
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

      {/* Notes from the Creator: the Reserve's change log — what the Creator
          changed and why (rebalances, composition changes, fee updates). */}
      <div id="section-notes" className="mt-12 space-y-4 scroll-mt-32">
        <div className="flex items-center gap-2">
          <PenLine className="w-5 h-5 text-primary" />
          <h2 className="text-2xl font-merge-display font-bold">Notes from the Creator</h2>
        </div>
        <Card className="bg-card border-card-border">
          <CardContent className="p-6">
            {creatorNotes.length === 0 ? (
              <p className="text-sm text-muted-foreground py-6 text-center">
                No notes from the Creator yet. Changes to this Reserve — rebalances, composition updates, fee
                adjustments — will be logged here with the reasoning behind them.
              </p>
            ) : (
              <ol className="relative space-y-8 list-none pl-0 ml-0">
                {/* timeline spine */}
                <div aria-hidden="true" className="absolute left-[5px] top-2 bottom-2 w-px bg-border" />
                {creatorNotes.map((note) => (
                  <li key={note.t} className="relative pl-6">
                    <span aria-hidden="true" className="absolute left-0 top-1.5 w-[11px] h-[11px] rounded-full bg-primary border-2 border-card" />
                    <p className="text-xs font-merge-mono text-muted-foreground mb-1">{format(new Date(note.t), "MMM d, yyyy")}</p>
                    <p className="font-semibold mb-0.5">{note.title}</p>
                    <p className="text-sm text-muted-foreground leading-relaxed max-w-2xl">{note.body}</p>
                  </li>
                ))}
              </ol>
            )}
            {designDemo && creatorNotes.length > 0 && (
              <p className="mt-6 text-[11px] text-muted-foreground/70">
                Design preview — illustrative notes, not a real change history.
              </p>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
