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

// ─── Hero Animation: interactive isometric reserve platform ───────────────────

function HeroAnimation() {
  type MotionState = {
    rx: number;
    ry: number;
    tx: number;
    ty: number;
  };

  interface Blk {
    gx: number;
    gy: number;
    gz: number;
    w: number;
    d: number;
    h: number;
  }

  interface FloatingBlk extends Blk {
    cx: number;
    cy: number;
    depth: number;
  }

  const springRef = useRef<MotionState>({
    rx: 0,
    ry: 0,
    tx: 0,
    ty: 0,
  });

  const targetRef = useRef<MotionState>({
    rx: 0,
    ry: 0,
    tx: 0,
    ty: 0,
  });

  const dragOffsetRef = useRef({
    x: 0,
    y: 0,
  });

  const dragStartRef = useRef({
    pointerX: 0,
    pointerY: 0,
    sceneX: 0,
    sceneY: 0,
  });

  const isDraggingRef = useRef(false);

  const [spring, setSpring] = useState<MotionState>({
    rx: 0,
    ry: 0,
    tx: 0,
    ty: 0,
  });

  const [isDragging, setIsDragging] = useState(false);

  const rafRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    const easing = 0.085;

    const tick = () => {
      const current = springRef.current;
      const target = targetRef.current;

      current.rx += (target.rx - current.rx) * easing;
      current.ry += (target.ry - current.ry) * easing;
      current.tx += (target.tx - current.tx) * easing;
      current.ty += (target.ty - current.ty) * easing;

      setSpring({ ...current });

      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);

    return () => {
      if (rafRef.current !== undefined) {
        cancelAnimationFrame(rafRef.current);
      }
    };
  }, []);

  const updateHoverMotion = (
    element: HTMLDivElement,
    clientX: number,
    clientY: number,
  ) => {
    const rect = element.getBoundingClientRect();

    const nx = (clientX - rect.left) / rect.width - 0.5;
    const ny = (clientY - rect.top) / rect.height - 0.5;

    targetRef.current = {
      rx: ny * -6.5,
      ry: nx * 7.5,
      tx: dragOffsetRef.current.x + nx * 15,
      ty: dragOffsetRef.current.y + ny * 8,
    };
  };

  const handlePointerDown = (
    event: React.PointerEvent<HTMLDivElement>,
  ) => {
    isDraggingRef.current = true;
    setIsDragging(true);

    dragStartRef.current = {
      pointerX: event.clientX,
      pointerY: event.clientY,
      sceneX: dragOffsetRef.current.x,
      sceneY: dragOffsetRef.current.y,
    };

    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handlePointerMove = (
    event: React.PointerEvent<HTMLDivElement>,
  ) => {
    if (isDraggingRef.current) {
      const dx = event.clientX - dragStartRef.current.pointerX;
      const dy = event.clientY - dragStartRef.current.pointerY;

      const nextX = dragStartRef.current.sceneX + dx;
      const nextY = dragStartRef.current.sceneY + dy;

      dragOffsetRef.current = {
        x: nextX,
        y: nextY,
      };

      targetRef.current = {
        rx: Math.max(-7, Math.min(7, -dy * 0.025)),
        ry: Math.max(-8, Math.min(8, dx * 0.025)),
        tx: nextX,
        ty: nextY,
      };

      return;
    }

    updateHoverMotion(
      event.currentTarget,
      event.clientX,
      event.clientY,
    );
  };

  const stopDragging = (
    event: React.PointerEvent<HTMLDivElement>,
  ) => {
    if (!isDraggingRef.current) {
      return;
    }

    isDraggingRef.current = false;
    setIsDragging(false);

    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }

    targetRef.current = {
      rx: 0,
      ry: 0,
      tx: dragOffsetRef.current.x,
      ty: dragOffsetRef.current.y,
    };
  };

  const handlePointerLeave = () => {
    if (isDraggingRef.current) {
      return;
    }

    targetRef.current = {
      rx: 0,
      ry: 0,
      tx: dragOffsetRef.current.x,
      ty: dragOffsetRef.current.y,
    };
  };

  const resetPosition = () => {
    dragOffsetRef.current = {
      x: 0,
      y: 0,
    };

    targetRef.current = {
      rx: 0,
      ry: 0,
      tx: 0,
      ty: 0,
    };
  };

  const W = 620;
  const H = 500;

  const TW = 39;
  const TH = 17;
  const TZ = 39;

  const ox = W * 0.51;
  const oy = H * 0.69;

  const proj = (
    x: number,
    y: number,
    z: number,
  ): [number, number] => [
    ox + (x - y) * TW,
    oy + (x + y) * TH - z * TZ,
  ];

  function roundedQuad(
    points: [number, number][],
    radius: number,
  ): string {
    const count = points.length;
    let path = "";

    for (let i = 0; i < count; i += 1) {
      const previous = points[(i - 1 + count) % count];
      const current = points[i];
      const next = points[(i + 1) % count];

      const previousDx = previous[0] - current[0];
      const previousDy = previous[1] - current[1];
      const nextDx = next[0] - current[0];
      const nextDy = next[1] - current[1];

      const previousLength =
        Math.hypot(previousDx, previousDy) || 1;

      const nextLength =
        Math.hypot(nextDx, nextDy) || 1;

      const resolvedRadius = Math.min(
        radius,
        previousLength / 2.65,
        nextLength / 2.65,
      );

      const start: [number, number] = [
        current[0] +
          (previousDx / previousLength) * resolvedRadius,
        current[1] +
          (previousDy / previousLength) * resolvedRadius,
      ];

      const end: [number, number] = [
        current[0] +
          (nextDx / nextLength) * resolvedRadius,
        current[1] +
          (nextDy / nextLength) * resolvedRadius,
      ];

      path +=
        i === 0
          ? `M${start[0].toFixed(2)},${start[1].toFixed(2)}`
          : ` L${start[0].toFixed(2)},${start[1].toFixed(2)}`;

      path +=
        ` Q${current[0].toFixed(2)},${current[1].toFixed(2)}` +
        ` ${end[0].toFixed(2)},${end[1].toFixed(2)}`;
    }

    return `${path} Z`;
  }

  function blkFaces(block: Blk, cornerRadius: number) {
    const { gx, gy, gz, w, d, h } = block;

    const leftPoints: [number, number][] = [
      proj(gx, gy, gz + h),
      proj(gx + w, gy, gz + h),
      proj(gx + w, gy, gz),
      proj(gx, gy, gz),
    ];

    const rightPoints: [number, number][] = [
      proj(gx + w, gy, gz + h),
      proj(gx + w, gy + d, gz + h),
      proj(gx + w, gy + d, gz),
      proj(gx + w, gy, gz),
    ];

    const topPoints: [number, number][] = [
      proj(gx, gy, gz + h),
      proj(gx + w, gy, gz + h),
      proj(gx + w, gy + d, gz + h),
      proj(gx, gy + d, gz + h),
    ];

    return {
      left: roundedQuad(leftPoints, cornerRadius),
      right: roundedQuad(rightPoints, cornerRadius),
      top: roundedQuad(topPoints, cornerRadius),
    };
  }

  const platformWidth = 5.25;
  const platformDepth = 4.75;
  const platformHeight = 0.62;

  const platform: Blk = {
    gx: -platformWidth / 2,
    gy: -platformDepth / 2,
    gz: 0,
    w: platformWidth,
    d: platformDepth,
    h: platformHeight,
  };

  const blockWidth = 1.05;
  const blockDepth = 1.05;
  const blockHeight = 0.26;
  const halfBlock = blockWidth / 2;

  const centers: Array<
    [number, number, number, number]
  > = [
    [-2.35, -1.75, 2.55, 0.82],
    [0.00, -2.35, 4.00, 0.68],
    [2.35, -1.65, 3.08, 0.84],

    [-2.25, 0.15, 1.92, 0.90],
    [0.00, -0.45, 2.65, 1.08],
    [2.25, 0.10, 2.00, 0.88],

    [-1.70, 1.75, 1.45, 0.73],
    [0.75, 1.45, 2.02, 1.00],
    [2.55, 1.65, 1.45, 0.72],
  ];

  const smalls: FloatingBlk[] = centers.map(
    ([cx, cy, gz, depth]) => ({
      cx,
      cy,
      gz,
      depth,
      gx: cx - halfBlock,
      gy: cy - halfBlock,
      w: blockWidth,
      d: blockDepth,
      h: blockHeight,
    }),
  );

  const sortedSmalls = [...smalls].sort(
    (a, b) => a.gx + a.gy - (b.gx + b.gy),
  );

  const platformTopZ = platformHeight;

  return (
    <div
      className="absolute inset-0 overflow-hidden select-none"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={stopDragging}
      onPointerCancel={stopDragging}
      onPointerLeave={handlePointerLeave}
      onDoubleClick={resetPosition}
      style={{
        perspective: "1500px",
        perspectiveOrigin: "50% 48%",
        cursor: isDragging ? "grabbing" : "grab",
        touchAction: "none",
      }}
      aria-label="Interactive reserve platform"
    >
      <div
        className="flex h-full w-full items-center justify-center"
        style={{
          transform:
            `translate3d(${spring.tx}px, ${spring.ty}px, 0)` +
            ` rotateX(${spring.rx}deg)` +
            ` rotateY(${spring.ry}deg)`,
          transformStyle: "preserve-3d",
          transformOrigin: "50% 56%",
          willChange: "transform",
        }}
      >
        <svg
          viewBox={`0 0 ${W} ${H}`}
          width={W}
          height={H}
          role="presentation"
          style={{
            width: "min(100%, 620px)",
            height: "auto",
            overflow: "visible",
          }}
        >
          <defs>
            <radialGradient
              id="reserveAmbientGlow"
              cx="50%"
              cy="50%"
              r="50%"
            >
              <stop offset="0%" stopColor="#7c3aed" stopOpacity="0.58" />
              <stop offset="43%" stopColor="#8b5cf6" stopOpacity="0.25" />
              <stop offset="100%" stopColor="#a78bfa" stopOpacity="0" />
            </radialGradient>

            <linearGradient id="reserveBaseTop" x1="0.12" y1="0" x2="0.88" y2="1">
              <stop offset="0%" stopColor="#ffffff" />
              <stop offset="65%" stopColor="#fbfaff" />
              <stop offset="100%" stopColor="#eee9ff" />
            </linearGradient>

            <linearGradient id="reserveBaseLeft" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stopColor="#a855f7" />
              <stop offset="48%" stopColor="#7c3aed" />
              <stop offset="100%" stopColor="#5b21b6" />
            </linearGradient>

            <linearGradient id="reserveBaseRight" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#8b5cf6" />
              <stop offset="54%" stopColor="#6d28d9" />
              <stop offset="100%" stopColor="#4c1d95" />
            </linearGradient>

            <linearGradient id="reserveBlockTop" x1="0.12" y1="0" x2="0.88" y2="1">
              <stop offset="0%" stopColor="#ffffff" />
              <stop offset="78%" stopColor="#fdfcff" />
              <stop offset="100%" stopColor="#eee9ff" />
            </linearGradient>

            <linearGradient id="reserveBlockLeft" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stopColor="#c084fc" />
              <stop offset="52%" stopColor="#8b5cf6" />
              <stop offset="100%" stopColor="#6d28d9" />
            </linearGradient>

            <linearGradient id="reserveBlockRight" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#9f67f5" />
              <stop offset="52%" stopColor="#7c3aed" />
              <stop offset="100%" stopColor="#5b21b6" />
            </linearGradient>

            <filter id="reserveBaseShadow" x="-50%" y="-60%" width="200%" height="240%">
              <feDropShadow
                dx="0"
                dy="9"
                stdDeviation="12"
                floodColor="#6d28d9"
                floodOpacity="0.28"
              />
            </filter>

            <filter id="reserveBlockShadow" x="-80%" y="-100%" width="260%" height="300%">
              <feDropShadow
                dx="0"
                dy="4"
                stdDeviation="5"
                floodColor="#7c3aed"
                floodOpacity="0.25"
              />
            </filter>

            <filter id="reserveSoftBlur" x="-70%" y="-70%" width="240%" height="240%">
              <feGaussianBlur stdDeviation="12" />
            </filter>
          </defs>

          <ellipse
            cx={ox + 8}
            cy={oy + 45}
            rx={170}
            ry={78}
            fill="url(#reserveAmbientGlow)"
            filter="url(#reserveSoftBlur)"
            pointerEvents="none"
          />

          {(() => {
            const faces = blkFaces(platform, 24);

            return (
              <g filter="url(#reserveBaseShadow)">
                <path
                  d={faces.left}
                  fill="url(#reserveBaseLeft)"
                  stroke="#7c3aed"
                  strokeWidth="0.7"
                />

                <path
                  d={faces.right}
                  fill="url(#reserveBaseRight)"
                  stroke="#5b21b6"
                  strokeWidth="0.7"
                />

                <path
                  d={faces.top}
                  fill="url(#reserveBaseTop)"
                  stroke="#c4b5fd"
                  strokeWidth="0.85"
                />
              </g>
            );
          })()}

          {smalls.map((block, index) => {
            const [connectorX, blockBottomY] = proj(
              block.cx,
              block.cy,
              block.gz,
            );

            const [, platformSurfaceY] = proj(
              block.cx,
              block.cy,
              platformTopZ + 0.03,
            );

            return (
              <line
                key={`connector-${index}`}
                x1={connectorX}
                y1={platformSurfaceY}
                x2={connectorX}
                y2={blockBottomY}
                stroke="#a78bfa"
                strokeOpacity={0.19}
                strokeWidth={0.7}
                strokeDasharray="1.5 4"
                strokeLinecap="round"
                pointerEvents="none"
              />
            );
          })}

          {sortedSmalls.map((block, index) => {
            const faces = blkFaces(block, 8.5);

            const parallaxX = spring.ry * block.depth * 0.28;
            const parallaxY = spring.rx * block.depth * -0.18;

            return (
              <g
                key={`floating-reserve-${index}`}
                filter="url(#reserveBlockShadow)"
                transform={`translate(${parallaxX} ${parallaxY})`}
              >
                <path
                  d={faces.left}
                  fill="url(#reserveBlockLeft)"
                  stroke="#8b5cf6"
                  strokeWidth="0.55"
                />

                <path
                  d={faces.right}
                  fill="url(#reserveBlockRight)"
                  stroke="#6d28d9"
                  strokeWidth="0.55"
                />

                <path
                  d={faces.top}
                  fill="url(#reserveBlockTop)"
                  stroke="#d8b4fe"
                  strokeWidth="0.72"
                />

                <path
                  d={faces.top}
                  fill="none"
                  stroke="rgba(255,255,255,0.72)"
                  strokeWidth="0.42"
                  transform="translate(0 -0.35)"
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
