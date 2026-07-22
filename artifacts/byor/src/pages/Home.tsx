import { Link } from "wouter";
import { ArrowUpRight, ArrowDownRight, Activity, BarChart3 } from "lucide-react";
import { FEATURED_DTR_ID, TRENDING_DTR_IDS } from "@/lib/seed-data";
import { formatUsdc } from "@/lib/calculations";
import { useAppStore } from "@/store/useAppStore";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useState, useEffect, useRef, useMemo } from "react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";

// ─── Seeded deterministic price history ───────────────────────────────────────

function seededRand(seed: number) {
  let s = (seed ^ 0xdeadbeef) >>> 0;
  return () => {
    s = Math.imul(s ^ (s >>> 16), 0x45d9f3b);
    s = Math.imul(s ^ (s >>> 16), 0x45d9f3b);
    s = (s ^ (s >>> 16)) >>> 0;
    return s / 0xffffffff;
  };
}

function generatePriceHistory(currentPrice: number, change24h: number, id: string, points = 32): number[] {
  const seed = id.split("").reduce((acc, c, i) => acc + c.charCodeAt(0) * (i + 1), 0);
  const rand = seededRand(seed);
  const startPrice = currentPrice / (1 + change24h / 100);
  const data: number[] = [startPrice];
  for (let i = 1; i < points - 1; i++) {
    const progress = i / (points - 1);
    const trend = (change24h / 100) * progress;
    const noise = (rand() - 0.5) * 0.028;
    data.push(startPrice * (1 + trend + noise));
  }
  data.push(currentPrice);
  return data;
}

// ─── Mini sparkline with hover tooltip ────────────────────────────────────────

function MiniChart({ dtr }: { dtr: any }) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const isPositive = dtr.change24h >= 0;
  const color = isPositive ? "#22c55e" : "#ef4444";

  const data = useMemo(
    () => generatePriceHistory(dtr.tokenPrice, dtr.change24h, dtr.id),
    [dtr.id, dtr.tokenPrice, dtr.change24h]
  );

  const W = 300, H = 60, pad = 3;
  const minV = Math.min(...data);
  const maxV = Math.max(...data);
  const range = maxV - minV || 1;

  const pts = data.map((v, i) => ({
    x: pad + (i / (data.length - 1)) * (W - pad * 2),
    y: H - pad - ((v - minV) / range) * (H - pad * 2),
  }));

  const linePath = pts.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
  const fillPath = `${linePath} L${pts[pts.length - 1].x},${H} L${pts[0].x},${H} Z`;
  const gradId = `sg-${dtr.id}`;

  const handleMouseMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const relX = (e.clientX - rect.left) / rect.width;
    setHoverIdx(Math.min(Math.max(Math.round(relX * (data.length - 1)), 0), data.length - 1));
  };

  const hp = hoverIdx !== null ? pts[hoverIdx] : null;
  const tooltipLeft = hp ? Math.min(Math.max((hp.x / W) * 100, 8), 82) : 0;

  return (
    <div className="relative w-full" style={{ height: H + 28 }}>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        className="w-full"
        style={{ height: H, display: "block" }}
        onMouseMove={handleMouseMove}
        onMouseLeave={() => setHoverIdx(null)}
      >
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.28" />
            <stop offset="100%" stopColor={color} stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d={fillPath} fill={`url(#${gradId})`} />
        <path d={linePath} stroke={color} strokeWidth="1.5" fill="none" strokeLinejoin="round" />
        {hp && (
          <>
            <line x1={hp.x} y1={0} x2={hp.x} y2={H} stroke={color} strokeWidth="1" strokeOpacity="0.45" strokeDasharray="3 2" />
            <circle cx={hp.x} cy={hp.y} r="3.5" fill={color} stroke="white" strokeWidth="1.2" />
          </>
        )}
      </svg>

      {/* Tooltip */}
      {hp && hoverIdx !== null && (
        <div
          className="absolute bg-card border border-white/15 rounded px-2 py-1 pointer-events-none text-[11px] font-mono shadow-xl"
          style={{ left: `${tooltipLeft}%`, top: 2, transform: "translateX(-50%)", zIndex: 20 }}
        >
          {formatUsdc(data[hoverIdx])}
        </div>
      )}
    </div>
  );
}

// ─── Featured reserve card ─────────────────────────────────────────────────────

function FeaturedReserveCard({ dtr }: { dtr: any }) {
  const isPositive = dtr.change24h >= 0;
  return (
    <Card className="flex flex-col bg-card/40 border-white/5 hover:border-primary/25 transition-colors backdrop-blur-sm overflow-hidden group">
      <CardContent className="p-5 flex-1 flex flex-col gap-3">
        {/* Header row */}
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-3">
            <Avatar className="h-10 w-10 border border-white/10 shadow-sm">
              {dtr.logoUrl && <AvatarImage src={dtr.logoUrl} alt={dtr.ticker} />}
              <AvatarFallback className="bg-primary/20 text-primary font-display font-bold text-sm">
                {dtr.ticker.slice(0, 2)}
              </AvatarFallback>
            </Avatar>
            <div>
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-display font-semibold text-foreground text-sm leading-tight">{dtr.name}</span>
                <Badge variant="outline" className="text-[9px] px-1.5 py-0 border-white/10 bg-white/5 font-mono uppercase tracking-wider text-muted-foreground">
                  {dtr.ticker}
                </Badge>
              </div>
              <p className={`text-xs font-mono mt-0.5 ${isPositive ? "text-positive" : "text-destructive"}`}>
                {isPositive ? "+" : ""}{dtr.change24h.toFixed(2)}%
              </p>
            </div>
          </div>
          <p className="font-mono font-semibold text-foreground text-sm shrink-0 ml-2">{formatUsdc(dtr.tokenPrice)}</p>
        </div>

        {/* Description */}
        <p className="text-xs text-muted-foreground leading-relaxed line-clamp-2">{dtr.description}</p>

        {/* Sparkline */}
        <div className="mt-auto -mx-1">
          <MiniChart dtr={dtr} />
        </div>

        {/* Stats + Trade */}
        <div className="flex items-center gap-3 pt-3 border-t border-white/5">
          <div className="grid grid-cols-3 gap-3 flex-1 text-xs">
            <div>
              <p className="text-muted-foreground font-mono text-[10px] uppercase tracking-wide mb-0.5">TVL</p>
              <p className="font-mono text-foreground">{formatUsdc(dtr.aum, { compact: true })}</p>
            </div>
            <div>
              <p className="text-muted-foreground font-mono text-[10px] uppercase tracking-wide mb-0.5">Price</p>
              <p className="font-mono text-foreground">{formatUsdc(dtr.tokenPrice)}</p>
            </div>
            <div>
              <p className="text-muted-foreground font-mono text-[10px] uppercase tracking-wide mb-0.5">24h</p>
              <p className={`font-mono ${isPositive ? "text-positive" : "text-destructive"}`}>
                {isPositive ? "+" : ""}{dtr.change24h.toFixed(2)}%
              </p>
            </div>
          </div>
          <Button asChild size="sm" variant="outline"
            className="shrink-0 rounded-full border-white/10 hover:bg-primary hover:text-primary-foreground hover:border-primary transition-all text-xs px-4">
            <Link href={`/dtr/${dtr.id}`}>Trade</Link>
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Hero Animation: connected floating nodes + isometric platform ─────────────

function HeroAnimation() {
  const offsetRef = useRef(0);
  const targetRef = useRef(0);
  const [offsetState, setOffsetState] = useState(0);
  const isDraggingRef = useRef(false);
  const dragStartRef = useRef({ clientX: 0, baseOffset: 0 });
  const rafRef = useRef<number | undefined>(undefined);

  const MAX_DRAG = 24;

  // Spring loop
  useEffect(() => {
    const tick = () => {
      offsetRef.current += (targetRef.current - offsetRef.current) * 0.09;
      setOffsetState(offsetRef.current);
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); };
  }, []);

  const handlePointerDown = (e: React.PointerEvent) => {
    isDraggingRef.current = true;
    dragStartRef.current = { clientX: e.clientX, baseOffset: offsetRef.current };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (!isDraggingRef.current) return;
    const dx = e.clientX - dragStartRef.current.clientX;
    targetRef.current = Math.max(-MAX_DRAG, Math.min(MAX_DRAG, dragStartRef.current.baseOffset + dx));
  };

  const release = () => {
    isDraggingRef.current = false;
    targetRef.current = 0;
  };

  // Nodes: x/y as % of container, depth controls how much they shift
  const nodes = [
    { id: "a", x: 47, y: 10, size: 70, depth: 0.22 },
    { id: "b", x: 22, y: 28, size: 56, depth: 0.40 },
    { id: "c", x: 72, y: 27, size: 56, depth: 0.40 },
    { id: "d", x: 12, y: 53, size: 50, depth: 0.60 },
    { id: "e", x: 47, y: 50, size: 62, depth: 0.52 },
    { id: "f", x: 82, y: 52, size: 50, depth: 0.62 },
  ];

  const edges: [number, number][] = [
    [0, 1], [0, 2],
    [1, 3], [1, 4],
    [2, 4], [2, 5],
  ];

  const platformDepth = 0.9;
  const platformX = 47;
  const platformY = 80;
  const platformEdges = [3, 4, 5];

  const factor = 0.38;
  const cx = nodes.map((n) => n.x + n.depth * offsetState * factor);
  const pcx = platformX + platformDepth * offsetState * factor;

  return (
    <div
      className="absolute inset-0 select-none touch-none cursor-grab active:cursor-grabbing overflow-hidden"
      style={{ background: "radial-gradient(ellipse at 60% 70%, rgba(139,92,246,0.13) 0%, transparent 68%)" }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={release}
      onPointerLeave={release}
    >
      {/* Connection lines */}
      <svg className="absolute inset-0 w-full h-full pointer-events-none">
        {edges.map(([a, b], i) => (
          <line key={i}
            x1={`${cx[a]}%`} y1={`${nodes[a].y}%`}
            x2={`${cx[b]}%`} y2={`${nodes[b].y}%`}
            stroke="rgba(139,92,246,0.28)" strokeWidth="1"
          />
        ))}
        {platformEdges.map((ni, i) => (
          <line key={`p${i}`}
            x1={`${pcx}%`} y1={`${platformY - 11}%`}
            x2={`${cx[ni]}%`} y2={`${nodes[ni].y}%`}
            stroke="rgba(139,92,246,0.20)" strokeWidth="1"
          />
        ))}
      </svg>

      {/* Floating square nodes */}
      {nodes.map((node, i) => (
        <div key={node.id}
          className="absolute rounded-2xl border border-white/15"
          style={{
            left: `${cx[i]}%`,
            top: `${node.y}%`,
            width: node.size,
            height: node.size,
            transform: "translate(-50%, -50%)",
            background: "rgba(255,255,255,0.045)",
            backdropFilter: "blur(10px)",
            boxShadow: "0 4px 24px rgba(139,92,246,0.14), inset 0 1px 0 rgba(255,255,255,0.10)",
          }}
        />
      ))}

      {/* Isometric platform */}
      <div
        className="absolute"
        style={{
          left: `${pcx}%`,
          top: `${platformY}%`,
          transform: "translate(-50%, -50%)",
          perspective: 1000,
          perspectiveOrigin: "50% 0%",
        }}
      >
        <div
          className="rounded-[22px]"
          style={{
            width: 210,
            height: 210,
            background: "linear-gradient(135deg, rgba(139,92,246,0.55) 0%, rgba(99,102,241,0.42) 55%, rgba(67,56,202,0.32) 100%)",
            border: "1px solid rgba(139,92,246,0.55)",
            boxShadow: "0 28px 72px rgba(139,92,246,0.38), 0 6px 0 rgba(99,102,241,0.55), inset 0 1px 0 rgba(255,255,255,0.18)",
            transform: "rotateX(54deg) rotateZ(-28deg)",
            transformStyle: "preserve-3d",
          }}
        />
      </div>

      {/* Subtle drag hint */}
      <p className="absolute bottom-4 left-1/2 -translate-x-1/2 text-[11px] text-muted-foreground/35 font-mono pointer-events-none">
        ← drag →
      </p>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export function Home() {
  const [searchFilter, setSearchFilter] = useState("");
  const dtrs = useAppStore((s) => s.dtrs);

  const totalAum = dtrs.reduce((sum, d) => sum + d.aum, 0);
  const totalHolders = dtrs.reduce((sum, d) => sum + d.holders, 0);
  const volume24h = totalAum * 0.054;

  const featuredDtr = dtrs.find((d) => d.id === FEATURED_DTR_ID) ?? dtrs[0];
  const trendingDtrs = TRENDING_DTR_IDS.map((id) => dtrs.find((d) => d.id === id)).filter(
    (d): d is (typeof dtrs)[number] => Boolean(d)
  );

  // 3 featured cards: featured + first 2 trending
  const featuredCards = [featuredDtr, ...trendingDtrs.slice(0, 2)].filter(Boolean);

  const filteredDtrs = dtrs.filter(
    (dtr) =>
      dtr.name.toLowerCase().includes(searchFilter.toLowerCase()) ||
      dtr.ticker.toLowerCase().includes(searchFilter.toLowerCase()) ||
      dtr.category.toLowerCase().includes(searchFilter.toLowerCase())
  );

  return (
    <div className="min-h-[100dvh] flex flex-col">
      <main className="flex-1">
        {/* ── Hero ── */}
        <section className="relative overflow-hidden pt-12 pb-16 md:pt-20 md:pb-24">
          <div className="absolute left-0 right-0 top-0 -z-10 m-auto h-[400px] w-[400px] rounded-full bg-primary/10 blur-[120px]" />

          <div className="container mx-auto px-4 md:px-8 relative z-10">
            <div className="flex flex-col lg:flex-row gap-12 lg:gap-8 items-center">

              {/* Left 42% */}
              <div className="w-full lg:w-[42%] flex flex-col items-start text-left">
                <Badge variant="outline" className="mb-6 border-white/10 text-muted-foreground bg-white/5 font-mono uppercase tracking-wider text-xs py-1">
                  Decentralized Token Reserve Protocol
                </Badge>

                <h1 className="font-display text-5xl sm:text-6xl lg:text-6xl xl:text-7xl font-bold tracking-tight mb-6 text-foreground leading-[1.1]">
                  One token.<br />
                  <span className="bg-gradient-to-r from-foreground to-primary/80 bg-clip-text text-transparent">
                    Infinite possibilities.
                  </span>
                </h1>

                <p className="text-lg text-muted-foreground mb-10 max-w-md leading-relaxed font-sans">
                  Deploy your reserve on SSR.FUN and start earning fees, today!
                </p>

                <div className="flex flex-wrap items-center gap-4 w-full sm:w-auto">
                  <Button asChild size="lg"
                    className="font-bold w-full sm:w-auto rounded-full px-8 h-12 shadow-[0_0_20px_rgba(132,81,255,0.3)] hover:shadow-[0_0_30px_rgba(132,81,255,0.5)] transition-shadow">
                    <Link href="/create">Deploy Your Reserve</Link>
                  </Button>
                  <Button asChild variant="outline" size="lg"
                    className="w-full sm:w-auto rounded-full px-8 h-12 border-white/10 hover:bg-white/5">
                    <a href="#directory">Discover DTRs</a>
                  </Button>
                </div>
              </div>

              {/* Right 58% — new animation */}
              <div className="w-full lg:w-[58%] h-[500px] lg:h-[600px] relative">
                <div className="absolute inset-0 bg-card rounded-[2rem] border border-white/5 shadow-2xl overflow-hidden flex flex-col">
                  {/* Panel header */}
                  <div className="p-6 border-b border-white/5 flex justify-between items-center bg-black/20 shrink-0">
                    <div className="flex items-center gap-2">
                      <span className="relative flex h-2 w-2">
                        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-positive opacity-75" />
                        <span className="relative inline-flex rounded-full h-2 w-2 bg-positive" />
                      </span>
                      <span className="font-mono text-sm text-muted-foreground uppercase tracking-wider">
                        SSR.FUN Live Reserve Universe
                      </span>
                    </div>
                  </div>
                  {/* Animation canvas */}
                  <div className="flex-1 relative">
                    <HeroAnimation />
                  </div>
                </div>
              </div>

            </div>
          </div>
        </section>

        {/* ── Metrics strip ── */}
        <div className="w-full bg-card/40 border-y border-white/5 backdrop-blur-sm">
          <div className="container mx-auto px-4 md:px-8">
            <div className="grid grid-cols-2 md:grid-cols-4 divide-x divide-white/5 py-8">
              <div className="px-6 flex flex-col items-center md:items-start text-center md:text-left">
                <p className="text-xs font-mono uppercase tracking-wider text-muted-foreground mb-2">Total Reserve AUM</p>
                <p className="text-3xl font-mono font-bold text-foreground">{formatUsdc(totalAum, { compact: true })}</p>
              </div>
              <div className="px-6 flex flex-col items-center md:items-start text-center md:text-left">
                <p className="text-xs font-mono uppercase tracking-wider text-muted-foreground mb-2">24h Volume</p>
                <p className="text-3xl font-mono font-bold text-foreground">{formatUsdc(volume24h, { compact: true })}</p>
              </div>
              <div className="px-6 flex flex-col items-center md:items-start text-center md:text-left pt-6 md:pt-0">
                <p className="text-xs font-mono uppercase tracking-wider text-muted-foreground mb-2">Active Reserves</p>
                <p className="text-3xl font-mono font-bold text-foreground">{dtrs.length}</p>
              </div>
              <div className="px-6 flex flex-col items-center md:items-start text-center md:text-left pt-6 md:pt-0">
                <p className="text-xs font-mono uppercase tracking-wider text-muted-foreground mb-2">Reserve Token Holders</p>
                <p className="text-3xl font-mono font-bold text-foreground">{totalHolders.toLocaleString()}</p>
              </div>
            </div>
          </div>
        </div>

        <div className="container mx-auto px-4 md:px-8 py-20 space-y-24">

          {/* ── Featured Reserves ── */}
          <div>
            <div className="flex items-center justify-between mb-6">
              <div className="flex items-center gap-2">
                <BarChart3 className="w-5 h-5 text-primary" />
                <h2 className="text-2xl font-display font-bold">Featured Reserves</h2>
              </div>
              <a href="#directory" className="text-sm text-primary flex items-center gap-1 hover:underline font-mono">
                View all <ArrowUpRight className="w-3.5 h-3.5" />
              </a>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
              {featuredCards.map((dtr) => (
                <FeaturedReserveCard key={dtr.id} dtr={dtr} />
              ))}
            </div>
          </div>

          {/* ── All Reserves directory ── */}
          <div id="directory" className="space-y-8">
            <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-6 pb-4 border-b border-white/5">
              <div className="flex items-center gap-2">
                <Activity className="w-5 h-5 text-primary" />
                <h2 className="text-2xl font-display font-bold">All Reserves</h2>
              </div>
              <div className="relative w-full sm:w-80">
                <Input
                  placeholder="Search reserves..."
                  className="bg-card/40 border-white/10 rounded-full pl-4"
                  value={searchFilter}
                  onChange={(e) => setSearchFilter(e.target.value)}
                />
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
              {filteredDtrs.map((dtr) => {
                const premiumDiscount = (dtr.tokenPrice - dtr.nav) / dtr.nav;
                const isPremium = premiumDiscount > 0;

                return (
                  <Card key={dtr.id}
                    className="flex flex-col bg-card/40 border-white/5 hover:border-primary/30 transition-all duration-300 group backdrop-blur-sm">
                    <CardHeader className="pb-4 border-b border-white/5">
                      <div className="flex justify-between items-start mb-4">
                        <Avatar className="h-12 w-12 border border-white/10 shadow-sm">
                          {dtr.logoUrl && <AvatarImage src={dtr.logoUrl} alt={dtr.ticker} />}
                          <AvatarFallback className="bg-primary/20 text-primary font-display font-bold">
                            {dtr.ticker.slice(0, 2)}
                          </AvatarFallback>
                        </Avatar>
                        <Badge variant="outline" className="bg-white/5 border-white/5 text-muted-foreground font-mono text-[10px] uppercase tracking-wider">
                          {dtr.category}
                        </Badge>
                      </div>
                      <CardTitle className="text-xl font-display truncate group-hover:text-primary transition-colors">{dtr.name}</CardTitle>
                      <CardDescription className="font-mono text-xs">{dtr.ticker}</CardDescription>
                    </CardHeader>
                    <CardContent className="flex-1 py-5">
                      <div className="grid grid-cols-2 gap-y-6 gap-x-4">
                        <div>
                          <p className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground mb-1.5">Price</p>
                          <p className="font-mono text-foreground font-medium">{formatUsdc(dtr.tokenPrice)}</p>
                        </div>
                        <div>
                          <p className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground mb-1.5">24h</p>
                          <p className={`font-mono text-sm font-medium flex items-center ${dtr.change24h >= 0 ? "text-positive" : "text-destructive"}`}>
                            {dtr.change24h >= 0 ? "+" : ""}{dtr.change24h.toFixed(2)}%
                          </p>
                        </div>
                        <div>
                          <p className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground mb-1.5">NAV</p>
                          <p className="font-mono text-sm text-muted-foreground">{formatUsdc(dtr.nav)}</p>
                        </div>
                        <div>
                          <p className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground mb-1.5">Prem/Discount</p>
                          <p className={`font-mono text-sm ${isPremium ? "text-positive" : "text-destructive"}`}>
                            {isPremium ? "+" : ""}{(premiumDiscount * 100).toFixed(2)}%
                          </p>
                        </div>
                      </div>
                      <div className="mt-6 pt-5 border-t border-white/5">
                        <p className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground mb-3">Top Assets</p>
                        <div className="flex flex-wrap gap-1.5">
                          {dtr.composition.slice(0, 3).map((asset: any) => (
                            <span key={asset.symbol} className="text-[10px] px-2 py-1 rounded bg-white/5 text-muted-foreground font-mono">
                              {asset.symbol}
                            </span>
                          ))}
                        </div>
                      </div>
                    </CardContent>
                    <CardFooter className="pt-0 pb-5 px-5">
                      <Button asChild
                        className="w-full rounded-full bg-white/5 border border-white/5 hover:bg-primary hover:text-primary-foreground hover:border-primary transition-all duration-300"
                        variant="secondary">
                        <Link href={`/dtr/${dtr.id}`}>Trade</Link>
                      </Button>
                    </CardFooter>
                  </Card>
                );
              })}

              {filteredDtrs.length === 0 && (
                <div className="col-span-full py-20 text-center border rounded-2xl border-dashed border-white/10 bg-white/5">
                  <p className="text-muted-foreground">No reserves match your filter.</p>
                </div>
              )}
            </div>
          </div>

        </div>
      </main>

      <footer className="border-t border-white/5 py-8 text-center text-sm text-muted-foreground">
        <div className="container mx-auto px-4">
          <p className="font-mono text-xs tracking-widest uppercase">SSR.FUN • Reserve Asset Protocol</p>
          <p className="mt-4 text-xs opacity-40">This is a simulated environment. Fictional data only.</p>
        </div>
      </footer>
    </div>
  );
}
