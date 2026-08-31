import { useEffect, useRef } from 'react'

/**
 * Fragmented-platform hero: one large rounded platform with luminous violet
 * sides plus nine smaller matching platforms hovering above it.
 *
 * Interactions (all simulated locally, pure visual):
 * - the whole formation tilts subtly toward the cursor (parallax by depth)
 * - the large platform is draggable; the small ones follow with spring lag
 * - small platforms are draggable too, tugging the scene with weaker influence
 * - soft boundaries bounce everything back inside the stage
 * - double-click resets the composition
 */

const FRAME_W = 620
const FRAME_H = 470
const SQUASH = 0.58

interface TileDef {
  size: number
  cx: number
  cy: number
  /** Parallax/lag factor. 0 marks the anchor platform. */
  depth: number
  connector?: number
  /** Brand mark rendered floating on the platform's top face. */
  logo?: string
}

const TILES: TileDef[] = [
  { size: 248, cx: 310, cy: 330, depth: 0, logo: '/ssr-seal.png' },
  { size: 64, cx: 300, cy: 58, depth: 1.6, connector: 48, logo: '/logo-robinhood.svg' },
  { size: 56, cx: 152, cy: 98, depth: 1.2, connector: 40, logo: '/logo-ethereum.svg' },
  { size: 66, cx: 424, cy: 96, depth: 1.5, connector: 44, logo: '/logo-apple.svg' },
  { size: 54, cx: 84, cy: 192, depth: 0.9, connector: 34, logo: '/logo-spacex.svg' },
  { size: 84, cx: 232, cy: 162, depth: 1.1, connector: 46, logo: '/logo-solana.png' },
  { size: 74, cx: 392, cy: 210, depth: 1.4, connector: 44, logo: '/logo-base.svg' },
  { size: 60, cx: 514, cy: 158, depth: 1.8, connector: 50, logo: '/logo-binance.svg' },
  { size: 52, cx: 148, cy: 264, depth: 0.75, connector: 30, logo: '/logo-bitcoin.svg' },
  { size: 58, cx: 502, cy: 270, depth: 1.3, connector: 36, logo: '/logo-uniswap.svg' },
]

/** Displacement limits per tile so nothing leaves the stage. */
const BOUNDS = TILES.map(t => {
  const hw = t.size * 0.74
  const hh = t.size * 0.55
  return {
    minX: hw - t.cx,
    maxX: FRAME_W - hw - t.cx,
    minY: hh - t.cy,
    maxY: FRAME_H - hh - t.cy,
  }
})

interface Body {
  x: number
  y: number
  vx: number
  vy: number
  /** Persistent offset left behind by dragging ("new home"). */
  ox: number
  oy: number
}

interface Drag {
  i: number
  pointerId: number
  px0: number
  py0: number
  bx0: number
  by0: number
  lx: number
  ly: number
  lt: number
  vx: number
  vy: number
}

function rubber(v: number, min: number, max: number): number {
  if (v < min) return min + (v - min) * 0.25
  if (v > max) return max + (v - max) * 0.25
  return v
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v))
}

/* Squash is applied in screen space AFTER the 45° rotation (scaleY ∘ rotate),
   so each platform reads as a wide horizontal isometric diamond, not a
   diagonally tilted pill. Gradient angles are authored in local space:
   local 135deg maps to screen-vertical, local 45deg to screen-horizontal. */
/** Fine dotted plumb line hanging beneath a floating platform, drifting down
 *  very slowly (the loop translates by exactly one dot period, so it never
 *  visibly restarts; under reduced motion it freezes into a static dotted line). */
function DotStream({
  dx,
  top,
  h,
  gap,
  alpha,
  dur,
  delay,
}: {
  dx: number
  top: number
  h: number
  gap: number
  alpha: number
  dur: number
  delay: number
}) {
  const period = 2 + gap
  const pattern = `repeating-linear-gradient(to bottom, rgba(111, 99, 144, ${alpha}) 0 2px, transparent 2px ${period}px)`
  const style: React.CSSProperties & Record<'--feed-dur' | '--feed-period' | '--feed-run-delay', string> = {
    left: `calc(50% + ${dx - 1}px)`,
    top,
    height: h,
    '--feed-dur': `${dur}s`,
    '--feed-period': `${period}px`,
    '--feed-run-delay': `${delay}s`,
  }
  return (
    <div className="feed" aria-hidden="true" style={style}>
      <div className="feed-run" style={{ top: -period, height: `calc(100% + ${period}px)`, background: pattern }} />
    </div>
  )
}

/* Clean acrylic look matching the reference: pure-white top with a thin violet
   outline, vivid glassy purple side with bright corner glints, no blur/glow
   halos. Every platform shares identical proportions and material — the
   anchor is simply larger.
   Gradient angles are local-space: 135deg maps to screen-vertical, 45deg to
   screen-horizontal; local corners 0%/0% and 100%/100% map to the screen
   left/right diamond points. */
function TileFaces({ size, logo }: { size: number; logo?: string }) {
  const depthPx = size * 0.12
  return (
    <>
      {/* glassy purple side, rendered first and fully covered by the top face.
          Only the last ~15-27% of the local 135deg gradient is visible below the
          top, so the material interest is concentrated there: bright lavender
          seam sliver → electric violet body → deep bottom edge. Local corners
          (0,100%) and (100%,0) are the screen-left/right diamond points, where
          the reference shows luminous glints. */}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          borderRadius: '26%',
          transform: `translateY(${depthPx}px) scaleY(${SQUASH}) rotate(45deg)`,
          background: [
            'radial-gradient(circle at 0% 100%, rgba(255, 255, 255, 0.5) 0%, rgba(255, 255, 255, 0) 22%)',
            'radial-gradient(circle at 100% 0%, rgba(233, 238, 252, 0.45) 0%, rgba(255, 255, 255, 0) 22%)',
            'radial-gradient(ellipse at 55% 95%, rgba(151, 171, 239, 0.35) 0%, rgba(151, 171, 239, 0) 42%)',
            'linear-gradient(45deg, rgba(255, 255, 255, 0.12) 0%, rgba(255, 255, 255, 0) 35%, rgba(7, 4, 41, 0.22) 100%)',
            // The rim exposed below the top face spans t≈50% (left/right corners)
            // to 100% (bottom corner) of this local gradient: light periwinkle at
            // the corner ends, reserve blue mid-edge, deepest navy at the bottom.
            'linear-gradient(135deg, #edf1fd 0%, #c9d3f7 46%, #97abef 58%, #5d74c9 68%, #4155a6 85%, #1c1465 100%)',
          ].join(', '),
          boxShadow: `inset 0 0 ${size * 0.1}px rgba(222, 230, 250, 0.35)`,
        }}
      />
      {/* pure white top with crisp rim and thin violet outline */}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          borderRadius: '26%',
          transform: `scaleY(${SQUASH}) rotate(45deg)`,
          background: 'linear-gradient(135deg, #ffffff 0%, #fcfdff 70%, #f0f3fc 100%)',
          border: '1px solid rgba(65, 85, 166, 0.3)',
          boxShadow: 'inset 0 0 0 2px rgba(255, 255, 255, 0.9)',
        }}
      />
      {/* Brand mark wrapped onto the top face: same rotate+squash transform as
          the face itself, so the image lies in the platform's isometric plane
          like a printed surface. */}
      {logo && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            borderRadius: '26%',
            transform: `scaleY(${SQUASH}) rotate(45deg)`,
            overflow: 'hidden',
            border: '1px solid rgba(65, 85, 166, 0.3)',
            pointerEvents: 'none',
          }}
        >
          <img
            src={logo}
            alt=""
            draggable={false}
            style={{
              position: 'absolute',
              left: '50%',
              top: '50%',
              // The SSR seal on the flagship platform runs 15% larger than
              // the partner marks.
              width: logo === '/ssr-seal.png' ? '67%' : '58%',
              height: logo === '/ssr-seal.png' ? '67%' : '58%',
              transform: 'translate(-50%, -50%)',
              objectFit: 'contain',
              display: 'block',
              // The Solana token mark is a hard black square — soften it into
              // a rounded chip; other marks keep their native silhouettes.
              borderRadius: logo === '/logo-solana.png' ? '22%' : undefined,
              // Faded into the surface — reads as part of the material,
              // receding with the isometric perspective.
              opacity: 0.5,
            }}
          />
        </div>
      )}
    </>
  )
}

export function HeroPlatforms() {
  const outerRef = useRef<HTMLDivElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const groupRef = useRef<HTMLDivElement>(null)
  const tileEls = useRef<(HTMLDivElement | null)[]>([])

  const scaleRef = useRef(1)
  const bodiesRef = useRef<Body[]>(TILES.map(() => ({ x: 0, y: 0, vx: 0, vy: 0, ox: 0, oy: 0 })))
  const dragRef = useRef<Drag | null>(null)
  const pointerRef = useRef({ nx: 0, ny: 0 })
  const tiltRef = useRef({ rx: 0, ry: 0 })
  const parRef = useRef({ x: 0, y: 0 })
  const reducedRef = useRef(false)

  useEffect(() => {
    reducedRef.current =
      typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  }, [])

  // Scale the fixed 620x470 stage to the responsive wrapper.
  useEffect(() => {
    const outer = outerRef.current
    if (!outer) return
    const apply = () => {
      const s = Math.min(outer.clientWidth / FRAME_W, 1.12)
      scaleRef.current = s
      const stage = stageRef.current
      if (stage) stage.style.transform = `translate(-50%, -50%) scale(${s})`
    }
    apply()
    const ro = new ResizeObserver(apply)
    ro.observe(outer)
    return () => ro.disconnect()
  }, [])

  // Physics loop: springs, follow-lag, parallax, tilt, soft-bound bounce.
  useEffect(() => {
    let last = performance.now()
    let raf = 0

    const step = (now: number) => {
      const dt = clamp((now - last) / 1000, 0.001, 1 / 30)
      last = now

      const bodies = bodiesRef.current
      const drag = dragRef.current
      const anchor = bodies[0]
      const reduced = reducedRef.current
      const pt = pointerRef.current
      const par = parRef.current

      const parEase = reduced ? 1 : 0.07
      par.x += (pt.nx * 11 - par.x) * (reduced ? 1 : parEase)
      par.y += (pt.ny * 8 - par.y) * (reduced ? 1 : parEase)
      if (reduced) {
        par.x = 0
        par.y = 0
      }

      for (let i = 0; i < bodies.length; i++) {
        const b = bodies[i]
        const el = tileEls.current[i]
        if (drag && drag.i === i) {
          if (el) el.style.transform = `translate3d(${b.x}px, ${b.y}px, 0)`
          continue
        }
        const t = TILES[i]
        let tx: number
        let ty: number
        if (i === 0) {
          tx = b.ox
          ty = b.oy
          if (drag && drag.i !== 0) {
            // Small platforms tug the whole scene with weaker influence.
            tx += bodies[drag.i].x * 0.16
            ty += bodies[drag.i].y * 0.16
          }
        } else {
          tx = b.ox + anchor.x + par.x * t.depth
          ty = b.oy + anchor.y + par.y * t.depth
        }

        const k = i === 0 ? 110 : Math.max(40, 100 - t.depth * 32)
        const zeta = reduced ? 1 : i === 0 ? 0.72 : 0.5
        const c = 2 * Math.sqrt(k) * zeta
        b.vx += (k * (tx - b.x) - c * b.vx) * dt
        b.vy += (k * (ty - b.y) - c * b.vy) * dt
        b.x += b.vx * dt
        b.y += b.vy * dt

        const bd = BOUNDS[i]
        if (b.x < bd.minX) {
          b.x = bd.minX
          b.vx *= -0.4
        } else if (b.x > bd.maxX) {
          b.x = bd.maxX
          b.vx *= -0.4
        }
        if (b.y < bd.minY) {
          b.y = bd.minY
          b.vy *= -0.4
        } else if (b.y > bd.maxY) {
          b.y = bd.maxY
          b.vy *= -0.4
        }

        if (el) el.style.transform = `translate3d(${b.x}px, ${b.y}px, 0)`
      }

      const tilt = tiltRef.current
      if (!reduced) {
        tilt.rx += (pt.ny * -4.5 - tilt.rx) * 0.08
        tilt.ry += (pt.nx * 6.5 - tilt.ry) * 0.08
        const group = groupRef.current
        if (group) group.style.transform = `rotateX(${tilt.rx}deg) rotateY(${tilt.ry}deg)`
      }

      raf = requestAnimationFrame(step)
    }

    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [])

  const onStagePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const outer = outerRef.current
    if (!outer) return
    const rect = outer.getBoundingClientRect()
    pointerRef.current = {
      nx: clamp(((e.clientX - rect.left) / rect.width) * 2 - 1, -1, 1),
      ny: clamp(((e.clientY - rect.top) / rect.height) * 2 - 1, -1, 1),
    }
  }

  const onStagePointerLeave = () => {
    pointerRef.current = { nx: 0, ny: 0 }
  }

  const onReset = () => {
    for (const b of bodiesRef.current) {
      b.ox = 0
      b.oy = 0
    }
  }

  const tileDown = (i: number) => (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    const b = bodiesRef.current[i]
    dragRef.current = {
      i,
      pointerId: e.pointerId,
      px0: e.clientX,
      py0: e.clientY,
      bx0: b.x,
      by0: b.y,
      lx: e.clientX,
      ly: e.clientY,
      lt: performance.now(),
      vx: 0,
      vy: 0,
    }
  }

  const tileMove = (i: number) => (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag || drag.i !== i || drag.pointerId !== e.pointerId) return
    const s = scaleRef.current
    const b = bodiesRef.current[i]
    const bd = BOUNDS[i]
    b.x = rubber(drag.bx0 + (e.clientX - drag.px0) / s, bd.minX, bd.maxX)
    b.y = rubber(drag.by0 + (e.clientY - drag.py0) / s, bd.minY, bd.maxY)
    b.vx = 0
    b.vy = 0
    const now = performance.now()
    const dt = (now - drag.lt) / 1000
    if (dt > 0.004) {
      drag.vx = drag.vx * 0.4 + ((e.clientX - drag.lx) / s / dt) * 0.6
      drag.vy = drag.vy * 0.4 + ((e.clientY - drag.ly) / s / dt) * 0.6
      drag.lx = e.clientX
      drag.ly = e.clientY
      drag.lt = now
    }
  }

  const tileUp = (i: number) => (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag || drag.i !== i || drag.pointerId !== e.pointerId) return
    const b = bodiesRef.current[i]
    const bd = BOUNDS[i]
    const anchor = bodiesRef.current[0]
    if (i === 0) {
      b.ox = clamp(b.x, bd.minX, bd.maxX)
      b.oy = clamp(b.y, bd.minY, bd.maxY)
    } else {
      // The follow target includes the anchor's position, so store the remainder.
      b.ox = clamp(b.x, bd.minX, bd.maxX) - anchor.x
      b.oy = clamp(b.y, bd.minY, bd.maxY) - anchor.y
    }
    b.vx = clamp(drag.vx * 0.5, -1400, 1400)
    b.vy = clamp(drag.vy * 0.5, -1400, 1400)
    dragRef.current = null
  }

  return (
    <div
      ref={outerRef}
      className="hero-stage"
      role="presentation"
      onPointerMove={onStagePointerMove}
      onPointerLeave={onStagePointerLeave}
      onDoubleClick={onReset}
      title="Drag the platforms — double-click to reset"
    >
      <div
        ref={stageRef}
        style={{
          position: 'absolute',
          left: '50%',
          top: '50%',
          width: FRAME_W,
          height: FRAME_H,
          transform: 'translate(-50%, -50%)',
          perspective: 1200,
        }}
      >
        <div ref={groupRef} style={{ position: 'absolute', inset: 0, transformStyle: 'preserve-3d' }}>
          {TILES.map((t, i) => (
            <div
              key={i}
              ref={el => {
                tileEls.current[i] = el
              }}
              onPointerDown={tileDown(i)}
              onPointerMove={tileMove(i)}
              onPointerUp={tileUp(i)}
              onPointerCancel={tileUp(i)}
              style={{
                position: 'absolute',
                left: t.cx - t.size / 2,
                top: t.cy - t.size / 2,
                width: t.size,
                height: t.size,
                cursor: 'grab',
                touchAction: 'none',
                zIndex: t.depth === 0 ? 1 : 2,
              }}
            >
              {t.connector != null &&
                (() => {
                  // Two or three orderly dotted plumb lines per platform, hung
                  // near the left edge, center, and right edge — like the reference.
                  const len = t.connector
                  const lines = [
                    { fx: -0.32, mul: 2.2 + (i % 3) * 0.5, gap: 5 + (i % 2), a: 0.42, dur: 5 + (i % 4), delay: -(i % 5) },
                    { fx: 0.02, mul: 3.1 + ((i * 2) % 3) * 0.5, gap: 6, a: 0.34, dur: 6.5 - (i % 3), delay: -((i * 2) % 6) },
                    { fx: 0.3, mul: 1.9 + ((i + 1) % 3) * 0.6, gap: 5.5, a: 0.38, dur: 4.5 + ((i * 3) % 3), delay: -((i * 3) % 4) },
                  ].slice(0, i % 3 === 0 ? 2 : 3)
                  return lines.map((l, j) => (
                    <DotStream
                      key={j}
                      dx={l.fx * t.size}
                      top={t.size * 0.9}
                      h={len * l.mul}
                      gap={l.gap}
                      alpha={l.a}
                      dur={l.dur}
                      delay={l.delay}
                    />
                  ))
                })()}
              <TileFaces size={t.size} logo={t.logo} />
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
