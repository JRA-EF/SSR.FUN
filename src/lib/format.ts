const usd0 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })
const usd2 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 })
const usd4 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 4 })
const num = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 })

export function fmtUsd(v: number): string {
  if (Math.abs(v) >= 1_000_000_000) return `$${(v / 1_000_000_000).toFixed(2)}B`
  if (Math.abs(v) >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`
  if (Math.abs(v) >= 10_000) return usd0.format(v)
  return usd2.format(v)
}

export function fmtUsdExact(v: number): string {
  return v < 10 ? usd4.format(v) : usd2.format(v)
}

export function fmtNum(v: number): string {
  if (Math.abs(v) >= 1_000_000_000) return `${(v / 1_000_000_000).toFixed(2)}B`
  if (Math.abs(v) >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`
  if (Math.abs(v) >= 100_000) return `${(v / 1_000).toFixed(1)}K`
  return num.format(v)
}

export function fmtQty(v: number, maxDp = 4): string {
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: maxDp }).format(v)
}

export function fmtPct(v: number, dp = 1): string {
  return `${v.toFixed(dp)}%`
}

export function fmtSigned(v: number, dp = 1): string {
  return `${v >= 0 ? '+' : ''}${v.toFixed(dp)}%`
}

export function shortAddr(a: string): string {
  if (a.length <= 12) return a
  return `${a.slice(0, 4)}…${a.slice(-4)}`
}

export function fmtDate(ts: number): string {
  return new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

/** Hour-precision timestamp (no minutes) -- e.g. "Jul 24, 1 AM". Used for chart hover
 *  labels so the displayed granularity matches the underlying ~hourly chart resolution. */
export function fmtHour(ts: number): string {
  return new Date(ts).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
  })
}

export function timeAgo(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000)
  if (s < 60) return 'just now'
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  if (d < 30) return `${d}d ago`
  const mo = Math.floor(d / 30)
  return `${mo}mo ago`
}
