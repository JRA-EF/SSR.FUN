/**
 * Fee math in integer basis points (1 bps = 0.01%).
 * SSR.fun fee = max(0.5%, 50% × Manager Fee); Total = Manager + SSR.fun.
 * Integer arithmetic only — no floating point in fee accounting.
 */

export const SSR_FEE_FLOOR_BPS = 50 // 0.5%
export const MANAGER_FEE_MAX_BPS = 5000 // 50%

export function ssrFeeBps(managerBps: number): number {
  const half = Math.floor(managerBps / 2)
  return Math.max(SSR_FEE_FLOOR_BPS, half)
}

export function totalFeeBps(managerBps: number): number {
  return managerBps + ssrFeeBps(managerBps)
}

/** Format bps as a percent string, e.g. 150 → "1.5%". */
export function bpsPct(bps: number): string {
  const whole = Math.floor(bps / 100)
  const frac = bps % 100
  if (frac === 0) return `${whole}%`
  const fracStr = frac % 10 === 0 ? `${frac / 10}` : `${frac < 10 ? '0' : ''}${frac}`
  return `${whole}.${fracStr}%`
}

/** Apply a fee in bps to an integer amount of micro-units. Returns [fee, net]. */
export function applyFeeMicro(amountMicro: number, bps: number): [number, number] {
  const fee = Math.floor((amountMicro * bps) / 10000)
  return [fee, amountMicro - fee]
}
