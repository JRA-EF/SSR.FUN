import { Link } from "wouter";
import { ArrowUpRight, ArrowDownRight, TrendingUp, Activity, BarChart3 } from "lucide-react";
import { FEATURED_DTR_ID, TRENDING_DTR_IDS } from "@/lib/seed-data";
import { formatUsdc } from "@/lib/calculations";
import { useAppStore } from "@/store/useAppStore";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useState, useEffect, useRef } from "react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";

type FloatBody = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  w: number;
  h: number;
  scale: number;
};

/** Deterministic per-card size/scale/speed so layout is stable and legible. */
function bodyProfile(index: number, total: number) {
  const scale = 0.82 + ((index * 37) % 100) / 100 * 0.28; // 0.82 - 1.10
  const speed = 0.22 + ((index * 53) % 100) / 100 * 0.28; // 0.22 - 0.5 px/frame, slow + premium
  const w = 256 * scale;
  const h = 92 * scale;
  return { scale, speed, w, h };
}

/** Lay bodies out on a jittered grid inside the container so they start spread apart, never stacked. */
function layoutBodies(containerRect: DOMRect, count: number): FloatBody[] {
  const cols = Math.max(2, Math.ceil(Math.sqrt(count * (containerRect.width / Math.max(containerRect.height, 1)))));
  const rows = Math.ceil(count / cols);
  const cellW = containerRect.width / cols;
  const cellH = containerRect.height / rows;

  return Array.from({ length: count }, (_, i) => {
    const { scale, speed, w, h } = bodyProfile(i, count);
    const col = i % cols;
    const row = Math.floor(i / cols);
    const jitterX = (Math.random() - 0.5) * cellW * 0.3;
    const jitterY = (Math.random() - 0.5) * cellH * 0.3;
    const x = Math.min(Math.max(col * cellW + (cellW - w) / 2 + jitterX, 8), Math.max(containerRect.width - w - 8, 8));
    const y = Math.min(Math.max(row * cellH + (cellH - h) / 2 + jitterY, 8), Math.max(containerRect.height - h - 8, 8));
    const angle = Math.random() * Math.PI * 2;
    return { x, y, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed, w, h, scale };
  });
}

/** Collision restitution > 1 exaggerates the "clash" -- the struck card flies off faster than the impact. */
const CLASH_RESTITUTION = 1.55;

type DragState = {
  index: number;
  grabOffsetX: number;
  grabOffsetY: number;
  lastX: number;
  lastY: number;
  lastT: number;
  vx: number;
  vy: number;
};

/** Live DTR Universe panel: bodies drift slowly, bounce off walls, collide with real impulse physics,
 *  and can be grabbed and flung at each other with the mouse. */
function LiveDtrUniverse({ dtrs }: { dtrs: any[] }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const bodiesRef = useRef<FloatBody[]>([]);
  const requestRef = useRef<number | undefined>(undefined);
  const [, setTick] = useState(0);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const hoveredIndexRef = useRef<number | null>(null);
  const dragStateRef = useRef<DragState | null>(null);
  const [draggingIndex, setDraggingIndex] = useState<number | null>(null);

  useEffect(() => {
    hoveredIndexRef.current = hoveredId ? dtrs.findIndex((d) => d.id === hoveredId) : null;
  }, [hoveredId, dtrs]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || dtrs.length === 0) return;

    const rect = container.getBoundingClientRect();
    bodiesRef.current = layoutBodies(rect, dtrs.length);
    setTick((t) => t + 1);

    const animate = () => {
      const bounds = container.getBoundingClientRect();
      const bodies = bodiesRef.current;
      const drag = dragStateRef.current;

      for (let i = 0; i < bodies.length; i++) {
        const b = bodies[i];
        if (drag && drag.index === i) continue; // position is driven directly by the pointer while dragged

        const isHovered = i === hoveredIndexRef.current;
        const speedMul = isHovered ? 0.15 : 1;
        b.x += b.vx * speedMul;
        b.y += b.vy * speedMul;

        // Bleed off a thrown card's excess speed so it settles back into a gentle drift.
        const speed = Math.hypot(b.vx, b.vy);
        if (speed > 3) {
          b.vx *= 0.965;
          b.vy *= 0.965;
        }

        if (b.x <= 0) { b.x = 0; b.vx = Math.abs(b.vx); }
        else if (b.x >= bounds.width - b.w) { b.x = bounds.width - b.w; b.vx = -Math.abs(b.vx); }
        if (b.y <= 0) { b.y = 0; b.vy = Math.abs(b.vy); }
        else if (b.y >= bounds.height - b.h) { b.y = bounds.height - b.h; b.vy = -Math.abs(b.vy); }
      }

      // Circle-circle collisions with real impulse response. A dragged card acts as an
      // immovable "cue" -- it keeps following the pointer, but whatever it clashes into
      // gets launched away at an exaggerated speed.
      for (let i = 0; i < bodies.length; i++) {
        for (let j = i + 1; j < bodies.length; j++) {
          const a = bodies[i];
          const b = bodies[j];
          const ar = Math.max(a.w, a.h) * 0.28;
          const br = Math.max(b.w, b.h) * 0.28;
          const ax = a.x + a.w / 2, ay = a.y + a.h / 2;
          const bx = b.x + b.w / 2, by = b.y + b.h / 2;
          const dx = bx - ax, dy = by - ay;
          const dist = Math.hypot(dx, dy) || 0.0001;
          const minDist = ar + br;

          if (dist < minDist) {
            const nx = dx / dist, ny = dy / dist;
            const overlap = minDist - dist;
            const aInvMass = drag && drag.index === i ? 0 : 1;
            const bInvMass = drag && drag.index === j ? 0 : 1;
            const totalInv = aInvMass + bInvMass || 1;

            a.x -= nx * overlap * (aInvMass / totalInv);
            a.y -= ny * overlap * (aInvMass / totalInv);
            b.x += nx * overlap * (bInvMass / totalInv);
            b.y += ny * overlap * (bInvMass / totalInv);

            const relVx = b.vx - a.vx, relVy = b.vy - a.vy;
            const velAlongNormal = relVx * nx + relVy * ny;
            if (velAlongNormal < 0) {
              // Only a clash against the card the user is actively dragging/throwing gets the
              // exaggerated "clash" restitution. Free-floating cards bouncing off each other use
              // normal (non-amplified) restitution so a single throw can't chain into a runaway
              // frenzy -- the boosted speed never propagates past the first card it hits.
              const isCueHit = aInvMass === 0 || bInvMass === 0;
              const restitution = isCueHit ? CLASH_RESTITUTION : 0.85;
              const jImpulse = (-(1 + restitution) * velAlongNormal) / totalInv;
              a.vx -= jImpulse * nx * aInvMass;
              a.vy -= jImpulse * ny * aInvMass;
              b.vx += jImpulse * nx * bInvMass;
              b.vy += jImpulse * ny * bInvMass;
            }
          }
        }
      }

      setTick((t) => t + 1);
      requestRef.current = requestAnimationFrame(animate);
    };

    requestRef.current = requestAnimationFrame(animate);

    const handleResize = () => {
      const newRect = container.getBoundingClientRect();
      bodiesRef.current = layoutBodies(newRect, dtrs.length);
    };
    window.addEventListener("resize", handleResize);

    return () => {
      if (requestRef.current) cancelAnimationFrame(requestRef.current);
      window.removeEventListener("resize", handleResize);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dtrs.length]);

  const handlePointerDown = (index: number, e: React.PointerEvent) => {
    const container = containerRef.current;
    const body = bodiesRef.current[index];
    if (!container || !body) return;
    const bounds = container.getBoundingClientRect();
    const pointerX = e.clientX - bounds.left;
    const pointerY = e.clientY - bounds.top;
    dragStateRef.current = {
      index,
      grabOffsetX: pointerX - body.x,
      grabOffsetY: pointerY - body.y,
      lastX: pointerX,
      lastY: pointerY,
      lastT: performance.now(),
      vx: 0,
      vy: 0,
    };
    setDraggingIndex(index);
    setHoveredId(null);
  };

  useEffect(() => {
    if (draggingIndex === null) return;

    const handlePointerMove = (e: PointerEvent) => {
      const container = containerRef.current;
      const drag = dragStateRef.current;
      const body = bodiesRef.current[draggingIndex];
      if (!container || !drag || !body) return;
      const bounds = container.getBoundingClientRect();
      const pointerX = e.clientX - bounds.left;
      const pointerY = e.clientY - bounds.top;

      const now = performance.now();
      const dt = Math.max(now - drag.lastT, 1);
      drag.vx = ((pointerX - drag.lastX) / dt) * 16.67;
      drag.vy = ((pointerY - drag.lastY) / dt) * 16.67;
      drag.lastX = pointerX;
      drag.lastY = pointerY;
      drag.lastT = now;

      body.x = Math.min(Math.max(pointerX - drag.grabOffsetX, 0), bounds.width - body.w);
      body.y = Math.min(Math.max(pointerY - drag.grabOffsetY, 0), bounds.height - body.h);
      body.vx = drag.vx;
      body.vy = drag.vy;
    };

    const handlePointerUp = () => {
      const drag = dragStateRef.current;
      const body = drag ? bodiesRef.current[drag.index] : null;
      if (body && drag) {
        // Flick it: launch the released card with a boosted version of its final drag velocity.
        body.vx = drag.vx * 1.8;
        body.vy = drag.vy * 1.8;
      }
      dragStateRef.current = null;
      setDraggingIndex(null);
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
    };
  }, [draggingIndex]);

  return (
    <div
      ref={containerRef}
      className="flex-1 relative bg-[radial-gradient(ellipse_at_center,_var(--tw-gradient-stops))] from-primary/5 via-background/50 to-background overflow-hidden touch-none"
    >
      {dtrs.map((dtr, i) => {
        const body = bodiesRef.current[i];
        if (!body) return null;
        return (
          <FloatingDTRCard
            key={dtr.id}
            dtr={dtr}
            body={body}
            isHovered={hoveredId === dtr.id}
            isDragging={draggingIndex === i}
            onHover={(hovered) => setHoveredId(hovered ? dtr.id : null)}
            onPointerDown={(e) => handlePointerDown(i, e)}
          />
        );
      })}
    </div>
  );
}

// Floating, draggable card component
function FloatingDTRCard({
  dtr,
  body,
  isHovered,
  isDragging,
  onHover,
  onPointerDown,
}: {
  dtr: any;
  body: FloatBody;
  isHovered: boolean;
  isDragging: boolean;
  onHover: (hovered: boolean) => void;
  onPointerDown: (e: React.PointerEvent) => void;
}) {
  const isPositive = dtr.change24h >= 0;
  const active = isHovered || isDragging;

  return (
    <div
      className={`absolute select-none touch-none ${isDragging ? 'cursor-grabbing z-[60]' : 'cursor-grab'} ${active && !isDragging ? 'z-50 shadow-2xl' : 'z-10 shadow-lg'} ${isDragging ? '' : 'transition-shadow duration-300'}`}
      style={{
        transform: `translate(${body.x}px, ${body.y}px) scale(${isDragging ? Math.min(body.scale * 1.14, 1.22) : isHovered ? Math.min(body.scale * 1.08, 1.15) : body.scale})`,
        transformOrigin: "top left",
        width: 256,
        transition: isDragging ? "none" : "transform 60ms linear",
      }}
      onPointerDown={onPointerDown}
      onMouseEnter={() => !isDragging && onHover(true)}
      onMouseLeave={() => !isDragging && onHover(false)}
    >
      <div
        className={`bg-card/80 backdrop-blur-md border rounded-xl p-4 flex flex-col gap-2 group transition-colors ${
          isDragging
            ? 'border-primary/60 bg-card/95 shadow-[0_0_36px_rgba(132,81,255,0.4)]'
            : 'border-white/5 hover:bg-card/95 hover:border-primary/30'
        }`}
      >
        <div className="flex justify-between items-center">
          <div className="flex items-center gap-3">
            <Avatar className="h-12 w-12 border border-white/10 shadow-md">
              {dtr.logoUrl && <AvatarImage src={dtr.logoUrl} alt={dtr.ticker} draggable={false} />}
              <AvatarFallback className="bg-primary/20 text-primary text-sm font-bold font-display">
                {dtr.ticker.slice(0, 2)}
              </AvatarFallback>
            </Avatar>
            <div>
              <p className="font-display font-bold text-sm text-foreground truncate max-w-[100px]">{dtr.ticker}</p>
            </div>
          </div>
          <div className="text-right">
            <p className="font-mono text-sm font-semibold">{formatUsdc(dtr.tokenPrice)}</p>
            <p className={`font-mono text-xs flex items-center justify-end ${isPositive ? 'text-positive' : 'text-destructive'}`}>
              {isPositive ? <ArrowUpRight className="w-3 h-3 mr-0.5" /> : <ArrowDownRight className="w-3 h-3 mr-0.5" />}
              {Math.abs(dtr.change24h).toFixed(2)}%
            </p>
          </div>
        </div>

        <div className={`overflow-hidden transition-all duration-300 ease-in-out ${isHovered && !isDragging ? 'max-h-24 opacity-100 mt-2 pt-2 border-t border-white/5' : 'max-h-0 opacity-0'}`}>
          <div className="flex justify-between text-xs mb-2">
            <span className="text-muted-foreground">TVL</span>
            <span className="font-mono text-foreground">{formatUsdc(dtr.aum, { compact: true })}</span>
          </div>
          <div>
            <span className="text-xs text-muted-foreground block mb-1">Top Assets</span>
            <div className="flex gap-1 flex-wrap">
              {dtr.composition.slice(0, 3).map((asset: any) => (
                <span key={asset.symbol} className="text-[10px] px-1.5 py-0.5 rounded bg-white/5 text-muted-foreground font-mono">
                  {asset.symbol}
                </span>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}


export function Home() {
  const [searchFilter, setSearchFilter] = useState("");
  const dtrs = useAppStore((s) => s.dtrs);

  const totalAum = dtrs.reduce((sum, dtr) => sum + dtr.aum, 0);
  const totalHolders = dtrs.reduce((sum, dtr) => sum + dtr.holders, 0);
  const activeDtrs = dtrs.length;
  // Fictional 24h volume approx 5% of AUM
  const volume24h = totalAum * 0.054;

  const featuredDtr = dtrs.find((d) => d.id === FEATURED_DTR_ID) ?? dtrs[0];
  const trendingDtrs = TRENDING_DTR_IDS.map((id) => dtrs.find((d) => d.id === id)).filter(
    (d): d is (typeof dtrs)[number] => Boolean(d),
  );

  const filteredDtrs = dtrs.filter(dtr => 
    dtr.name.toLowerCase().includes(searchFilter.toLowerCase()) || 
    dtr.ticker.toLowerCase().includes(searchFilter.toLowerCase()) ||
    dtr.category.toLowerCase().includes(searchFilter.toLowerCase())
  );

  return (
    <div className="min-h-[100dvh] flex flex-col">
      <main className="flex-1">
        {/* Hero Section - 42/58 Split */}
        <section className="relative overflow-hidden pt-12 pb-16 md:pt-20 md:pb-24">
          <div className="absolute left-0 right-0 top-0 -z-10 m-auto h-[400px] w-[400px] rounded-full bg-primary/10 blur-[120px]"></div>
          
          <div className="container mx-auto px-4 md:px-8 relative z-10">
            <div className="flex flex-col lg:flex-row gap-12 lg:gap-8 items-center">
              
              {/* Left Column - 42% */}
              <div className="w-full lg:w-[42%] flex flex-col items-start text-left">
                <Badge variant="outline" className="mb-6 border-white/10 text-muted-foreground bg-white/5 font-mono uppercase tracking-wider text-xs py-1">
                  Decentralized Token Reserve Protocol
                </Badge>
                
                <h1 className="font-display text-5xl sm:text-6xl lg:text-6xl xl:text-7xl font-bold tracking-tight mb-6 text-foreground leading-[1.1]">
                  One token.<br/>
                  <span className="bg-gradient-to-r from-foreground to-primary/80 bg-clip-text text-transparent">Infinite possibilities.</span>
                </h1>
                
                <p className="text-lg text-muted-foreground mb-10 max-w-md leading-relaxed font-sans">
                  Deploy your reserve on SSR.FUN and start earning fees.
                </p>
                
                <div className="flex flex-wrap items-center gap-4 w-full sm:w-auto">
                  <Button asChild size="lg" className="font-bold w-full sm:w-auto rounded-full px-8 h-12 shadow-[0_0_20px_rgba(132,81,255,0.3)] hover:shadow-[0_0_30px_rgba(132,81,255,0.5)] transition-shadow">
                    <Link href="/create">Deploy Your Reserve</Link>
                  </Button>
                  <Button asChild variant="outline" size="lg" className="w-full sm:w-auto rounded-full px-8 h-12 border-white/10 hover:bg-white/5">
                    <a href="#directory">Discover DTRs</a>
                  </Button>
                </div>
              </div>

              {/* Right Column - 58% */}
              <div className="w-full lg:w-[58%] h-[500px] lg:h-[600px] relative">
                <div className="absolute inset-0 bg-card rounded-[2rem] border border-white/5 shadow-2xl overflow-hidden flex flex-col">
                  <div className="p-6 border-b border-white/5 flex justify-between items-center bg-black/20">
                    <div className="flex items-center gap-3">
                      <div className="flex gap-1.5">
                        <div className="w-3 h-3 rounded-full bg-white/10"></div>
                        <div className="w-3 h-3 rounded-full bg-white/10"></div>
                        <div className="w-3 h-3 rounded-full bg-white/10"></div>
                      </div>
                      <span className="font-mono text-sm text-muted-foreground uppercase tracking-wider ml-2">Live DTR Universe</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="relative flex h-2 w-2">
                        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-positive opacity-75"></span>
                        <span className="relative inline-flex rounded-full h-2 w-2 bg-positive"></span>
                      </span>
                      <span className="font-mono text-xs text-muted-foreground">System Operational</span>
                    </div>
                  </div>
                  
                  <LiveDtrUniverse dtrs={dtrs} />
                </div>
              </div>

            </div>
          </div>
        </section>

        {/* Metrics Strip - Full Width Translucent Panel */}
        <div className="w-full bg-card/40 border-y border-white/5 backdrop-blur-sm">
          <div className="container mx-auto px-4 md:px-8">
            <div className="grid grid-cols-2 md:grid-cols-4 divide-x divide-white/5 py-8">
              <div className="px-6 flex flex-col items-center md:items-start text-center md:text-left">
                <p className="text-xs font-mono uppercase tracking-wider text-muted-foreground mb-2">Total DTR AUM</p>
                <p className="text-3xl font-mono font-bold text-foreground">{formatUsdc(totalAum, { compact: true })}</p>
              </div>
              <div className="px-6 flex flex-col items-center md:items-start text-center md:text-left">
                <p className="text-xs font-mono uppercase tracking-wider text-muted-foreground mb-2">24h Volume</p>
                <p className="text-3xl font-mono font-bold text-foreground">{formatUsdc(volume24h, { compact: true })}</p>
              </div>
              <div className="px-6 flex flex-col items-center md:items-start text-center md:text-left pt-6 md:pt-0">
                <p className="text-xs font-mono uppercase tracking-wider text-muted-foreground mb-2">Active DTRs</p>
                <p className="text-3xl font-mono font-bold text-foreground">{activeDtrs}</p>
              </div>
              <div className="px-6 flex flex-col items-center md:items-start text-center md:text-left pt-6 md:pt-0">
                <p className="text-xs font-mono uppercase tracking-wider text-muted-foreground mb-2">DTR Token Holders</p>
                <p className="text-3xl font-mono font-bold text-foreground">{totalHolders.toLocaleString()}</p>
              </div>
            </div>
          </div>
        </div>

        <div className="container mx-auto px-4 md:px-8 py-20 space-y-24">
          
          {/* Featured & Trending */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
            <div className="lg:col-span-2 space-y-6">
              <div className="flex items-center gap-2 mb-4">
                <BarChart3 className="w-5 h-5 text-primary" />
                <h2 className="text-2xl font-display font-bold">Featured Reserve</h2>
              </div>
              <Card className="bg-card/40 border-white/5 overflow-hidden relative group backdrop-blur-sm hover:border-primary/20 transition-colors">
                <div className="pointer-events-none absolute top-0 right-0 w-64 h-64 bg-primary/5 rounded-full blur-[80px] -mr-10 -mt-10 group-hover:bg-primary/10 transition-colors duration-700"></div>
                <CardContent className="p-8">
                  <div className="flex flex-col md:flex-row gap-8 items-start md:items-center">
                    <div className="flex-1">
                      <div className="flex items-center gap-4 mb-6">
                        <Avatar className="h-16 w-16 border border-white/10 shadow-lg">
                          {featuredDtr.logoUrl && <AvatarImage src={featuredDtr.logoUrl} alt={featuredDtr.ticker} />}
                          <AvatarFallback className="bg-primary/20 text-primary text-xl font-bold font-display">
                            {featuredDtr.ticker.slice(0, 2)}
                          </AvatarFallback>
                        </Avatar>
                        <div>
                          <h3 className="text-3xl font-display font-bold text-foreground leading-tight">{featuredDtr.name}</h3>
                          <div className="flex items-center gap-3 mt-2">
                            <Badge variant="secondary" className="font-mono bg-white/5 hover:bg-white/10 border-white/5">{featuredDtr.ticker}</Badge>
                            <span className="text-sm text-muted-foreground">{featuredDtr.category}</span>
                          </div>
                        </div>
                      </div>
                      <p className="text-muted-foreground mb-8 max-w-md leading-relaxed">
                        {featuredDtr.description}
                      </p>
                      
                      <div className="grid grid-cols-3 gap-6 mb-8">
                        <div>
                          <p className="text-xs font-mono uppercase tracking-wider text-muted-foreground mb-2">Price</p>
                          <p className="text-xl font-mono font-semibold">{formatUsdc(featuredDtr.tokenPrice)}</p>
                        </div>
                        <div>
                          <p className="text-xs font-mono uppercase tracking-wider text-muted-foreground mb-2">24h Change</p>
                          <p className={`text-xl font-mono font-semibold flex items-center ${featuredDtr.change24h >= 0 ? 'text-positive' : 'text-destructive'}`}>
                            {featuredDtr.change24h >= 0 ? <ArrowUpRight className="w-4 h-4 mr-1" /> : <ArrowDownRight className="w-4 h-4 mr-1" />}
                            {Math.abs(featuredDtr.change24h).toFixed(2)}%
                          </p>
                        </div>
                        <div>
                          <p className="text-xs font-mono uppercase tracking-wider text-muted-foreground mb-2">AUM</p>
                          <p className="text-xl font-mono font-semibold">{formatUsdc(featuredDtr.aum, { compact: true })}</p>
                        </div>
                      </div>

                      <div className="flex flex-wrap gap-2">
                        {featuredDtr.composition.slice(0, 4).map((asset: any) => (
                          <Badge key={asset.symbol} variant="outline" className="bg-white/5 border-white/5">
                            {asset.symbol} <span className="text-muted-foreground ml-1 font-mono">{(asset.weight * 100).toFixed(0)}%</span>
                          </Badge>
                        ))}
                        {featuredDtr.composition.length > 4 && (
                          <Badge variant="outline" className="bg-white/5 border-white/5 text-muted-foreground">+{featuredDtr.composition.length - 4}</Badge>
                        )}
                      </div>
                    </div>
                    
                    <div className="w-full md:w-auto shrink-0 flex flex-col gap-3">
                      <Button asChild size="lg" className="w-full md:w-48 font-semibold shadow-primary/20 shadow-lg rounded-full">
                        <Link href={`/dtr/${featuredDtr.id}`}>Trade {featuredDtr.ticker}</Link>
                      </Button>
                      <Button asChild variant="outline" size="lg" className="w-full md:w-48 bg-transparent border-white/10 rounded-full hover:bg-white/5">
                        <Link href={`/dtr/${featuredDtr.id}`}>View Details</Link>
                      </Button>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </div>

            <div className="space-y-6">
              <div className="flex items-center gap-2 mb-4">
                <TrendingUp className="w-5 h-5 text-primary" />
                <h2 className="text-2xl font-display font-bold">Trending</h2>
              </div>
              <div className="grid grid-cols-1 gap-3">
                {trendingDtrs.map((dtr) => {
                  return (
                    <Link key={dtr.id} href={`/dtr/${dtr.id}`}>
                      <Card className="border-white/5 hover:border-primary/30 transition-colors cursor-pointer bg-card/40 backdrop-blur-sm group">
                        <CardContent className="p-4 flex items-center gap-4">
                          <Avatar className="h-10 w-10 border border-white/10">
                            {dtr.logoUrl && <AvatarImage src={dtr.logoUrl} alt={dtr.ticker} />}
                            <AvatarFallback className="bg-white/5 text-muted-foreground font-display text-xs">
                              {dtr.ticker.slice(0, 2)}
                            </AvatarFallback>
                          </Avatar>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center justify-between mb-1">
                              <h4 className="font-semibold text-foreground truncate group-hover:text-primary transition-colors">{dtr.name}</h4>
                              <span className="font-mono text-sm">{formatUsdc(dtr.tokenPrice)}</span>
                            </div>
                            <div className="flex items-center justify-between text-xs">
                              <span className="text-muted-foreground font-mono">{dtr.ticker}</span>
                              <span className={`font-mono flex items-center ${dtr.change24h >= 0 ? 'text-positive' : 'text-destructive'}`}>
                                {dtr.change24h >= 0 ? <ArrowUpRight className="w-3 h-3 mr-0.5" /> : <ArrowDownRight className="w-3 h-3 mr-0.5" />}
                                {Math.abs(dtr.change24h).toFixed(2)}%
                              </span>
                            </div>
                          </div>
                        </CardContent>
                      </Card>
                    </Link>
                  );
                })}
              </div>
            </div>
          </div>

          {/* All DTRs */}
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
                  <Card key={dtr.id} className="flex flex-col bg-card/40 border-white/5 hover:border-primary/30 transition-all duration-300 group backdrop-blur-sm">
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
                          <p className={`font-mono text-sm font-medium flex items-center ${dtr.change24h >= 0 ? 'text-positive' : 'text-destructive'}`}>
                            {dtr.change24h >= 0 ? '+' : ''}{dtr.change24h.toFixed(2)}%
                          </p>
                        </div>
                        <div>
                          <p className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground mb-1.5">NAV</p>
                          <p className="font-mono text-sm text-muted-foreground">{formatUsdc(dtr.nav)}</p>
                        </div>
                        <div>
                          <p className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground mb-1.5">Prem/Discount</p>
                          <p className={`font-mono text-sm ${isPremium ? 'text-positive' : 'text-destructive'}`}>
                            {isPremium ? '+' : ''}{(premiumDiscount * 100).toFixed(2)}%
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
                      <Button asChild className="w-full rounded-full bg-white/5 border border-white/5 hover:bg-primary hover:text-primary-foreground hover:border-primary transition-all duration-300" variant="secondary">
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
          <p className="font-mono text-xs tracking-widest uppercase">SSR.FUN • Decentralized Token Reserves</p>
          <p className="mt-4 text-xs opacity-40">This is a simulated environment. Fictional data only.</p>
        </div>
      </footer>
    </div>
  );
}