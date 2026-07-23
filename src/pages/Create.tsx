import { useMemo, useState } from 'react'
import { useStore } from '../state/store'
import { navigate } from '../lib/router'
import type { Reserve } from '../domain/types'
import { ASSETS, assetById, capabilityNotes } from '../data/assets'
import { bpsPct, ssrFeeBps } from '../lib/fees'
import { fmtPct, fmtQty, fmtUsd } from '../lib/format'
import { CompositionBar, SERIES_COLORS, UNALLOC_COLOR } from '../components/charts'
import { TokenIcon } from '../components/ui'
import { FeeControl } from '../components/FeeControl'

const STEPS = ['Basics', 'Reserve Assets', 'Allocations', 'Fees', 'Preview & seed']
const MAX_ASSETS = 10

interface Draft {
  name: string
  ticker: string
  description: string
  assetIds: string[]
  weights: Record<string, number> // bps
  mintBps: number
  redeemBps: number
  tvlBps: number
  seedUsd: number
}

const initialDraft: Draft = {
  name: '',
  ticker: '',
  description: '',
  assetIds: [],
  weights: {},
  mintBps: 100,
  redeemBps: 100,
  tvlBps: 100,
  seedUsd: 10_000,
}

export function Create() {
  const { dispatch, toast, wallet } = useStore()
  const [step, setStep] = useState(0)
  const [draft, setDraft] = useState<Draft>(initialDraft)
  const [assetQuery, setAssetQuery] = useState('')

  const set = (patch: Partial<Draft>) => setDraft(d => ({ ...d, ...patch }))

  const totalBps = draft.assetIds.reduce((s, id) => s + (draft.weights[id] ?? 0), 0)
  const unBps = 10000 - totalBps

  const stepValid = useMemo(() => {
    switch (step) {
      case 0:
        return draft.name.trim().length >= 3 && /^[A-Z0-9]{2,8}$/.test(draft.ticker)
      case 1:
        return draft.assetIds.length >= 1 && draft.assetIds.length <= MAX_ASSETS
      case 2:
        return totalBps <= 10000 && draft.assetIds.every(id => (draft.weights[id] ?? 0) > 0)
      case 3:
        return true
      default:
        return true
    }
  }, [step, draft, totalBps])

  const filteredAssets = ASSETS.filter(a => {
    if (a.id === 'usdc') return false // USDC is the unallocated asset, not a picked Reserve Asset
    const t = assetQuery.trim().toLowerCase()
    return !t || a.symbol.toLowerCase().includes(t) || a.name.toLowerCase().includes(t)
  })

  function toggleAsset(id: string) {
    setDraft(d => {
      if (d.assetIds.includes(id)) {
        const weights = { ...d.weights }
        delete weights[id]
        return { ...d, assetIds: d.assetIds.filter(x => x !== id), weights }
      }
      if (d.assetIds.length >= MAX_ASSETS) return d
      const even = Math.floor(10000 / (d.assetIds.length + 1) / 100) * 100
      return { ...d, assetIds: [...d.assetIds, id], weights: { ...d.weights, [id]: Math.min(even, 2000) } }
    })
  }

  const compPreview = [
    ...draft.assetIds.map((id, i) => ({
      label: assetById(id).symbol,
      bps: draft.weights[id] ?? 0,
      color: SERIES_COLORS[i % SERIES_COLORS.length],
    })),
    ...(unBps > 0 ? [{ label: 'Unallocated USDC', bps: unBps, color: UNALLOC_COLOR }] : []),
  ].filter(x => x.bps > 0)

  function deploy() {
    const address = `Rsv${Math.random().toString(36).slice(2, 10)}${Math.random().toString(36).slice(2, 10)}Mock`
    const nav = 1 // first mint at $1.00 per Reserve Token
    const reserve: Reserve = {
      address,
      name: draft.name.trim(),
      ticker: draft.ticker,
      description: draft.description.trim() || 'A new Reserve created on SSR.fun.',
      creator: wallet,
      manager: wallet,
      createdAt: Date.now(),
      allocations: draft.assetIds.map(id => ({ assetId: id, targetBps: draft.weights[id] ?? 0, currentBps: draft.weights[id] ?? 0 })),
      fees: { mintBps: draft.mintBps, redeemBps: draft.redeemBps, tvlBps: draft.tvlBps },
      supply: draft.seedUsd / nav,
      navUsd: draft.seedUsd,
      marketPrice: null,
      holders: 1,
      verified: false,
      indexed: true,
      riskLabels: ['New reserve'],
      navSeries: [nav, nav],
      marketSeries: null,
      activity: [
        {
          id: `create-${address}`,
          kind: 'create',
          ts: Date.now(),
          wallet,
          amountUsd: draft.seedUsd,
          note: 'Reserve created and seeded in kind (mock)',
        },
      ],
      delegates: [],
      status: 'active',
      lastRebalanceTs: null,
    }
    dispatch({ type: 'create-reserve', reserve, seedUsd: draft.seedUsd })
    toast('Reserve deployed (mock)', `${draft.name} is live in the prototype. You are its Reserve Manager.`)
    navigate(`/reserve/${address}`)
  }

  const seedRows = draft.assetIds.map(id => {
    const a = assetById(id)
    const usd = (draft.seedUsd * (draft.weights[id] ?? 0)) / 10000
    return { asset: a, usd, qty: a.capabilities.canPrice && a.price > 0 ? usd / a.price : null }
  })

  return (
    <div className="container page">
      <div className="page-head">
        <h1>Create your Reserve</h1>
        <p className="sub">
          Configure a basket of up to {MAX_ASSETS} Reserve Assets, set your fees, and seed it in kind. Creation is
          permissionless — this prototype simulates every step with mock data.
        </p>
      </div>

      <div className="wizard">
        <div className="wizard-steps" role="tablist" aria-label="Creation steps">
          {STEPS.map((s, i) => (
            <button
              key={s}
              role="tab"
              aria-selected={step === i}
              className={`wstep${step === i ? ' active' : ''}${i < step ? ' done' : ''}`}
              onClick={() => {
                if (i < step) setStep(i)
              }}
            >
              <span className="idx">{i < step ? '✓' : i + 1}</span>
              {s}
            </button>
          ))}
        </div>

        <div>
          {step === 0 && (
            <div className="card card-pad">
              <div className="card-title">Basics</div>
              <div className="field">
                <label htmlFor="c-name">Reserve name</label>
                <input id="c-name" className="input" placeholder="e.g. Solana momentum" value={draft.name} onChange={e => set({ name: e.target.value })} maxLength={40} />
                <p className="hint">Immutable after creation.</p>
              </div>
              <div className="field">
                <label htmlFor="c-ticker">Reserve Token ticker</label>
                <input
                  id="c-ticker"
                  className="input mono"
                  placeholder="e.g. SMOM"
                  value={draft.ticker}
                  onChange={e => set({ ticker: e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8) })}
                />
                <p className="hint">2–8 characters, A–Z and 0–9. Immutable after creation.</p>
              </div>
              <div className="field" style={{ marginBottom: 0 }}>
                <label htmlFor="c-desc">Description</label>
                <textarea id="c-desc" className="textarea" placeholder="What does this Reserve hold, and why?" value={draft.description} onChange={e => set({ description: e.target.value })} maxLength={280} />
                <p className="hint">Editable later by the Reserve Manager.</p>
              </div>
            </div>
          )}

          {step === 1 && (
            <div className="card card-pad">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10, marginBottom: 14 }}>
                <div className="card-title" style={{ marginBottom: 0 }}>
                  Pick Reserve Assets <span className="faint">({draft.assetIds.length}/{MAX_ASSETS})</span>
                </div>
                <div className="search">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <circle cx="11" cy="11" r="7" />
                    <path d="m20 20-3.5-3.5" />
                  </svg>
                  <input placeholder="Search assets" value={assetQuery} onChange={e => setAssetQuery(e.target.value)} aria-label="Search assets" />
                </div>
              </div>
              <p className="faint" style={{ fontSize: 13, marginBottom: 14 }}>
                Capability limits are disclosed per asset — an asset can be holdable yet lack a price source or
                conversion route. Anything you leave unallocated stays in USDC.
              </p>
              <div className="asset-grid">
                {filteredAssets.map(a => {
                  const selected = draft.assetIds.includes(a.id)
                  const notes = capabilityNotes(a)
                  return (
                    <button key={a.id} type="button" className={`asset-pick${selected ? ' selected' : ''}`} onClick={() => toggleAsset(a.id)} aria-pressed={selected}>
                      <TokenIcon assetId={a.id} size={30} />
                      <span className="meta">
                        <span className="sym">{a.symbol}</span>
                        <span className="nm">{a.name}</span>
                      </span>
                      <span className="cap-chips" style={{ justifyContent: 'flex-end', maxWidth: 170 }}>
                        {notes.slice(0, 2).map(n => (
                          <span key={n.label} className={`cap-chip${n.severity === 'warn' ? ' warn' : ''}`}>{n.label}</span>
                        ))}
                      </span>
                    </button>
                  )
                })}
              </div>
              {draft.assetIds.length >= MAX_ASSETS && (
                <div className="callout warn" style={{ marginTop: 14 }}>
                  A Reserve holds at most {MAX_ASSETS} Reserve Assets in the MVP.
                </div>
              )}
            </div>
          )}

          {step === 2 && (
            <div className="card card-pad">
              <div className="card-title">Target allocations</div>
              <p className="faint" style={{ fontSize: 13, marginBottom: 8 }}>
                Weights may total up to 100%. Whatever you leave unallocated is held as Unallocated USDC.
              </p>
              <div>
                {draft.assetIds.map(id => {
                  const a = assetById(id)
                  const w = draft.weights[id] ?? 0
                  return (
                    <div className="alloc-row" key={id}>
                      <span className="alloc-asset">
                        <TokenIcon assetId={id} size={26} />
                        <span style={{ minWidth: 0 }}>
                          <span style={{ fontWeight: 600, display: 'block' }}>{a.symbol}</span>
                          <span className="faint" style={{ fontSize: 12, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', display: 'block' }}>{a.name}</span>
                        </span>
                      </span>
                      <input
                        type="range"
                        className="slider alloc-slider"
                        min={0}
                        max={10000}
                        step={50}
                        value={w}
                        onChange={e => set({ weights: { ...draft.weights, [id]: Number(e.target.value) } })}
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
                            if (!Number.isNaN(v) && v >= 0 && v <= 100) set({ weights: { ...draft.weights, [id]: Math.round(v * 100) } })
                            else if (e.target.value === '') set({ weights: { ...draft.weights, [id]: 0 } })
                          }}
                          aria-label={`${a.symbol} weight percent`}
                        />
                        <span className="suffix">%</span>
                      </div>
                      <button type="button" className="remove-x" onClick={() => toggleAsset(id)} aria-label={`Remove ${a.symbol}`}>
                        ✕
                      </button>
                    </div>
                  )
                })}
              </div>

              <div className="total-bar">
                <span>
                  Allocated <b className="num">{fmtPct(totalBps / 100)}</b>
                  <span className="faint"> · Unallocated USDC </span>
                  <b className="num">{fmtPct(Math.max(0, unBps) / 100)}</b>
                </span>
                {totalBps > 10000 ? (
                  <span className="down" style={{ fontWeight: 600 }}>Over-allocated by {fmtPct((totalBps - 10000) / 100)}</span>
                ) : (
                  <span className="up" style={{ fontWeight: 600 }}>✓ valid</span>
                )}
              </div>

              {compPreview.length > 0 && (
                <div style={{ marginTop: 18 }}>
                  <CompositionBar items={compPreview} showList={false} />
                </div>
              )}
            </div>
          )}

          {step === 3 && (
            <div>
              <FeeControl label="Manager Mint Fee" bps={draft.mintBps} onChange={v => set({ mintBps: v })} />
              <FeeControl label="Manager Redemption Fee" bps={draft.redeemBps} onChange={v => set({ redeemBps: v })} />
              <FeeControl label="Manager Annualized TVL Fee" bps={draft.tvlBps} onChange={v => set({ tvlBps: v })} annualized />
              <div className="callout">
                Fees are editable later by the Reserve Manager, within 0–50%. Users always see the Manager Fee, the
                SSR.fun Fee, and the total separately before they sign.
              </div>
            </div>
          )}

          {step === 4 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
              <div className="card card-pad">
                <div className="card-title">Preview</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 8 }}>
                  <h2 className="display" style={{ fontSize: 30 }}>{draft.name || 'Unnamed Reserve'}</h2>
                  <span className="mono muted">{draft.ticker || '—'}</span>
                  <span className="badge badge-risk">new reserve</span>
                </div>
                {draft.description && <p className="muted" style={{ fontSize: 14, marginBottom: 16 }}>{draft.description}</p>}
                <CompositionBar items={compPreview} />
                <div className="stat-row" style={{ gridTemplateColumns: 'repeat(3, 1fr)', marginTop: 18 }}>
                  <div className="stat-cell">
                    <div className="k">Total Mint Fee</div>
                    <div className="v">{bpsPct(draft.mintBps + ssrFeeBps(draft.mintBps))}</div>
                    <div className="s faint">{bpsPct(draft.mintBps)} Manager + {bpsPct(ssrFeeBps(draft.mintBps))} SSR.fun</div>
                  </div>
                  <div className="stat-cell">
                    <div className="k">Total Redemption Fee</div>
                    <div className="v">{bpsPct(draft.redeemBps + ssrFeeBps(draft.redeemBps))}</div>
                    <div className="s faint">{bpsPct(draft.redeemBps)} Manager + {bpsPct(ssrFeeBps(draft.redeemBps))} SSR.fun</div>
                  </div>
                  <div className="stat-cell">
                    <div className="k">Total TVL Fee (annualized)</div>
                    <div className="v">{bpsPct(draft.tvlBps + ssrFeeBps(draft.tvlBps))}</div>
                    <div className="s faint">{bpsPct(draft.tvlBps)} Manager + {bpsPct(ssrFeeBps(draft.tvlBps))} SSR.fun</div>
                  </div>
                </div>
              </div>

              <div className="card card-pad">
                <div className="card-title">Initial in-kind seeding</div>
                <p className="faint" style={{ fontSize: 13, marginBottom: 14 }}>
                  You activate the Reserve by depositing its Reserve Assets in the target proportions. Initial Reserve
                  Tokens are minted at NAV ($1.00 per token at launch) and your wallet becomes the root Reserve Manager.
                </p>
                <div className="field" style={{ maxWidth: 260 }}>
                  <label htmlFor="c-seed">Seed value (USD)</label>
                  <div className="input-suffix">
                    <input
                      id="c-seed"
                      className="input mono"
                      inputMode="numeric"
                      value={String(draft.seedUsd)}
                      onChange={e => {
                        const v = parseInt(e.target.value.replace(/\D/g, ''), 10)
                        set({ seedUsd: Number.isNaN(v) ? 0 : Math.min(v, 100_000_000) })
                      }}
                    />
                    <span className="suffix">USD</span>
                  </div>
                </div>
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>Deposit</th>
                      <th className="r">Weight</th>
                      <th className="r">Value</th>
                      <th className="r">Est. quantity</th>
                    </tr>
                  </thead>
                  <tbody>
                    {seedRows.map(row => (
                      <tr key={row.asset.id}>
                        <td>
                          <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <TokenIcon assetId={row.asset.id} size={22} />
                            {row.asset.symbol}
                          </span>
                        </td>
                        <td className="r num">{fmtPct((draft.weights[row.asset.id] ?? 0) / 100)}</td>
                        <td className="r num">{fmtUsd(row.usd)}</td>
                        <td className="r num">{row.qty != null ? fmtQty(row.qty, 4) : <span className="warn" style={{ color: 'var(--warn)' }}>no price — quantity set manually</span>}</td>
                      </tr>
                    ))}
                    {unBps > 0 && (
                      <tr>
                        <td>
                          <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <TokenIcon assetId="usdc" size={22} />
                            Unallocated USDC
                          </span>
                        </td>
                        <td className="r num">{fmtPct(unBps / 100)}</td>
                        <td className="r num">{fmtUsd((draft.seedUsd * unBps) / 10000)}</td>
                        <td className="r num">{fmtQty((draft.seedUsd * unBps) / 10000, 2)}</td>
                      </tr>
                    )}
                  </tbody>
                </table>
                <p className="hint" style={{ marginTop: 10 }}>
                  You receive {fmtQty(draft.seedUsd, 0)} {draft.ticker || 'Reserve Tokens'} — 100% of initial supply.
                </p>
              </div>

              <div className="callout">
                <b>Before you deploy:</b> name and ticker become immutable; you become root Reserve Manager and remain
                permanently identifiable as Reserve Creator; assets can only leave through minting, redemption,
                rebalancing, or a complete wind-down. This prototype deploys nothing on-chain.
              </div>
            </div>
          )}

          <div className="wiz-foot">
            <button className="btn btn-ghost" disabled={step === 0} onClick={() => setStep(s => Math.max(0, s - 1))}>
              ← Back
            </button>
            {step < STEPS.length - 1 ? (
              <button className="btn btn-primary" disabled={!stepValid} onClick={() => setStep(s => s + 1)}>
                Continue →
              </button>
            ) : (
              <button className="btn btn-primary btn-lg" disabled={draft.seedUsd <= 0} onClick={deploy}>
                Deploy Reserve (mock)
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
