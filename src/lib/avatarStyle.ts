import type { CSSProperties } from 'react'

/** Deterministic avatar gradient derived from a ticker/id string. */
export function avatarStyle(seed: string): CSSProperties {
  let h = 0
  for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) % 360
  return {
    background: `linear-gradient(135deg, hsl(${h} 72% 56%), hsl(${(h + 42) % 360} 68% 40%))`,
  }
}
