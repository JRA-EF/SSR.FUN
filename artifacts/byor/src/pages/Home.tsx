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

// ─── Hero Animation: isometric platform scene ─────────────────────────────────

function HeroAnimation() {
  const springRef = useRef({ rx: 0, ry: 0, tx: 0, ty: 0 });
  const targetRef = useRef({ rx: 0, ry: 0, tx: 0, ty: 0 });
  const [spring, setSpring] = useState({ rx: 0, ry: 0, tx: 0, ty: 0 });
  const rafRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    const K = 0.072;
    const tick = () => {
      const s = springRef.current, t = targetRef.current;
      s.rx += (t.rx - s.rx) * K; s.ry += (t.ry - s.ry) * K;
      s.tx += (t.tx - s.tx) * K; s.ty += (t.ty - s.ty) * K;
      setSpring({ ...s });
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => { if (rafRef.current !== undefined) cancelAnimationFrame(rafRef.current); };
  }, []);

  const handleMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const nx = (e.clientX - rect.left) / rect.width - 0.5;
    const ny = (e.clientY - rect.top) / rect.height - 0.5;
    targetRef.current = { rx: ny * -11, ry: nx * 11, tx: nx * 24, ty: ny * 12 };
  };

  // ── Projection ────────────────────────────────────────────────────────────
  const W = 540, H = 460;
  const TW = 44, TH = 20, TZ = 44;
  const ox = W * 0.50, oy = H * 0.58;

  const proj = (x: number, y: number, z: number): [number, number] => [
    ox + (x - y) * TW,
    oy + (x + y) * TH - z * TZ,
  ];

  // Rounded-corner quad path — quadratic bezier at each corner
  function roundedQuad(pts: [number, number][], r: number): string {
    const n = pts.length;
    let d = '';
    for (let i = 0; i < n; i++) {
      const prev = pts[(i - 1 + n) % n];
      const cur  = pts[i];
      const next = pts[(i + 1) % n];
      const dxP = prev[0] - cur[0], dyP = prev[1] - cur[1];
      const dxN = next[0] - cur[0], dyN = next[1] - cur[1];
      const lenP = Math.hypot(dxP, dyP) || 1;
      const lenN = Math.hypot(dxN, dyN) || 1;
      const ra = Math.min(r, lenP / 3, lenN / 3);
      const p1: [number, number] = [cur[0] + dxP / lenP * ra, cur[1] + dyP / lenP * ra];
      const p2: [number, number] = [cur[0] + dxN / lenN * ra, cur[1] + dyN / lenN * ra];
      d += i === 0 ? `M${p1[0].toFixed(1)},${p1[1].toFixed(1)}` : ` L${p1[0].toFixed(1)},${p1[1].toFixed(1)}`;
      d += ` Q${cur[0].toFixed(1)},${cur[1].toFixed(1)} ${p2[0].toFixed(1)},${p2[1].toFixed(1)}`;
    }
    return d + ' Z';
  }

  // ── Block geometry ────────────────────────────────────────────────────────
  interface Blk { gx: number; gy: number; gz: number; w: number; d: number; h: number }

  function blkFaces(b: Blk, cr: number) {
    const { gx, gy, gz, w, d, h } = b;
    const lp: [number,number][] = [proj(gx,gy,gz+h), proj(gx+w,gy,gz+h), proj(gx+w,gy,gz), proj(gx,gy,gz)];
    const rp: [number,number][] = [proj(gx+w,gy,gz+h), proj(gx+w,gy+d,gz+h), proj(gx+w,gy+d,gz), proj(gx+w,gy,gz)];
    const tp: [number,number][] = [proj(gx,gy,gz+h), proj(gx+w,gy,gz+h), proj(gx+w,gy+d,gz+h), proj(gx,gy+d,gz+h)];
    return { left: roundedQuad(lp, cr), right: roundedQuad(rp, cr), top: roundedQuad(tp, cr) };
  }

  // ── Scene definition ──────────────────────────────────────────────────────
  const PW = 4.8, PD = 4.8, PH = 1.25;
  const platform: Blk = { gx: -PW/2, gy: -PD/2, gz: 0, w: PW, d: PD, h: PH };

  const BW = 1.45, BD = 1.45, BH = 0.95;
  const half = BW / 2;

  // [cx, cy, gz] — 9 small platforms with generous spacing
  const centers: [number, number, number][] = [
    [-1.5, -3.6, 2.1],
    [ 0.5, -4.0, 1.8],
    [ 2.6, -3.3, 2.5],
    [-3.1, -1.4, 2.2],
    [-0.1, -2.2, 3.5],
    [ 2.9, -1.0, 2.2],
    [-2.2,  0.2, 2.0],
    [ 0.7,  0.0, 2.8],
    [ 2.8,  0.6, 1.7],
  ];

  const smalls: (Blk & { cx: number; cy: number })[] = centers.map(([cx, cy, gz]) => ({
    cx, cy, gz, gx: cx - half, gy: cy - half, w: BW, d: BD, h: BH,
  }));

  const sorted = [...smalls].sort((a, b) => (a.gx + a.gy) - (b.gx + b.gy));
  const platTopZ = PH;

  return (
    <div
      className="absolute inset-0 overflow-hidden"
      onMouseMove={handleMouseMove}
      onMouseLeave={() => { targetRef.current = { rx: 0, ry: 0, tx: 0, ty: 0 }; }}
      style={{ perspective: "1400px", perspectiveOrigin: "50% 45%" }}
    >
      {/* Entire scene — platform + blocks + glow + connectors — all move as one */}
      <div
        className="w-full h-full flex items-center justify-center"
        style={{
          transform: `translateX(${spring.tx}px) translateY(${spring.ty}px) rotateX(${spring.rx}deg) rotateY(${spring.ry}deg)`,
          willChange: "transform",
        }}
      >
        <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H}
          style={{ overflow: "visible", maxWidth: "100%", height: "auto" }}>
          <defs>
            <radialGradient id="isoGlow" cx="50%" cy="55%" r="50%">
              <stop offset="0%"   stopColor="#7c3aed" stopOpacity="0.72" />
              <stop offset="55%"  stopColor="#8b5cf6" stopOpacity="0.28" />
              <stop offset="100%" stopColor="#8b5cf6" stopOpacity="0" />
            </radialGradient>
            <linearGradient id="plTop" x1="0.2" y1="0" x2="0.8" y2="1" gradientUnits="objectBoundingBox">
              <stop offset="0%"   stopColor="#faf8ff" />
              <stop offset="100%" stopColor="#ddd6fe" />
            </linearGradient>
            <linearGradient id="plLeft" x1="0" y1="0" x2="1" y2="1" gradientUnits="objectBoundingBox">
              <stop offset="0%"   stopColor="#a78bfa" />
              <stop offset="100%" stopColor="#6d28d9" />
            </linearGradient>
            <linearGradient id="plRight" x1="0" y1="0" x2="0" y2="1" gradientUnits="objectBoundingBox">
              <stop offset="0%"   stopColor="#7c3aed" />
              <stop offset="100%" stopColor="#4c1d95" />
            </linearGradient>
            <linearGradient id="smTop" x1="0.2" y1="0" x2="0.8" y2="1" gradientUnits="objectBoundingBox">
              <stop offset="0%"   stopColor="#ffffff" />
              <stop offset="100%" stopColor="#ede9fe" />
            </linearGradient>
            <linearGradient id="smLeft" x1="0" y1="0" x2="1" y2="1" gradientUnits="objectBoundingBox">
              <stop offset="0%"   stopColor="#c4b5fd" />
              <stop offset="100%" stopColor="#8b5cf6" />
            </linearGradient>
            <linearGradient id="smRight" x1="0" y1="0" x2="0" y2="1" gradientUnits="objectBoundingBox">
              <stop offset="0%"   stopColor="#8b5cf6" />
              <stop offset="100%" stopColor="#5b21b6" />
            </linearGradient>
            <filter id="blkDrop" x="-50%" y="-50%" width="200%" height="200%">
              <feDropShadow dx="0" dy="6" stdDeviation="9" floodColor="#6d28d9" floodOpacity="0.28" />
            </filter>
          </defs>

          {/* Soft ambient glow beneath platform */}
          <ellipse cx={ox} cy={oy + 36} rx={TW * PW * 0.9} ry={TH * PD * 1.9} fill="url(#isoGlow)" />

          {/* Base platform */}
          {(() => {
            const { left, right, top } = blkFaces(platform, 20);
            return (
              <g filter="url(#blkDrop)">
                <path d={left}  fill="url(#plLeft)"  stroke="#5b21b6" strokeWidth="0.7" />
                <path d={right} fill="url(#plRight)" stroke="#3b0764" strokeWidth="0.7" />
                <path d={top}   fill="url(#plTop)"   stroke="#c4b5fd" strokeWidth="0.7" />
              </g>
            );
          })()}

          {/* Dotted vertical connectors — very subtle */}
          {smalls.map((b, i) => {
            const [sx, blockBottomY] = proj(b.cx, b.cy, b.gz);
            const [,  platSurfY]     = proj(b.cx, b.cy, platTopZ + 0.04);
            return (
              <line key={i}
                x1={sx} y1={platSurfY}
                x2={sx} y2={blockBottomY}
                stroke="rgba(167,139,250,0.22)"
                strokeWidth="0.75"
                strokeDasharray="2 5"
              />
            );
          })}

          {/* Floating small platforms — identical shape, smaller scale */}
          {sorted.map((b, i) => {
            const { left, right, top } = blkFaces(b, 11);
            return (
              <g key={i} filter="url(#blkDrop)">
                <path d={left}  fill="url(#smLeft)"  stroke="#7c3aed" strokeWidth="0.5" />
                <path d={right} fill="url(#smRight)" stroke="#4c1d95" strokeWidth="0.5" />
                <path d={top}   fill="url(#smTop)"   stroke="#e9d5ff" strokeWidth="0.5" />
              </g>
            );
          })}
        </svg>
      </div>
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
                <p className="mb-6 font-mono text-xs tracking-widest uppercase text-muted-foreground">
                  Tokenized Reserve Protocol
                </p>

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
                    <a href="#directory">Discover Reserves</a>
                  </Button>
                </div>
              </div>

              {/* Right 58% — floating animation, no card wrapper */}
              <div className="w-full lg:w-[58%] h-[380px] lg:h-[480px] relative">
                <HeroAnimation />
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
