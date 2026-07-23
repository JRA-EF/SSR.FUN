import { useMemo, useState } from 'react'
import { useStore } from '../state/store'
import { Link } from '../lib/router'
import type { Delegate, DelegatePermissions, Reserve } from '../domain/types'
import { navPerToken, unallocatedBps } from '../domain/types'
import { ASSETS, assetById } from '../data/assets'
import { bpsPct } from '../lib/fees'
import { fmtDate, fmtNum, fmtPct, fmtUsd, fmtUsdExact, shortAddr, timeAgo } from '../lib/format'
import { CompositionBar } from '../components/charts'
import { compItems } from '../components/composition'
import { FeeControl } from '../components/FeeControl'
import { Addr, Modal, ReserveBadges, Stat, Toggle, TokenIcon, TokenStack } from '../components/ui'
import { DAY } from '../data/mock'

type Tab = 'overview' | 'rebalance' | 'fees' | 'delegates' | 'winddown'

const TABS: { id: Tab; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'rebalance', label: 'Rebalance' },
  { id: 'fees', label: 'Fees' },
  { id: 'delegates', label: 'Delegates' },
  { id: 'winddown', label: 'Wind-down' },
]

const PERM_LABELS: Record<keyof DelegatePermissions, string> = {
  manageDelegates: 'Manage delegates',
  rebalance: 'Rebalance',
  editFees: 'Edit mutable fees',
  editMetadata: 'Edit mutable metadata',
  pauseOperations: 'Pause selected operations',
  managePromotion: 'Marketplace promotion',
}

function RebalanceTab({ r }: { r: Reserve }) {
  const { dispatch, toast } = useStore()
  const [weights, setWeights] = useState<Record<string, number>>(() =>
    Object.fromEntries(r.allocations.map(a => [a.assetId, a.targetBps])),
  )
  const [assetIds, setAssetIds] = useState<string[]>(() => r.allocations.map(a => a.assetId))
  const [adding, setAdding] = useState(false)
  const [slipBps, setSlipBps] = useState(50)
  const [confirming, setConfirming] = useState(false)

  const totalBps = assetIds.reduce((s, id) => s + (weights[id] ?? 0), 0)
  const unBps = 10000 - totalBps
  const valid = totalBps <= 10000 && assetIds.length <= 10 && assetIds.every(id => (weights[id] ?? 0) > 0)

  const feeFreeUntil = r.lastRebalanceTs != null ? r.lastRebalanceTs + 30 * DAY : null
  const inFreeWindow = feeFreeUntil != null && Date.now() < feeFreeUntil

  const changes = useMemo(() => {
    const out: { label: string; from: number; to: number }[] = []
    for (const a of r.allocations) {
      const to = assetIds.includes(a.assetId) ? (weights[a.assetId] ?? 0) : 0
      if (to !== a.targetBps) out.push({ label: assetById(a.assetId).symbol, from: a.targetBps, to })
    }
    for (const id of assetIds) {
      if (!r.allocations.some(a => a.assetId === id)) out.push({ label: assetById(id).symbol, from: 0, to: weights[id] ?? 0 })
    }
    const fromUn = unallocatedBps(r.allocations)
    if (unBps !== fromUn) out.push({ label: 'Unallocated USDC', from: fromUn, to: unBps })
    return out
  }, [r, assetIds, weights, unBps])

  function removeAsset(id: string) {
    setAssetIds(ids => ids.filter(x => x !== id))
    setWeights(w => {
      const n = { ...w }
      delete n[id]
      return n
    })
  }

  function execute() {
    dispatch({
      type: 'rebalance',
      address: r.address,
      allocations: assetIds.map(id => ({ assetId: id, targetBps: weights[id] ?? 0, currentBps: weights[id] ?? 0 })),
    })
    toast('Rebalance executed (mock)', 'Targets updated. The change is recorded in the Reserve activity history.')
    setConfirming(false)
  }

  const available = ASSETS.filter(a => a.id !== 'usdc' && !assetIds.includes(a.id))

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div className="card card-pad">
        <div className="card-title">Target weights</div>
        <p className="faint" style={{ fontSize: 13, marginBottom: 10 }}>
          Removing an asset converts its allocation to Unallocated USDC first; reallocating that USDC is a separate,
          explicit decision. Manual rebalancing only — nothing is automated.
        </p>
        {assetIds.map(id => {
          const a = assetById(id)
          const w = weights[id] ?? 0
          return (
            <div className="alloc-row" key={id}>
              <span className="alloc-asset">
                <TokenIcon assetId={id} size={26} />
                <span style={{ fontWeight: 600 }}>{a.symbol}</span>
              </span>
              <input
                type="range"
                className="slider alloc-slider"
                min={0}
                max={10000}
                step={50}
                value={w}
                onChange={e => setWeights(x => ({ ...x, [id]: Number(e.target.value) }))}
                aria-label={`${a.symbol} target weight`}
              />
              <div className="input-suffix">
                <input
                  className="input mono"
                  style={{ padding: '7px 26px 7px 10px', fontSize: 13 }}
                  inputMode="decimal"
                  value={(w / 100).toString()}
                  onChange={e => {
                    const v = parseFloat(e.target.value)
                    if (!Number.isNaN(v) && v >= 0 && v <= 100) setWeights(x => ({ ...x, [id]: Math.round(v * 100) }))
                    else if (e.target.value === '') setWeights(x => ({ ...x, [id]: 0 }))
                  }}
                  aria-label={`${a.symbol} weight percent`}
                />
                <span className="suffix">%</span>
              </div>
              <button type="button" className="remove-x" onClick={() => removeAsset(id)} aria-label={`Remove ${a.symbol}`}>
                ✕
              </button>
            </div>
          )
        })}

        <div style={{ display: 'flex', gap: 12, marginTop: 14, flexWrap: 'wrap', alignItems: 'center' }}>
          <button className="btn btn-ghost btn-sm" onClick={() => setAdding(true)} disabled={assetIds.length >= 10}>
            + Add Reserve Asset
          </button>
          <span className="faint" style={{ fontSize: 12 }}>{assetIds.length}/10 assets</span>
        </div>

        <div className="total-bar">
          <span>
            Allocated <b className="num">{fmtPct(totalBps / 100)}</b>
            <span className="faint"> · Unallocated USDC </span>
            <b className="num">{fmtPct(Math.max(0, unBps) / 100)}</b>
          </span>
          {totalBps > 10000 ? (
            <span className="down" style={{ fontWeight: 600 }}>Over-allocated</span>
          ) : (
            <span className="up" style={{ fontWeight: 600 }}>✓ valid</span>
          )}
        </div>
      </div>

      <div className="card card-pad">
        <div className="card-title">Execution preview</div>
        {changes.length === 0 ? (
          <p className="faint" style={{ fontSize: 13 }}>No changes from current targets.</p>
        ) : (
          <table className="tbl">
            <thead>
              <tr>
                <th>Allocation</th>
                <th className="r">Current target</th>
                <th className="r">New target</th>
                <th className="r">Change</th>
              </tr>
            </thead>
            <tbody>
              {changes.map(c => (
                <tr key={c.label}>
                  <td>{c.label}</td>
                  <td className="r num">{fmtPct(c.from / 100)}</td>
                  <td className="r num">{fmtPct(c.to / 100)}</td>
                  <td className={`r num ${c.to - c.from >= 0 ? 'up' : 'down'}`}>
                    {c.to - c.from >= 0 ? '+' : ''}{fmtPct((c.to - c.from) / 100)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 16, flexWrap: 'wrap', gap: 12 }}>
          <label className="faint" style={{ fontSize: 13, display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            Slippage limit
            <div className="seg seg-sm">
              {[10, 50, 100].map(s => (
                <button key={s} className={slipBps === s ? 'active' : ''} onClick={() => setSlipBps(s)}>
                  {bpsPct(s)}
                </button>
              ))}
            </div>
          </label>
          <button className="btn btn-primary" disabled={!valid || changes.length === 0} onClick={() => setConfirming(true)}>
            Review rebalance
          </button>
        </div>
        <div className="callout warn" style={{ marginTop: 16 }}>
          <b>SSR.fun rebalancing fee:</b> 0.1% on the first completed rebalance in any rolling 30-day period; further
          rebalances in that window are free.{' '}
          {inFreeWindow
            ? `This Reserve last rebalanced ${timeAgo(r.lastRebalanceTs!)} — this rebalance is fee-free until ${fmtDate(feeFreeUntil!)}.`
            : 'This rebalance would incur the 0.1% fee.'}{' '}
          The fee base is still under specification. Once initiated, a rebalance cannot be paused or cancelled.
        </div>
      </div>

      <Modal open={adding} onClose={() => setAdding(false)} labelledBy="add-asset-title">
        <h3 id="add-asset-title">Add Reserve Asset</h3>
        <p className="muted" style={{ fontSize: 13, marginBottom: 14 }}>New assets start at 0% — set their target after adding.</p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 360, overflowY: 'auto' }}>
          {available.map(a => (
            <button
              key={a.id}
              className="asset-pick"
              onClick={() => {
                setAssetIds(ids => [...ids, a.id])
                setWeights(w => ({ ...w, [a.id]: 500 }))
                setAdding(false)
              }}
            >
              <TokenIcon assetId={a.id} size={26} />
              <span className="meta">
                <span className="sym">{a.symbol}</span>
                <span className="nm">{a.name}</span>
              </span>
            </button>
          ))}
        </div>
      </Modal>

      <Modal open={confirming} onClose={() => setConfirming(false)} labelledBy="reb-title">
        <h3 id="reb-title">Confirm rebalance</h3>
        <p className="muted" style={{ fontSize: 13, marginBottom: 14 }}>
          Executes at market with a {bpsPct(slipBps)} slippage limit and minimum-received enforcement per conversion.
          Once initiated it cannot be paused or cancelled.
        </p>
        <div className="fee-breakdown" style={{ marginBottom: 14 }}>
          {changes.map(c => (
            <div className="row" key={c.label}>
              <span className="muted">{c.label}</span>
              <span className="num">{fmtPct(c.from / 100)} → {fmtPct(c.to / 100)}</span>
            </div>
          ))}
          <div className="row total">
            <span>SSR.fun rebalancing fee</span>
            <span className="num">{inFreeWindow ? 'free (within 30-day window)' : '0.1%'}</span>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <button className="btn btn-ghost" style={{ flex: 1 }} onClick={() => setConfirming(false)}>Cancel</button>
          <button className="btn btn-primary" style={{ flex: 1 }} onClick={execute}>Execute (mock)</button>
        </div>
      </Modal>
    </div>
  )
}

function FeesTab({ r }: { r: Reserve }) {
  const { dispatch, toast } = useStore()
  const [mint, setMint] = useState(r.fees.mintBps)
  const [redeem, setRedeem] = useState(r.fees.redeemBps)
  const [tvl, setTvl] = useState(r.fees.tvlBps)
  const dirty = mint !== r.fees.mintBps || redeem !== r.fees.redeemBps || tvl !== r.fees.tvlBps

  return (
    <div>
      <FeeControl label="Manager Mint Fee" bps={mint} onChange={setMint} />
      <FeeControl label="Manager Redemption Fee" bps={redeem} onChange={setRedeem} />
      <FeeControl label="Manager Annualized TVL Fee" bps={tvl} onChange={setTvl} annualized />
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
        <button
          className="btn btn-ghost"
          disabled={!dirty}
          onClick={() => {
            setMint(r.fees.mintBps)
            setRedeem(r.fees.redeemBps)
            setTvl(r.fees.tvlBps)
          }}
        >
          Reset
        </button>
        <button
          className="btn btn-primary"
          disabled={!dirty}
          onClick={() => {
            dispatch({ type: 'update-fees', address: r.address, fees: { mintBps: mint, redeemBps: redeem, tvlBps: tvl } })
            toast('Fees updated (mock)', 'New fees apply to future mints and redemptions and are visible to all users.')
          }}
        >
          Save fees (mock)
        </button>
      </div>
    </div>
  )
}

function DelegatesTab({ r }: { r: Reserve }) {
  const { dispatch, toast } = useStore()
  const [addr, setAddr] = useState('')
  const [label, setLabel] = useState('')

  function setPerm(dAddr: string, key: keyof DelegatePermissions, v: boolean) {
    dispatch({
      type: 'set-delegates',
      address: r.address,
      delegates: r.delegates.map(d => (d.address === dAddr ? { ...d, permissions: { ...d.permissions, [key]: v } } : d)),
    })
  }

  function addDelegate() {
    if (addr.trim().length < 20) return
    const d: Delegate = {
      address: addr.trim(),
      label: label.trim() || shortAddr(addr.trim()),
      permissions: { manageDelegates: false, rebalance: false, editFees: false, editMetadata: false, pauseOperations: false, managePromotion: false },
    }
    dispatch({ type: 'set-delegates', address: r.address, delegates: [...r.delegates, d] })
    toast('Delegate added (mock)', 'Grant permissions individually — there is no all-powerful delegate role.')
    setAddr('')
    setLabel('')
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div className="callout">
        Delegates hold only the permissions you grant, each independently revocable. Delegates can never remove or
        replace the root Reserve Manager, and no delegate can withdraw Reserve Assets.
      </div>

      {r.delegates.map(d => (
        <div className="card card-pad" key={d.address}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
            <div>
              <div style={{ fontWeight: 600 }}>{d.label}</div>
              <Addr value={d.address} />
            </div>
            <button
              className="btn btn-danger btn-sm"
              onClick={() => {
                dispatch({ type: 'set-delegates', address: r.address, delegates: r.delegates.filter(x => x.address !== d.address) })
                toast('Delegate removed (mock)')
              }}
            >
              Remove
            </button>
          </div>
          <div className="perm-grid">
            {(Object.keys(PERM_LABELS) as (keyof DelegatePermissions)[]).map(k => (
              <div className="perm-item" key={k}>
                <span className="muted">{PERM_LABELS[k]}</span>
                <Toggle checked={d.permissions[k]} onChange={v => setPerm(d.address, k, v)} label={`${PERM_LABELS[k]} for ${d.label}`} />
              </div>
            ))}
          </div>
        </div>
      ))}

      <div className="card card-pad">
        <div className="card-title">Add delegate</div>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <input className="input mono" style={{ flex: 2, minWidth: 220 }} placeholder="Delegate wallet address" value={addr} onChange={e => setAddr(e.target.value)} aria-label="Delegate wallet address" />
          <input className="input" style={{ flex: 1, minWidth: 140 }} placeholder="Label (optional)" value={label} onChange={e => setLabel(e.target.value)} aria-label="Delegate label" />
          <button className="btn btn-ghost" onClick={addDelegate} disabled={addr.trim().length < 20}>Add</button>
        </div>
      </div>
    </div>
  )
}

function WindDownTab({ r }: { r: Reserve }) {
  const { dispatch, toast, wallet } = useStore()
  const [confirming, setConfirming] = useState(false)
  const [typed, setTyped] = useState('')
  const isCreator = r.creator === wallet

  if (r.status === 'winding-down') {
    return (
      <div className="callout danger">
        <b>Wind-down in progress.</b> Holders submit Reserve Tokens to claim their proportional distribution. The
        standard claim window runs one month; late claims remain possible indefinitely with a 30% penalty.
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div className="card card-pad">
        <div className="card-title">Complete Reserve wind-down</div>
        <p className="muted" style={{ fontSize: 14, marginBottom: 16 }}>
          A wind-down permanently closes the Reserve and distributes its assets to Reserve Holders. It is separate from
          ordinary redemption and only the original Reserve Creator can initiate it.
        </p>
        <table className="tbl" style={{ maxWidth: 520 }}>
          <tbody>
            <tr><td className="muted">Standard claim window</td><td className="r num">1 month</td></tr>
            <tr><td className="muted">SSR.fun wind-down fee</td><td className="r num">3%</td></tr>
            <tr><td className="muted">Execution-cost buffer</td><td className="r num">4× est. distribution cost</td></tr>
            <tr><td className="muted">Late-claim penalty after first month</td><td className="r num">30%</td></tr>
            <tr><td className="muted">Late claims</td><td className="r">possible indefinitely</td></tr>
          </tbody>
        </table>
        {!isCreator && (
          <div className="callout warn" style={{ marginTop: 16 }}>
            You manage this Reserve but are not its original Reserve Creator, so you cannot initiate a wind-down.
          </div>
        )}
        {isCreator && (
          <button className="btn btn-danger" style={{ marginTop: 18 }} onClick={() => setConfirming(true)}>
            Initiate wind-down…
          </button>
        )}
      </div>

      <Modal open={confirming} onClose={() => setConfirming(false)} labelledBy="wd-title">
        <h3 id="wd-title">Initiate complete wind-down</h3>
        <p className="muted" style={{ fontSize: 13, margin: '8px 0 14px' }}>
          This is irreversible. Minting closes, holders claim their proportional distribution, and the Reserve closes
          permanently once accounting completes. Type <b className="mono">{r.ticker}</b> to confirm.
        </p>
        <input className="input mono" value={typed} onChange={e => setTyped(e.target.value)} aria-label={`Type ${r.ticker} to confirm`} placeholder={r.ticker} />
        <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
          <button className="btn btn-ghost" style={{ flex: 1 }} onClick={() => setConfirming(false)}>Cancel</button>
          <button
            className="btn btn-danger"
            style={{ flex: 1 }}
            disabled={typed !== r.ticker}
            onClick={() => {
              dispatch({ type: 'wind-down', address: r.address })
              toast('Wind-down initiated (mock)', 'The one-month standard claim window has started.')
              setConfirming(false)
            }}
          >
            Initiate (mock)
          </button>
        </div>
      </Modal>
    </div>
  )
}

export function Manage() {
  const { managedReserves } = useStore()
  const [selected, setSelected] = useState<string | null>(null)
  const [tab, setTab] = useState<Tab>('overview')

  const r = managedReserves.find(x => x.address === selected) ?? managedReserves[0]

  if (!r) {
    return (
      <div className="container page">
        <div className="page-head">
          <h1>Reserve Manager</h1>
          <p className="sub">You do not manage any Reserves yet.</p>
        </div>
        <Link to="/create" className="btn btn-primary">Create your Reserve</Link>
      </div>
    )
  }

  return (
    <div className="container page">
      <div className="page-head" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', flexWrap: 'wrap', gap: 16 }}>
        <div>
          <h1>Reserve Manager</h1>
          <p className="sub">Manage the Reserves controlled by your wallet.</p>
        </div>
        <Link to="/create" className="btn btn-ghost">+ New Reserve</Link>
      </div>

      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 24 }}>
        {managedReserves.map(x => (
          <button
            key={x.address}
            className={`asset-pick${x.address === r.address ? ' selected' : ''}`}
            style={{ width: 'auto', minWidth: 220, flex: '0 1 auto' }}
            onClick={() => {
              setSelected(x.address)
              setTab('overview')
            }}
            aria-pressed={x.address === r.address}
          >
            <TokenStack assetIds={x.allocations.map(a => a.assetId)} size={20} max={3} />
            <span className="meta">
              <span className="sym">{x.name}</span>
              <span className="nm mono">{x.ticker} · {fmtUsd(x.navUsd)} TVL</span>
            </span>
          </button>
        ))}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 6 }}>
        <h2 className="display" style={{ fontSize: 28 }}>{r.name}</h2>
        <span className="mono muted">{r.ticker}</span>
        <ReserveBadges r={r} />
        <span style={{ flex: 1 }} />
        <Link to={`/reserve/${r.address}`} className="faint" style={{ fontSize: 13 }}>
          View public page →
        </Link>
      </div>

      <div className="mgr-tabs" role="tablist" aria-label="Manager sections">
        {TABS.map(t => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} className={`mgr-tab${tab === t.id ? ' active' : ''}`} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'overview' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          <div className="stat-row" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
            <Stat k="TVL (Reserve NAV)" v={fmtUsd(r.navUsd)} />
            <Stat k="NAV per token" v={fmtUsdExact(navPerToken(r))} />
            <Stat k="Holders" v={fmtNum(r.holders)} sub={`${fmtNum(r.supply)} ${r.ticker} supply`} />
            <Stat
              k="Est. annual Manager revenue"
              v={fmtUsd((r.navUsd * r.fees.tvlBps) / 10000)}
              sub={`${bpsPct(r.fees.tvlBps)} TVL fee · excludes mint/redeem fees`}
            />
          </div>
          <div className="card card-pad">
            <div className="card-title">Current vs target composition</div>
            <p className="faint" style={{ fontSize: 12, marginBottom: 6 }}>Current (drifted)</p>
            <CompositionBar items={compItems(r, 'current')} showList={false} />
            <p className="faint" style={{ fontSize: 12, margin: '14px 0 6px' }}>Target</p>
            <CompositionBar items={compItems(r, 'target')} />
            {r.allocations.some(a => Math.abs(a.currentBps - a.targetBps) >= 100) && (
              <div className="callout" style={{ marginTop: 14 }}>
                Composition has drifted ≥1% from target. Consider a manual rebalance from the Rebalance tab.
              </div>
            )}
          </div>
          <div className="card card-pad">
            <div className="card-title">Recent activity</div>
            {r.activity.slice(0, 8).map(e => (
              <div className="act-row" key={e.id}>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ fontWeight: 600 }}>{e.kind}</span>
                  <span className="faint"> · {shortAddr(e.wallet)}</span>
                  {e.note && <span className="faint" style={{ display: 'block', fontSize: 12 }}>{e.note}</span>}
                </span>
                {e.amountUsd != null && <span className="num muted">{fmtUsd(e.amountUsd)}</span>}
                <span className="faint">{timeAgo(e.ts)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {tab === 'rebalance' && <RebalanceTab key={r.address} r={r} />}
      {tab === 'fees' && <FeesTab key={r.address} r={r} />}
      {tab === 'delegates' && <DelegatesTab key={r.address} r={r} />}
      {tab === 'winddown' && <WindDownTab key={r.address} r={r} />}
    </div>
  )
}
