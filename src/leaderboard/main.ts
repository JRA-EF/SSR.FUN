// Public Beta Campaign leaderboard (leaderboard.html -> /leaderboard, DEC-0279).
// Read-only: fetches /api/mainnet/campaign-leaderboard and renders it. Its own
// Vite entry with no wallet/store code, served outside the BETA gate.

interface Row {
  rank: number; reserve: string; reserveId: string; mint: string; name: string; ticker: string
  imageUrl: string | null; handle: string; wallet: string; status: string; value: number
}
interface Trader { rank: number; wallet: string; handle: string; value: number; trades: number }
interface Board {
  phase: 'unscheduled' | 'upcoming' | 'live' | 'closed'
  startTs: number | null; endTs: number | null; entries: number; traderEntries: number
  volume: Row[]; pnl: Row[]; traders: Trader[]
  volumeLeader: { kind: 'reserve' | 'trader'; id: string; value: number } | null
  generatedAt: string
}

const $ = (id: string) => document.getElementById(id)!
const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 })
const short = (w: string) => `…${w.slice(-4)}`
const fmtDate = (ts: number) => new Date(ts * 1000).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'UTC', timeZoneName: 'short' })

function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...children: (Node | string)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v)
  for (const c of children) e.append(c)
  return e
}

function reserveCell(r: Row): HTMLElement {
  const img = el('img', { src: r.imageUrl || '/ssr-seal.png', alt: '', loading: 'lazy' })
  img.onerror = () => { img.src = '/ssr-seal.png' }
  const link = el('a', { href: `/r/${r.reserve}`, title: r.name }, r.name)
  const box = el('div', {}, link)
  if (r.ticker) box.append(el('div', { class: 'tick' }, `$${r.ticker}`))
  return el('div', { class: 'res' }, img, box)
}

function handleLink(h: string): HTMLElement {
  return el('a', { class: 'handle', href: `https://x.com/${encodeURIComponent(h)}`, target: '_blank', rel: 'noopener' }, `@${h}`)
}

function emptyRow(body: HTMLElement, cols: number, text: string) {
  body.replaceChildren(el('tr', {}, el('td', { colspan: String(cols), class: 'empty' }, text)))
}

function render(b: Board) {
  const pill = $('phase-pill'), text = $('phase-text')
  pill.classList.toggle('off', b.phase !== 'live')
  text.textContent = { unscheduled: 'Starting soon', upcoming: 'Starting soon', live: 'Live now', closed: 'Campaign closed' }[b.phase]
  $('when').textContent = b.startTs && b.endTs ? `${fmtDate(b.startTs)} – ${fmtDate(b.endTs)}` : 'Dates coming soon'

  const noEntries = 'No Reserves entered yet. Sign up once at ssr.fun/#/campaign, then create a Reserve.'
  const vb = $('volume-body')
  if (!b.volume.length) emptyRow(vb, 4, noEntries)
  else vb.replaceChildren(...b.volume.map(r => el('tr', {}, el('td', { class: 'rank' }, String(r.rank)), el('td', {}, reserveCell(r)), el('td', {}, handleLink(r.handle)), el('td', { class: 'num' }, usd.format(r.value)))))

  const pb = $('pnl-body')
  if (!b.pnl.length) emptyRow(pb, 4, noEntries)
  else pb.replaceChildren(...b.pnl.map(r => {
    const pct = el('td', { class: `num ${r.value >= 0 ? 'up' : 'down'}` }, `${r.value >= 0 ? '+' : ''}${r.value.toFixed(2)}%`)
    return el('tr', {}, el('td', { class: 'rank' }, String(r.rank)), el('td', {}, reserveCell(r)), el('td', {}, handleLink(r.handle)), pct)
  }))

  const tb = document.getElementById('trader-body')
  if (!tb) { /* Top Traders card removed; the trader leader still shows in the Volume card */ }
  else if (!b.traders.length) emptyRow(tb, 5, b.phase === 'live' || b.phase === 'closed' ? 'No signed-up trader has traded yet.' : 'Trading volume counts from the campaign start.')
  else tb.replaceChildren(...b.traders.map(t => el('tr', {}, el('td', { class: 'rank' }, String(t.rank)),
    el('td', {}, handleLink(t.handle)),
    el('td', {}, el('a', { class: 'handle mono', href: `https://solscan.io/account/${t.wallet}`, target: '_blank', rel: 'noopener', title: t.wallet }, short(t.wallet))),
    el('td', { class: 'num' }, String(t.trades)), el('td', { class: 'num' }, usd.format(t.value)))))

  const leader = $('volume-leader')
  if (b.volumeLeader) {
    leader.hidden = false
    if (b.volumeLeader.kind === 'reserve') {
      const r = b.volume.find(x => x.reserve === b.volumeLeader!.id)
      leader.replaceChildren('Leading the Volume track: ', el('b', {}, r ? r.name : 'a Reserve'), r ? ' by ' : '', r ? handleLink(r.handle) : '', ` with ${usd.format(b.volumeLeader.value)}.`)
    } else {
      const t = b.traders.find(x => x.wallet === b.volumeLeader!.id)
      leader.replaceChildren('Leading the Volume track: trader ', t ? handleLink(t.handle) : el('b', {}, short(b.volumeLeader.id)), ` with ${usd.format(b.volumeLeader.value)}.`)
    }
  } else leader.hidden = true

  $('updated').textContent = `${b.traderEntries ?? 0} wallet${b.traderEntries === 1 ? '' : 's'} signed up · ${b.entries} Reserve${b.entries === 1 ? '' : 's'} entered · Updated ${new Date(b.generatedAt).toLocaleTimeString()} · Volumes refresh every 30 minutes`
}

async function load() {
  try {
    const r = await fetch('/api/mainnet/campaign-leaderboard', { cache: 'no-store' })
    if (!r.ok) throw new Error(String(r.status))
    render(await r.json() as Board)
  } catch {
    $('updated').textContent = "Couldn't load the leaderboard. It will retry in a minute."
  }
}

void load()
setInterval(load, 60_000)
