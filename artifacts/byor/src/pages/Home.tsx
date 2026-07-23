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

// ─── Hero Animation: isometric floating reserve platform ─────────────────────

// ── Module-level geometry constants ──────────────────────────────────────────
const ISO_W = 620, ISO_H = 500;
const ISO_TW = 39, ISO_TH = 17, ISO_TZ = 38;
const ISO_OX = ISO_W * 0.50, ISO_OY = ISO_H * 0.70;

// Base platform — flat and wide, thick side band
const PW = 5.6, PD = 5.0, PH = 0.62;
// Small blocks — very thin, heavily rounded
const BH = 0.20;

// [cx, cy, gz, floatDepth]
// 8 blocks — block 7 moved to upper-left (was far-right front)
const BLOCK_CENTERS: readonly [number, number, number, number][] = [
  [-3.6, -1.0, 3.4, 0.79],   // far-left back
  [ 0.1, -3.6, 4.7, 0.68],   // center back (tallest — longest connector)
  [ 2.8, -2.1, 3.2, 0.82],   // right back
  [-2.4,  0.1, 2.6, 0.84],   // medium left
  [ 0.9, -1.0, 2.9, 1.00],   // center-right
  [-1.1,  1.4, 1.6, 0.76],   // close front-left (short connector)
  [ 2.5,  0.6, 2.4, 0.88],   // right medium
  [-5.0, -2.8, 4.8, 0.73],   // upper-left (moved from far-right front)
];

// Per-block [w, d] sizes — randomized; avg ≈ current*1.25, min current*1.15, max current*2.0
// current base = 1.10 → min 1.265, max 2.20, avg target ≈ 1.375
const BLOCK_SIZES: readonly [number, number][] = [
  [1.27, 1.27], // 0 far-left back
  [1.52, 1.52], // 1 center back — biggest, tallest connector
  [1.38, 1.38], // 2 right back
  [1.30, 1.30], // 3 medium left
  [1.44, 1.44], // 4 center-right
  [1.28, 1.28], // 5 close front-left
  [1.42, 1.42], // 6 right medium
  [1.35, 1.35], // 7 upper-left
]; // avg = 1.37 (+25%)
const N_BLOCKS = BLOCK_CENTERS.length;

// Float animation — each block bobs independently
const FLOAT_PHASES: readonly number[] = [0.0, 1.30, 2.60, 0.85, 2.05, 3.40, 1.15, 2.80];
const FLOAT_SPEED  = 0.55;  // rad/s — gentle, premium feel
const FLOAT_AMP_PX = 6.5;   // screen-pixel amplitude

// ── Pure geometry (module-level) ──────────────────────────────────────────────
function isoProj(x: number, y: number, z: number): [number, number] {
  return [ISO_OX + (x - y) * ISO_TW, ISO_OY + (x + y) * ISO_TH - z * ISO_TZ];
}

function isoRoundedQuad(pts: [number, number][], r: number): string {
  const n = pts.length;
  let d = '';
  for (let i = 0; i < n; i++) {
    const prev = pts[(i - 1 + n) % n], cur = pts[i], next = pts[(i + 1) % n];
    const dxP = prev[0] - cur[0], dyP = prev[1] - cur[1];
    const dxN = next[0] - cur[0], dyN = next[1] - cur[1];
    const lP = Math.hypot(dxP, dyP) || 1, lN = Math.hypot(dxN, dyN) || 1;
    const ra = Math.min(r, lP / 2.6, lN / 2.6);
    const p1: [number, number] = [cur[0] + dxP / lP * ra, cur[1] + dyP / lP * ra];
    const p2: [number, number] = [cur[0] + dxN / lN * ra, cur[1] + dyN / lN * ra];
    d += i === 0 ? `M${p1[0].toFixed(2)},${p1[1].toFixed(2)}` : ` L${p1[0].toFixed(2)},${p1[1].toFixed(2)}`;
    d += ` Q${cur[0].toFixed(2)},${cur[1].toFixed(2)} ${p2[0].toFixed(2)},${p2[1].toFixed(2)}`;
  }
  return d + ' Z';
}

interface IsoBlk { gx: number; gy: number; gz: number; w: number; d: number; h: number }
type IsoFaces = { left: string; right: string; top: string };

function isoBlkFaces(b: IsoBlk, cr: number): IsoFaces {
  const { gx, gy, gz, w, d, h } = b;
  return {
    // left  = max-y face (lower-left in screen space) — actually visible below top face
    left:  isoRoundedQuad([isoProj(gx,gy+d,gz+h), isoProj(gx+w,gy+d,gz+h), isoProj(gx+w,gy+d,gz), isoProj(gx,gy+d,gz)], cr),
    // right = max-x face (lower-right in screen space) — actually visible below top face
    right: isoRoundedQuad([isoProj(gx+w,gy,gz+h), isoProj(gx+w,gy+d,gz+h), isoProj(gx+w,gy+d,gz), isoProj(gx+w,gy,gz)], cr),
    top:   isoRoundedQuad([isoProj(gx,gy,gz+h), isoProj(gx+w,gy,gz+h), isoProj(gx+w,gy+d,gz+h), isoProj(gx,gy+d,gz+h)], cr),
  };
}

// ── Precomputed stable geometry ───────────────────────────────────────────────
const PLAT_BLK: IsoBlk = { gx: -PW/2, gy: -PD/2, gz: 0, w: PW, d: PD, h: PH };
const PLAT_FACES = isoBlkFaces(PLAT_BLK, 28);
const [PLAT_TCX, PLAT_TCY] = isoProj(0, 0, PH);

interface SmallMeta {
  origIdx: number; cx: number; cy: number; depth: number;
  topCx: number; topCy: number;
  connBotX: number; connBotY: number;
  connTopX: number; connTopY: number;
  faces: IsoFaces;
}

const SMALLS: SmallMeta[] = BLOCK_CENTERS.map(([cx, cy, gz, depth], i) => {
  const [bw, bd] = BLOCK_SIZES[i];
  const hbw = bw / 2, hbd = bd / 2;
  const [topCx, topCy]       = isoProj(cx, cy, gz + BH);
  const [connBotX, connBotY] = isoProj(cx, cy, gz);
  const [connTopX, connTopY] = isoProj(cx, cy, PH + 0.04);
  const blk: IsoBlk = { gx: cx - hbw, gy: cy - hbd, gz, w: bw, d: bd, h: BH };
  return { origIdx: i, cx, cy, depth, topCx, topCy, connBotX, connBotY, connTopX, connTopY, faces: isoBlkFaces(blk, 13) };
});

const SMALLS_SORTED = [...SMALLS].sort((a, b) => (a.cx - a.cy) - (b.cx - b.cy));

// ── Component ─────────────────────────────────────────────────────────────────
function HeroAnimation() {
  type Vec2 = { x: number; y: number };
  const zero2  = (): Vec2 => ({ x: 0, y: 0 });
  const zeroes = (): Vec2[] => Array.from({ length: N_BLOCKS }, zero2);

  // ── Spring refs ─────────────────────────────────────────────────────────
  const sceneRef = useRef<Vec2>(zero2());
  const sceneTgt = useRef<Vec2>(zero2());
  const tiltRef  = useRef({ rx: 0, ry: 0 });
  const tiltTgt  = useRef({ rx: 0, ry: 0 });
  const blockRef = useRef<Vec2[]>(zeroes());
  const blockTgt = useRef<Vec2[]>(zeroes());
  const floatRef = useRef<number[]>(Array.from({ length: N_BLOCKS }, () => 0));

  // ── Render state ────────────────────────────────────────────────────────
  const [scenePos,      setScenePos]      = useState<Vec2>(zero2);
  const [tilt,          setTilt]          = useState({ rx: 0, ry: 0 });
  const [blockOffsets,  setBlockOffsets]  = useState<Vec2[]>(zeroes);
  const [floatOffsets,  setFloatOffsets]  = useState<number[]>(() => Array.from({ length: N_BLOCKS }, () => 0));
  const [isDragging,    setIsDragging]    = useState(false);

  // ── RAF loop: springs + float ────────────────────────────────────────────
  const rafRef = useRef<number | undefined>(undefined);
  useEffect(() => {
    const KS = 0.088, KT = 0.075, KB = 0.095;

    const tick = (timestamp: number) => {
      const t = timestamp / 1000; // seconds

      // Scene spring
      const sc = sceneRef.current, st = sceneTgt.current;
      sc.x += (st.x - sc.x) * KS;
      sc.y += (st.y - sc.y) * KS;

      // Tilt spring
      const ti = tiltRef.current, tt = tiltTgt.current;
      ti.rx += (tt.rx - ti.rx) * KT;
      ti.ry += (tt.ry - ti.ry) * KT;

      // Block drag springs
      const bl = blockRef.current, bt = blockTgt.current;
      let bc = false;
      for (let i = 0; i < N_BLOCKS; i++) {
        const dx = bt[i].x - bl[i].x, dy = bt[i].y - bl[i].y;
        if (Math.abs(dx) > 0.01 || Math.abs(dy) > 0.01) {
          bl[i].x += dx * KB; bl[i].y += dy * KB; bc = true;
        }
      }

      // Float bob — independent sine per block
      const fl = floatRef.current;
      let fc = false;
      for (let i = 0; i < N_BLOCKS; i++) {
        const next = Math.sin(t * FLOAT_SPEED + FLOAT_PHASES[i]) * FLOAT_AMP_PX;
        if (Math.abs(next - fl[i]) > 0.02) { fl[i] = next; fc = true; }
      }

      setScenePos({ x: sc.x, y: sc.y });
      setTilt({ rx: ti.rx, ry: ti.ry });
      if (bc) setBlockOffsets(bl.map(b => ({ ...b })));
      if (fc) setFloatOffsets([...fl]);
      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);
    return () => { if (rafRef.current !== undefined) cancelAnimationFrame(rafRef.current); };
  }, []);

  // ── Drag refs ────────────────────────────────────────────────────────────
  const dragMode     = useRef<'none' | 'scene' | number>('none');
  const dragStart    = useRef({ px: 0, py: 0, ox: 0, oy: 0 });
  const containerRef = useRef<HTMLDivElement>(null);
  const svgRef       = useRef<SVGSVGElement>(null);

  // ── Helpers ──────────────────────────────────────────────────────────────
  const getSvgScale = (): number => {
    const r = svgRef.current?.getBoundingClientRect();
    return r && r.width > 0 ? ISO_W / r.width : 1;
  };

  const clientToSvg = (cx: number, cy: number): [number, number] => {
    const r = svgRef.current!.getBoundingClientRect();
    const s = ISO_W / (r.width || ISO_W);
    return [(cx - r.left) * s, (cy - r.top) * s];
  };

  const getBounds = () => {
    const el = containerRef.current;
    if (!el) return { minX: -180, maxX: 180, minY: -110, maxY: 110 };
    const { width, height } = el.getBoundingClientRect();
    return { minX: -width * 0.27, maxX: width * 0.27, minY: -height * 0.22, maxY: height * 0.22 };
  };

  const elastic = (val: number, lo: number, hi: number): number => {
    if (val >= lo && val <= hi) return val;
    const edge = val < lo ? lo : hi;
    return edge + (val - edge) * 0.22;
  };

  const hitTest = (sx: number, sy: number): 'scene' | number | 'none' => {
    for (let k = SMALLS_SORTED.length - 1; k >= 0; k--) {
      const b = SMALLS_SORTED[k];
      const off = blockRef.current[b.origIdx];
      const fy  = floatRef.current[b.origIdx];
      const ex  = (sx - b.topCx - off.x) / 50;
      const ey  = (sy - b.topCy - off.y - fy) / 26;
      if (ex * ex + ey * ey < 1) return b.origIdx;
    }
    const px = (sx - PLAT_TCX) / (ISO_TW * PW * 0.76);
    const py = (sy - PLAT_TCY) / (ISO_TH * PD * 1.55);
    if (px * px + py * py < 1) return 'scene';
    return 'none';
  };

  // ── Pointer handlers ─────────────────────────────────────────────────────
  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!svgRef.current) return;
    const [sx, sy] = clientToSvg(e.clientX, e.clientY);
    const hit = hitTest(sx, sy);
    if (hit === 'none') return;
    dragMode.current = hit;
    dragStart.current = { px: e.clientX, py: e.clientY, ox: sceneRef.current.x, oy: sceneRef.current.y };
    setIsDragging(true);
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (dragMode.current === 'none') {
      const el = containerRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      tiltTgt.current = {
        rx: ((e.clientY - r.top) / r.height - 0.5) * -4.5,
        ry: ((e.clientX - r.left) / r.width - 0.5) * 5.0,
      };
      return;
    }
    const dx = e.clientX - dragStart.current.px;
    const dy = e.clientY - dragStart.current.py;

    if (dragMode.current === 'scene') {
      const b = getBounds();
      sceneTgt.current = {
        x: elastic(dragStart.current.ox + dx, b.minX, b.maxX),
        y: elastic(dragStart.current.oy + dy, b.minY, b.maxY),
      };
      tiltTgt.current = {
        rx: Math.max(-4.5, Math.min(4.5, -dy * 0.015)),
        ry: Math.max(-5.0, Math.min(5.0,  dx * 0.015)),
      };
    } else {
      const idx = dragMode.current as number;
      const s = getSvgScale();
      blockTgt.current[idx] = { x: dx * s, y: dy * s };
      for (let i = 0; i < N_BLOCKS; i++) {
        if (i === idx) continue;
        const dist = Math.hypot(SMALLS[i].cx - SMALLS[idx].cx, SMALLS[i].cy - SMALLS[idx].cy);
        const inf  = Math.max(0, 1 - dist / 4.8) * 0.20;
        blockTgt.current[i] = { x: dx * s * inf, y: dy * s * inf };
      }
    }
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (dragMode.current === 'none') return;
    if (dragMode.current === 'scene') {
      const b = getBounds();
      sceneTgt.current = {
        x: Math.max(b.minX, Math.min(b.maxX, sceneRef.current.x)),
        y: Math.max(b.minY, Math.min(b.maxY, sceneRef.current.y)),
      };
    } else {
      for (let i = 0; i < N_BLOCKS; i++) blockTgt.current[i] = { x: 0, y: 0 };
    }
    tiltTgt.current  = { rx: 0, ry: 0 };
    dragMode.current = 'none';
    setIsDragging(false);
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  };

  const handlePointerLeave = () => {
    if (dragMode.current !== 'none') return;
    tiltTgt.current = { rx: 0, ry: 0 };
  };

  const handleDoubleClick = () => {
    sceneTgt.current = { x: 0, y: 0 };
    tiltTgt.current  = { rx: 0, ry: 0 };
    for (let i = 0; i < N_BLOCKS; i++) blockTgt.current[i] = { x: 0, y: 0 };
    dragMode.current = 'none';
    setIsDragging(false);
  };

  // ── Render ───────────────────────────────────────────────────────────────
  return (
    <div
      ref={containerRef}
      className="absolute inset-0 overflow-hidden select-none"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      onPointerLeave={handlePointerLeave}
      onDoubleClick={handleDoubleClick}
      style={{
        perspective: '1500px',
        perspectiveOrigin: '50% 48%',
        cursor: isDragging ? 'grabbing' : 'default',
        touchAction: 'none',
      }}
      aria-label="Interactive reserve platform"
    >
      <div
        className="flex h-full w-full items-center justify-center"
        style={{
          transform: `translate3d(${scenePos.x}px,${scenePos.y}px,0) rotateX(${tilt.rx}deg) rotateY(${tilt.ry}deg)`,
          transformStyle: 'preserve-3d',
          transformOrigin: '50% 56%',
          willChange: 'transform',
        }}
      >
        <svg
          ref={svgRef}
          viewBox={`0 0 ${ISO_W} ${ISO_H}`}
          width={ISO_W}
          height={ISO_H}
          role="presentation"
          style={{ width: 'min(100%, 620px)', height: 'auto', overflow: 'visible' }}
        >
          <defs>
            {/* Glow */}
            <radialGradient id="rGlow" cx="50%" cy="50%" r="50%">
              <stop offset="0%"   stopColor="#7c3aed" stopOpacity="0.52"/>
              <stop offset="45%"  stopColor="#8b5cf6" stopOpacity="0.20"/>
              <stop offset="100%" stopColor="#a78bfa" stopOpacity="0"/>
            </radialGradient>

            {/* ── Base platform ── white top, rich uniform purple sides ── */}
            <linearGradient id="pTop" x1="0" y1="0" x2="0.9" y2="1">
              <stop offset="0%"   stopColor="#ffffff"/>
              <stop offset="60%"  stopColor="#faf8ff"/>
              <stop offset="100%" stopColor="#eae4ff"/>
            </linearGradient>
            {/* Left face — all deep purple, subtle top highlight only */}
            <linearGradient id="pLeft" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%"   stopColor="#9d6ff5"/>
              <stop offset="100%" stopColor="#4c1d95"/>
            </linearGradient>
            {/* Right face — slightly deeper / shadow side */}
            <linearGradient id="pRight" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%"   stopColor="#7c3aed"/>
              <stop offset="100%" stopColor="#3b0764"/>
            </linearGradient>

            {/* ── Small blocks ── white top, matching purple trim ── */}
            <linearGradient id="bTop" x1="0" y1="0" x2="0.9" y2="1">
              <stop offset="0%"   stopColor="#ffffff"/>
              <stop offset="100%" stopColor="#f0ecff"/>
            </linearGradient>
            {/* Left face */}
            <linearGradient id="bLeft" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%"   stopColor="#ab8ef8"/>
              <stop offset="100%" stopColor="#8b5cf6"/>
            </linearGradient>
            {/* Right face — barely distinguishable */}
            <linearGradient id="bRight" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%"   stopColor="#9b72f0"/>
              <stop offset="100%" stopColor="#7c3aed"/>
            </linearGradient>

            {/* Shadows */}
            <filter id="pShadow" x="-35%" y="-45%" width="170%" height="210%">
              <feDropShadow dx="0" dy="10" stdDeviation="12" floodColor="#5b21b6" floodOpacity="0.30"/>
            </filter>
            <filter id="bShadow" x="-55%" y="-75%" width="210%" height="250%">
              <feDropShadow dx="0" dy="4"  stdDeviation="6"  floodColor="#7c3aed" floodOpacity="0.22"/>
            </filter>
            <filter id="glowBlur" x="-55%" y="-55%" width="210%" height="210%">
              <feGaussianBlur stdDeviation="16"/>
            </filter>
          </defs>

          {/* Ambient glow */}
          <ellipse
            cx={ISO_OX} cy={ISO_OY + 55} rx={195} ry={90}
            fill="url(#rGlow)" filter="url(#glowBlur)" pointerEvents="none"
          />

          {/* Base platform */}
          <g filter="url(#pShadow)" style={{ cursor: 'grab' }}>
            <path d={PLAT_FACES.left}  fill="url(#pLeft)"  stroke="#8b5cf6" strokeWidth="0.65"/>
            <path d={PLAT_FACES.right} fill="url(#pRight)" stroke="#6d28d9" strokeWidth="0.65"/>
            <path d={PLAT_FACES.top}   fill="url(#pTop)"   stroke="#c4b5fd" strokeWidth="0.80"/>
          </g>

          {/* Connectors — anchor fixed at platform, bottom follows block float+drag */}
          {SMALLS.map((b) => {
            const off = blockOffsets[b.origIdx] ?? { x: 0, y: 0 };
            const fy  = floatOffsets[b.origIdx] ?? 0;
            return (
              <line
                key={`c${b.origIdx}`}
                x1={b.connTopX}           y1={b.connTopY}
                x2={b.connBotX + off.x}   y2={b.connBotY + off.y + fy}
                stroke="rgba(167,139,250,0.30)" strokeWidth="0.70"
                strokeDasharray="1.8 4.0" strokeLinecap="round"
                pointerEvents="none"
              />
            );
          })}

          {/* Floating small platforms — painter-sorted, individually bobbing */}
          {SMALLS_SORTED.map((b) => {
            const off = blockOffsets[b.origIdx] ?? { x: 0, y: 0 };
            const fy  = floatOffsets[b.origIdx] ?? 0;
            return (
              <g
                key={`b${b.origIdx}`}
                filter="url(#bShadow)"
                transform={`translate(${off.x.toFixed(2)} ${(off.y + fy).toFixed(2)})`}
                style={{ cursor: 'grab' }}
              >
                <path d={b.faces.left}  fill="url(#bLeft)"  stroke="#9b72f0" strokeWidth="0.55"/>
                <path d={b.faces.right} fill="url(#bRight)" stroke="#7c3aed" strokeWidth="0.55"/>
                <path d={b.faces.top}   fill="url(#bTop)"   stroke="#d8c6ff" strokeWidth="0.72"/>
                {/* Subtle inner highlight on top */}
                <path d={b.faces.top}
                  fill="none"
                  stroke="rgba(255,255,255,0.50)"
                  strokeWidth="0.36"
                  transform="translate(0 -0.28)"
                />
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
