import { useState } from "react";
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
import { DevnetOnboarding } from "../components/DevnetOnboarding";
import { IS_MAINNET } from "@/lib/solana-config";
import { isDesignDemoEnabled } from "@/lib/designDemo";

/** Categorical swatches for allocation slices -- softened, Apple-style pastel
 * steps of the SSR family (dominant slice = periwinkle), assigned in fixed
 * order by descending value. */
const ALLOCATION_COLORS = ["#8ba1ec", "#efb09a", "#8fd0b2", "#ecd18b", "#eea9bf", "#94c78f", "#a99ff0", "#eb9a99"];

/** A pie only reads at a glance up to ~6 segments; smaller positions fold into "Other". */
const MAX_PIE_SLICES = 6;

const PIE_C = 100; // viewBox center
const PIE_RO = 96; // outer radius
const PIE_RI = 78; // inner radius -- thin, pill-like ring
const PIE_GAP = 2 / PIE_RO; // ~2px of surface between slices at the rim

function polarPoint(r: number, angle: number) {
  return `${(PIE_C + r * Math.cos(angle)).toFixed(2)} ${(PIE_C + r * Math.sin(angle)).toFixed(2)}`;
}

function sliceArcPath(a0: number, a1: number) {
  const large = a1 - a0 > Math.PI ? 1 : 0;
  return [
    `M ${polarPoint(PIE_RO, a0)}`,
    `A ${PIE_RO} ${PIE_RO} 0 ${large} 1 ${polarPoint(PIE_RO, a1)}`,
    `L ${polarPoint(PIE_RI, a1)}`,
    `A ${PIE_RI} ${PIE_RI} 0 ${large} 0 ${polarPoint(PIE_RI, a0)}`,
    "Z",
  ].join(" ");
}

type AllocationEntry = { dtr: { id: string; name: string; ticker: string }; value: number };

function AllocationCard({ allocation }: { allocation: AllocationEntry[] }) {
  const [hovered, setHovered] = useState<string | null>(null);
  const total = allocation.reduce((sum, a) => sum + a.value, 0);
  if (total <= 0) return null;

  const folded = allocation.length > MAX_PIE_SLICES;
  const top = folded ? allocation.slice(0, MAX_PIE_SLICES - 1) : allocation;
  const rest = folded ? allocation.slice(MAX_PIE_SLICES - 1) : [];
  const restValue = rest.reduce((sum, a) => sum + a.value, 0);

  const slices = [
    ...top.map((a, i) => ({
      key: a.dtr.id,
      name: a.dtr.name,
      ticker: a.dtr.ticker,
      value: a.value,
      color: ALLOCATION_COLORS[i],
      detail: undefined as string | undefined,
    })),
    ...(rest.length > 0
      ? [{
          key: "other",
          name: `Other (${rest.length} Reserves)`,
          ticker: "",
          value: restValue,
          color: "var(--s-other)",
          detail: rest.map((a) => a.dtr.ticker).join(", ") as string | undefined,
        }]
      : []),
  ];

  const hoveredSlice = slices.find((s) => s.key === hovered);
  const pct = (v: number) => `${((v / total) * 100).toFixed(1)}%`;

  let angle = -Math.PI / 2; // start at 12 o'clock, clockwise
  const arcs = slices.map((s) => {
    const sweep = (s.value / total) * 2 * Math.PI;
    const gap = slices.length > 1 ? Math.min(PIE_GAP, sweep / 2) : 0;
    let a0 = angle + gap / 2;
    let a1 = angle + sweep - gap / 2;
    angle += sweep;
    if (a1 - a0 < 0.008) {
      // keep dust-sized positions visible and hoverable
      const mid = (a0 + a1) / 2;
      a0 = mid - 0.004;
      a1 = mid + 0.004;
    }
    return { ...s, a0, a1 };
  });

  return (
    <Card className="bg-card/40 border-border/50 mb-8">
      <CardHeader className="pb-4">
        <CardTitle className="text-lg">Allocation by Reserve</CardTitle>
        <CardDescription>Share of your Reserve Token holdings, by current value.</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex flex-col sm:flex-row items-center gap-8">
          <svg viewBox="0 0 200 200" className="w-44 h-44 shrink-0" role="img" aria-label="Pie chart of your Reserve Token holdings by current value">
            {/* Inset track + emboss hairlines: the ring reads as slightly
                embedded in the card, Apple-style. */}
            <circle cx={PIE_C} cy={PIE_C} r={(PIE_RO + PIE_RI) / 2} fill="none" stroke="#ececf0" strokeWidth={PIE_RO - PIE_RI} />
            <circle cx={PIE_C} cy={PIE_C} r={PIE_RO - 0.5} fill="none" stroke="rgba(7, 4, 41, 0.1)" strokeWidth="1" />
            <circle cx={PIE_C} cy={PIE_C} r={PIE_RI + 0.5} fill="none" stroke="rgba(7, 4, 41, 0.06)" strokeWidth="1" />
            {slices.length === 1 ? (
              <circle
                cx={PIE_C}
                cy={PIE_C}
                r={(PIE_RO + PIE_RI) / 2}
                fill="none"
                stroke={slices[0].color}
                strokeWidth={PIE_RO - PIE_RI}
                onMouseEnter={() => setHovered(slices[0].key)}
                onMouseLeave={() => setHovered(null)}
              >
                <title>{`${slices[0].name} — ${pct(slices[0].value)} · ${formatUsdc(slices[0].value)}`}</title>
              </circle>
            ) : (
              arcs.map((s) => (
                <path
                  key={s.key}
                  d={sliceArcPath(s.a0, s.a1)}
                  fill={s.color}
                  opacity={hovered !== null && hovered !== s.key ? 0.4 : 1}
                  onMouseEnter={() => setHovered(s.key)}
                  onMouseLeave={() => setHovered(null)}
                >
                  <title>{`${s.name}${s.detail ? `: ${s.detail}` : ""} — ${pct(s.value)} · ${formatUsdc(s.value)}`}</title>
                </path>
              ))
            )}
            <text
              x={PIE_C}
              y={hoveredSlice ? 94 : 98}
              textAnchor="middle"
              className="font-merge-mono text-foreground"
              fill="currentColor"
              fontSize="17"
              fontWeight="600"
              pointerEvents="none"
            >
              {hoveredSlice ? pct(hoveredSlice.value) : formatUsdc(total)}
            </text>
            <text
              x={PIE_C}
              y={hoveredSlice ? 112 : 116}
              textAnchor="middle"
              className="text-muted-foreground"
              fill="currentColor"
              fontSize="10.5"
              pointerEvents="none"
            >
              {hoveredSlice ? hoveredSlice.ticker || "Other" : "Reserve Holdings"}
            </text>
            {hoveredSlice && (
              <text
                x={PIE_C}
                y={128}
                textAnchor="middle"
                className="font-merge-mono text-muted-foreground"
                fill="currentColor"
                fontSize="10.5"
                pointerEvents="none"
              >
                {formatUsdc(hoveredSlice.value)}
              </text>
            )}
          </svg>

          <div className="w-full grid grid-cols-1 lg:grid-cols-2 gap-x-6 gap-y-1 self-center">
            {slices.map((s) => (
              <div
                key={s.key}
                className={`flex items-center gap-2.5 text-sm min-w-0 rounded-md px-2 py-1.5 transition-colors ${hovered === s.key ? "bg-muted/30" : ""}`}
                onMouseEnter={() => setHovered(s.key)}
                onMouseLeave={() => setHovered(null)}
              >
                <span className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ background: s.color }} />
                <span className="truncate font-medium">{s.name}</span>
                {s.ticker && <span className="font-merge-mono text-muted-foreground text-xs shrink-0">{s.ticker}</span>}
                <span className="font-merge-mono ml-auto shrink-0">{pct(s.value)}</span>
              </div>
            ))}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function PnlText({ value, pct, className = "", dark = false }: { value: number; pct?: number; className?: string; dark?: boolean }) {
  const isProfit = value >= 0;
  return (
    <span
      className={`inline-flex items-center gap-1 font-merge-mono ${dark ? "" : isProfit ? "text-positive" : "text-destructive"} ${className}`}
      style={dark ? { color: isProfit ? "#4fe3a3" : "#ff8598" } : undefined}
    >
      {isProfit ? <ArrowUpRight className="w-3.5 h-3.5" /> : <ArrowDownRight className="w-3.5 h-3.5" />}
      {formatUsdc(Math.abs(value))}
      {pct !== undefined && <span className="opacity-80">({formatPercent(pct)})</span>}
    </span>
  );
}

export function Portfolio() {
  const { wallet, holdings, dtrs, quarantinedReserves, chainDiscoveryStatus, txInFlight, setWalletModalOpen } = useAppStore();
  // Distinct from "genuinely empty": a fresh mount whose first discovery
  // pass hasn't resolved yet, an in-flight Buy/Sell/deployment, or a
  // discovery pass that failed and is showing last-known state (see
  // Discover.tsx's identical reasoning) all mean holdings.length === 0 is
  // NOT yet a trustworthy "this wallet owns nothing" signal.
  const holdingsMayBeStale = chainDiscoveryStatus === "loading" || chainDiscoveryStatus === "error" || txInFlight;

  const isConnected = wallet.connected;

  if (!isConnected) {
    return (
      <div className="container mx-auto px-4 py-24 flex flex-col items-center justify-center min-h-[70vh] relative">
        {/* Full-bleed hero art behind the gate (public/portfolio-gate-hero.jpg)
            — same treatment as the Manage/Create gates: centered radial wash
            for the center-aligned text, bottom fade, hides itself if absent. */}
        <div aria-hidden="true" className="absolute top-0 left-1/2 w-screen -translate-x-1/2 h-[240px] sm:h-[400px] overflow-hidden pointer-events-none -z-10">
          <img
            src="/portfolio-gate-hero.jpg"
            alt=""
            className="w-full h-full object-cover"
            style={{ objectPosition: "55% 26%" }}
            onError={(e) => { (e.currentTarget.parentElement as HTMLElement).style.display = "none"; }}
          />
          <div className="absolute inset-0" style={{ background: "radial-gradient(ellipse 55% 90% at 50% 62%, hsl(var(--background) / 0.88) 0%, hsl(var(--background) / 0.5) 55%, hsl(var(--background) / 0.05) 100%)" }} />
          <div className="absolute inset-0" style={{ background: "linear-gradient(180deg, hsl(var(--background) / 0) 0%, hsl(var(--background) / 0.15) 68%, hsl(var(--background)) 100%)" }} />
        </div>
        <div className="w-20 h-20 bg-muted rounded-full flex items-center justify-center mb-6">
          <Wallet className="w-10 h-10 text-muted-foreground" />
        </div>
        <h1 className="text-3xl font-merge-display font-bold mb-4">Wallet Not Connected</h1>
        {/* Inline margins: FABLE's unlayered element reset zeroes <p> margins
            with higher cascade priority than Tailwind's layered mt-*/}
        <p className="text-muted-foreground text-center max-w-md" style={{ marginTop: 15, marginBottom: 12 }}>
          Connect a wallet to view your SSR.FUN portfolio, simulated balances, and Reserve Token holdings.
        </p>
        <Button className="rounded-full h-12 px-10 text-base mt-6" onClick={() => setWalletModalOpen(true)}>
          Connect Wallet
        </Button>
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
    <div className="container mx-auto px-4 md:px-8 py-10 relative">
      {/* Full-bleed hero art behind the page top (drop the graphic at
          public/portfolio-hero.jpg — decorative, hides itself if absent).
          Two washes keep the header readable: a left-edge scrim under the
          title and a bottom fade into the page ground. */}
      <div aria-hidden="true" className="absolute top-0 left-1/2 w-screen -translate-x-1/2 h-[260px] sm:h-[440px] overflow-hidden pointer-events-none -z-10">
        <img
          src="/portfolio-hero.jpg"
          alt=""
          className="w-full h-full object-cover"
          style={{ objectPosition: "32% 4%" }}
          onError={(e) => { (e.currentTarget.parentElement as HTMLElement).style.display = "none"; }}
        />
        <div className="absolute inset-0" style={{ background: "linear-gradient(90deg, hsl(var(--background) / 0.78) 0%, hsl(var(--background) / 0.25) 45%, hsl(var(--background) / 0.05) 100%)" }} />
        <div className="absolute inset-0" style={{ background: "linear-gradient(180deg, hsl(var(--background) / 0.05) 0%, hsl(var(--background) / 0.25) 55%, hsl(var(--background)) 98%)" }} />
      </div>

      <div className="mb-8 relative">
        <p className="font-merge-display text-[10px] font-medium uppercase tracking-[0.22em] text-muted-foreground mb-2">
          Your Reserves &amp; Balances
        </p>
        <div className="flex items-center gap-3">
          <PieChart className="w-8 h-8 text-primary" />
          <h1 className="text-4xl font-merge-display font-bold tracking-tight">Portfolio</h1>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
        {/* The page's hero: Total Net Value on the SSR navy gradient, the same
            "important card" treatment as the trade panel's Your Position. */}
        <Card
          className="col-span-1 md:col-span-3 lg:col-span-1 border-transparent shadow-sm"
          style={{ background: "linear-gradient(135deg, rgba(7, 4, 41, 0.87) 0%, rgba(28, 20, 101, 0.87) 60%, rgba(46, 63, 146, 0.87) 100%)" }}
        >
          <CardHeader className="pb-2">
            <CardDescription className="font-merge-display text-[10px] font-medium uppercase tracking-[0.2em]" style={{ color: "#97abef" }}>
              Total Net Value
            </CardDescription>
            <CardTitle className="text-4xl font-merge-mono" style={{ color: "#ffffff" }}>{formatUsdc(portfolioValue)}</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="mt-4 pt-4 grid grid-cols-2 gap-4" style={{ borderTop: "1px solid rgba(151, 171, 239, 0.25)" }}>
              <div>
                <p className="text-xs mb-1" style={{ color: "#a7b2dc" }}>Total P&L</p>
                {holdings.length > 0 ? (
                  <PnlText dark value={totalUnrealizedPnl} pct={totalUnrealizedPnlPct} className="text-base font-semibold" />
                ) : (
                  <p className="font-merge-mono" style={{ color: "#a7b2dc" }}>—</p>
                )}
              </div>
              <div>
                <p className="text-xs mb-1" style={{ color: "#a7b2dc" }}>24h P&L</p>
                {holdings.length > 0 ? (
                  <PnlText dark value={total24hPnl} pct={total24hPnlPct} className="text-base font-semibold" />
                ) : (
                  <p className="font-merge-mono" style={{ color: "#a7b2dc" }}>—</p>
                )}
              </div>
            </div>
            <div className="mt-4 pt-4 grid grid-cols-2 gap-4" style={{ borderTop: "1px solid rgba(151, 171, 239, 0.25)" }}>
              <div>
                <p className="text-xs mb-1" style={{ color: "#a7b2dc" }}>Wallet Assets</p>
                <p className="font-merge-mono text-lg" style={{ color: "#eef1fc" }}>{formatUsdc(totalWalletValue)}</p>
              </div>
              <div>
                <p className="text-xs mb-1" style={{ color: "#a7b2dc" }}>Reserve Holdings</p>
                <p className="font-merge-mono text-lg" style={{ color: "#eef1fc" }}>{formatUsdc(totalDtrValue)}</p>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="bg-card/40 border-border/50 col-span-1 md:col-span-3 lg:col-span-2">
          <CardHeader className="pb-4">
            <CardTitle className="text-lg">Wallet Balances</CardTitle>
          </CardHeader>
          <CardContent>
            <div className={`grid grid-cols-1 ${isDesignDemoEnabled() && !IS_MAINNET ? "sm:grid-cols-2" : ""} gap-4`}>
              <div className="p-4 bg-muted/30 rounded-2xl border border-border/50 flex flex-col justify-center">
                <div className="flex items-center gap-2 mb-2">
                  <div className="w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold" style={{ background: "rgba(151, 171, 239, 0.25)", color: "#4155a6" }}>
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
                      <path d="M4 17.5l14-3.5 2.5 3.5-14 3.5zm2.5-11L20.5 3l-2.5-3.5L4 3zM4 10.5l14-3.5 2.5 3.5-14 3.5z"/>
                    </svg>
                  </div>
                  <span className="font-semibold">SOL</span>
                </div>
                <div className="font-merge-mono text-xl">{wallet.sol.toLocaleString(undefined, { maximumFractionDigits: 4 })}</div>
                <p className="text-xs text-muted-foreground mt-1">Real balance, read from Solana {IS_MAINNET ? "Mainnet" : "DevNet"}</p>
              </div>
              {isDesignDemoEnabled() && !IS_MAINNET && (
                <div className="p-4 bg-muted/30 rounded-2xl border border-border/50 flex flex-col justify-center">
                  <div className="flex items-center gap-2 mb-2">
                    <div className="w-6 h-6 rounded-full flex items-center justify-center text-[9px] font-bold" style={{ background: "rgba(47, 91, 226, 0.15)", color: "#2f5be2" }}>$</div>
                    <span className="font-semibold">devUSDC</span>
                  </div>
                  <div className="font-merge-mono text-xl">{wallet.usdc.toLocaleString(undefined, { maximumFractionDigits: 2 })}</div>
                  <p className="text-xs text-muted-foreground mt-1">Design preview — illustrative balance.</p>
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      </div>

      {!IS_MAINNET && <DevnetOnboarding />}

      {allocation.length > 0 && <AllocationCard allocation={allocation} />}

      <div className="space-y-6 mb-8">
        <h2 className="text-2xl font-merge-display font-bold">Reserve Holdings</h2>

        {holdings.length === 0 && holdingsMayBeStale ? (
          <Card className="border-dashed border-border/60 bg-transparent">
            <CardContent className="py-16 flex flex-col items-center justify-center text-center">
              <div className="w-16 h-16 bg-muted/50 rounded-full flex items-center justify-center mb-4">
                <Activity className="w-8 h-8 text-muted-foreground animate-pulse" />
              </div>
              <h3 className="text-xl font-semibold mb-2">Syncing holdings...</h3>
              <p className="text-muted-foreground max-w-md mb-6">
                {chainDiscoveryStatus === "error"
                  ? `Solana ${IS_MAINNET ? "Mainnet" : "DevNet"} couldn't be reached just now -- retrying. Your real holdings will appear as soon as the connection recovers.`
                  : `Reading your real Reserve Token balances from Solana ${IS_MAINNET ? "Mainnet" : "DevNet"} -- this only takes a moment.`}
              </p>
            </CardContent>
          </Card>
        ) : holdings.length === 0 ? (
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
                    if (!dtr) {
                      // A real wallet-owned Reserve Token balance in a
                      // Reserve that failed the public eligibility check
                      // (packages/sdk's evaluateReserveEligibility) -- the
                      // holding itself is never erased, but no price/value/
                      // cost-basis/P&L is ever computed or guessed for it.
                      const legacy = quarantinedReserves[holding.dtrId];
                      if (!legacy) return null;
                      return (
                        <TableRow key={holding.dtrId} className="border-border/50 hover:bg-muted/20 opacity-70">
                          <TableCell className="py-4">
                            <div className="flex items-center gap-3">
                              <Avatar className="h-8 w-8 border border-border">
                                <AvatarFallback className="bg-muted text-muted-foreground text-xs font-bold">
                                  {legacy.ticker.slice(0, 2)}
                                </AvatarFallback>
                              </Avatar>
                              <div>
                                <p className="font-semibold text-foreground">{legacy.name}</p>
                                <div className="flex items-center gap-1 mt-0.5">
                                  <Badge variant="secondary" className="font-merge-mono text-[10px] px-1 py-0 h-4">{legacy.ticker}</Badge>
                                  <Badge variant="outline" className="text-[9px] px-1 py-0 h-4 uppercase tracking-wide">Legacy -- Unsupported</Badge>
                                </div>
                              </div>
                            </div>
                          </TableCell>
                          <TableCell className="text-right font-merge-mono">
                            {holding.tokenBalance.toLocaleString(undefined, { maximumFractionDigits: 4 })}
                          </TableCell>
                          <TableCell className="text-right font-merge-mono text-muted-foreground">--</TableCell>
                          <TableCell className="text-right font-merge-mono text-muted-foreground">--</TableCell>
                          <TableCell className="text-right font-merge-mono text-muted-foreground">--</TableCell>
                          <TableCell className="text-right font-merge-mono text-muted-foreground">--</TableCell>
                          <TableCell className="text-right font-merge-mono text-muted-foreground">--</TableCell>
                          <TableCell className="text-right">
                            <Button asChild size="sm" variant="outline">
                              <Link href={`/dtr/${holding.dtrId}`}>Details</Link>
                            </Button>
                          </TableCell>
                        </TableRow>
                      );
                    }

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
                                  {dtr.onChain ? (IS_MAINNET ? "Mainnet" : "DevNet") : "Simulated"}
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
                          <div className="flex justify-end">
                            <Button asChild size="sm" variant="secondary" className="font-semibold trade-pill">
                              <Link href={`/dtr/${dtr.id}`}>Trade</Link>
                            </Button>
                          </div>
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
