import { useMemo, useState } from 'react'
import type { Reserve } from '../domain/types'
import { navPerToken } from '../domain/types'
import { useStore } from '../state/store'
import { bpsPct, ssrFeeBps } from '../lib/fees'
import { fmtQty, fmtUsdExact } from '../lib/format'
import { Modal } from './ui'

type Side = 'buy' | 'sell'
const SLIPPAGES = [10, 50, 100] // bps
const DEX_FEE_BPS = 30
const DEX_IMPACT_BPS = 20

interface Quote {
  route: 'nav' | 'market'
  routeLabel: string
  routeDetail: string
  managerFeeUsd: number
  ssrFeeUsd: number
  managerBps: number
  ssrBps: number
  out: number // tokens (buy) or USDC (sell)
}

function quoteBuy(r: Reserve, usd: number): Quote {
  const nav = navPerToken(r)
  const mBps = r.fees.mintBps
  const sBps = ssrFeeBps(mBps)
  const managerFeeUsd = (usd * mBps) / 10000
  const ssrFeeUsd = (usd * sBps) / 10000
  const navOut = nav > 0 ? (usd - managerFeeUsd - ssrFeeUsd) / nav : 0
  const navQuote: Quote = {
    route: 'nav',
    routeLabel: 'NAV mint (primary)',
    routeDetail: 'Your USDC is converted into the Reserve Assets at target weights, then new Reserve Tokens are minted at NAV. Supply increases; existing Reserve Holders are not diluted.',
    managerFeeUsd,
    ssrFeeUsd,
    managerBps: mBps,
    ssrBps: sBps,
    out: navOut,
  }
  if (r.marketPrice != null && r.marketPrice > 0) {
    const mktOut = (usd * (1 - (DEX_FEE_BPS + DEX_IMPACT_BPS) / 10000)) / r.marketPrice
    if (mktOut > navOut) {
      return {
        route: 'market',
        routeLabel: 'External liquidity (DEX)',
        routeDetail: `Routed through an external Reserve Token pool because it currently prices below NAV. Est. DEX fee ${bpsPct(DEX_FEE_BPS)} + price impact ~${bpsPct(DEX_IMPACT_BPS)}. No new Reserve Tokens are minted and Reserve TVL does not change.`,
        managerFeeUsd: 0,
        ssrFeeUsd: 0,
        managerBps: 0,
        ssrBps: 0,
        out: mktOut,
      }
    }
  }
  return navQuote
}

function quoteSell(r: Reserve, tokens: number): Quote {
  const nav = navPerToken(r)
  const gross = tokens * nav
  const mBps = r.fees.redeemBps
  const sBps = ssrFeeBps(mBps)
  const managerFeeUsd = (gross * mBps) / 10000
  const ssrFeeUsd = (gross * sBps) / 10000
  const navQuote: Quote = {
    route: 'nav',
    routeLabel: 'NAV redemption (primary)',
    routeDetail: 'Your Reserve Tokens are burned and the proportional Reserve Assets are converted to USDC after fees. Supply decreases; backing stays proportional. This does not depend on secondary-market liquidity.',
    managerFeeUsd,
    ssrFeeUsd,
    managerBps: mBps,
    ssrBps: sBps,
    out: gross - managerFeeUsd - ssrFeeUsd,
  }
  if (r.marketPrice != null && r.marketPrice > 0) {
    const mktOut = tokens * r.marketPrice * (1 - (DEX_FEE_BPS + DEX_IMPACT_BPS) / 10000)
    if (mktOut > navQuote.out) {
      return {
        route: 'market',
        routeLabel: 'External liquidity (DEX)',
        routeDetail: `Routed through an external Reserve Token pool because it currently prices above NAV. Est. DEX fee ${bpsPct(DEX_FEE_BPS)} + price impact ~${bpsPct(DEX_IMPACT_BPS)}. Your Reserve Tokens are sold, not redeemed — supply and Reserve TVL do not change.`,
        managerFeeUsd: 0,
        ssrFeeUsd: 0,
        managerBps: 0,
        ssrBps: 0,
        out: mktOut,
      }
    }
  }
  return navQuote
}

export function TradePanel({ reserve }: { reserve: Reserve }) {
  const { dispatch, toast, holdingFor } = useStore()
  const [side, setSide] = useState<Side>('buy')
  const [amount, setAmount] = useState('')
  const [slipBps, setSlipBps] = useState(50)
  const [confirming, setConfirming] = useState(false)

  const holding = holdingFor(reserve.address)
  const nav = navPerToken(reserve)
  const amt = parseFloat(amount) || 0

  const quote = useMemo(() => {
    if (amt <= 0) return null
    return side === 'buy' ? quoteBuy(reserve, amt) : quoteSell(reserve, amt)
  }, [reserve, side, amt])

  const minReceived = quote ? quote.out * (1 - slipBps / 10000) : 0
  const disabled = reserve.status === 'winding-down'
  const insufficient = side === 'sell' && amt > (holding?.tokens ?? 0)

  function execute() {
    if (!quote || amt <= 0) return
    if (side === 'buy') {
      dispatch({ type: 'mint', address: reserve.address, usdIn: amt })
      toast(
        `Mock ${quote.route === 'nav' ? 'mint' : 'buy'} executed`,
        `${fmtQty(quote.out, 2)} ${reserve.ticker} for ${fmtUsdExact(amt)}. Prototype only — nothing was signed or sent on-chain.`,
      )
    } else {
      dispatch({ type: 'redeem', address: reserve.address, tokens: amt })
      toast(
        `Mock ${quote.route === 'nav' ? 'redemption' : 'sell'} executed`,
        `${fmtQty(amt, 2)} ${reserve.ticker} → ${fmtUsdExact(quote.out)}. Prototype only — nothing was signed or sent on-chain.`,
      )
    }
    setConfirming(false)
    setAmount('')
  }

  return (
    <div className="card card-pad trade-panel">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <div className="seg" role="tablist" aria-label="Trade side">
          <button role="tab" aria-selected={side === 'buy'} className={side === 'buy' ? 'active' : ''} onClick={() => { setSide('buy'); setAmount('') }}>
            Buy
          </button>
          <button role="tab" aria-selected={side === 'sell'} className={side === 'sell' ? 'active' : ''} onClick={() => { setSide('sell'); setAmount('') }}>
            Sell
          </button>
        </div>
        <span className="badge badge-mock">mock</span>
      </div>

      {disabled ? (
        <div className="callout danger">
          This Reserve is winding down. Minting is closed; holders claim through the wind-down process.
        </div>
      ) : (
        <>
          <div className="field" style={{ marginBottom: 12 }}>
            <label htmlFor="trade-amt">{side === 'buy' ? 'You pay (USDC)' : `You redeem (${reserve.ticker})`}</label>
            <div className="input-suffix">
              <input
                id="trade-amt"
                className="input mono"
                inputMode="decimal"
                placeholder="0.00"
                value={amount}
                onChange={e => {
                  if (/^\d*\.?\d*$/.test(e.target.value)) setAmount(e.target.value)
                }}
              />
              <span className="suffix">{side === 'buy' ? 'USDC' : reserve.ticker}</span>
            </div>
            {side === 'sell' && (
              <div className="hint" style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span>Balance: {fmtQty(holding?.tokens ?? 0, 2)} {reserve.ticker}</span>
                {holding && (
                  <button type="button" style={{ color: 'var(--accent-ink)' }} onClick={() => setAmount(String(holding.tokens))}>
                    Max
                  </button>
                )}
              </div>
            )}
          </div>

          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 12, marginBottom: 14 }}>
            <span className="faint">Slippage limit</span>
            <div className="seg seg-sm">
              {SLIPPAGES.map(s => (
                <button key={s} className={slipBps === s ? 'active' : ''} onClick={() => setSlipBps(s)}>
                  {bpsPct(s)}
                </button>
              ))}
            </div>
          </div>

          {quote && !insufficient && (
            <div className="fee-breakdown" style={{ marginBottom: 14 }}>
              <div className="row">
                <span className="muted">Route</span>
                <span>{quote.routeLabel}</span>
              </div>
              <div className="row">
                <span className="muted">NAV per Reserve Token</span>
                <span className="num">{fmtUsdExact(nav)}</span>
              </div>
              {reserve.marketPrice != null && (
                <div className="row">
                  <span className="muted">Market price</span>
                  <span className="num">{fmtUsdExact(reserve.marketPrice)}</span>
                </div>
              )}
              {quote.route === 'nav' ? (
                <>
                  <div className="row">
                    <span className="muted">Manager {side === 'buy' ? 'Mint' : 'Redemption'} Fee ({bpsPct(quote.managerBps)})</span>
                    <span className="num">{fmtUsdExact(quote.managerFeeUsd)}</span>
                  </div>
                  <div className="row">
                    <span className="muted">SSR.fun Fee ({bpsPct(quote.ssrBps)})</span>
                    <span className="num">{fmtUsdExact(quote.ssrFeeUsd)}</span>
                  </div>
                </>
              ) : (
                <div className="row">
                  <span className="muted">Est. DEX fee + impact</span>
                  <span className="num">{bpsPct(DEX_FEE_BPS + DEX_IMPACT_BPS)}</span>
                </div>
              )}
              <div className="row total">
                <span>{side === 'buy' ? `Est. ${reserve.ticker} received` : 'Est. USDC received'}</span>
                <span className="num">
                  {side === 'buy' ? fmtQty(quote.out, 3) : fmtUsdExact(quote.out)}
                </span>
              </div>
              <div className="row">
                <span className="muted">Min. after {bpsPct(slipBps)} slippage</span>
                <span className="num">{side === 'buy' ? fmtQty(minReceived, 3) : fmtUsdExact(minReceived)}</span>
              </div>
            </div>
          )}

          {insufficient && (
            <div className="callout warn" style={{ marginBottom: 14 }}>
              Amount exceeds your {reserve.ticker} balance.
            </div>
          )}

          <button
            className="btn btn-primary btn-lg btn-block"
            disabled={!quote || insufficient}
            onClick={() => setConfirming(true)}
          >
            {side === 'buy' ? `Buy ${reserve.ticker}` : `Sell ${reserve.ticker}`}
          </button>

          <p className="fee-note" style={{ marginTop: 12 }}>
            Buy and Sell route through the best available path — primary NAV mint/redemption or external Reserve Token
            liquidity. The route and all fees are shown before you confirm.
          </p>
        </>
      )}

      <Modal open={confirming} onClose={() => setConfirming(false)} labelledBy="confirm-title">
        {quote && (
          <>
            <h3 id="confirm-title">Confirm {side === 'buy' ? 'buy' : 'sell'}</h3>
            <p className="muted" style={{ fontSize: 13, marginBottom: 16 }}>
              Review the route and fees. This is a prototype — confirming simulates the transaction with mock data.
            </p>
            <div className="fee-breakdown" style={{ marginBottom: 12 }}>
              <div className="row">
                <span className="muted">Reserve</span>
                <span>{reserve.name} ({reserve.ticker})</span>
              </div>
              <div className="row">
                <span className="muted">Amount</span>
                <span className="num">{side === 'buy' ? fmtUsdExact(amt) : `${fmtQty(amt, 3)} ${reserve.ticker}`}</span>
              </div>
              <div className="row">
                <span className="muted">Route</span>
                <span>{quote.routeLabel}</span>
              </div>
              {quote.route === 'nav' && (
                <>
                  <div className="row">
                    <span className="muted">Manager Fee ({bpsPct(quote.managerBps)})</span>
                    <span className="num">{fmtUsdExact(quote.managerFeeUsd)}</span>
                  </div>
                  <div className="row">
                    <span className="muted">SSR.fun Fee ({bpsPct(quote.ssrBps)})</span>
                    <span className="num">{fmtUsdExact(quote.ssrFeeUsd)}</span>
                  </div>
                  <div className="row">
                    <span className="muted">Total Fee ({bpsPct(quote.managerBps + quote.ssrBps)})</span>
                    <span className="num">{fmtUsdExact(quote.managerFeeUsd + quote.ssrFeeUsd)}</span>
                  </div>
                  <div className="row">
                    <span className="muted">Fee recipients</span>
                    <span>Reserve Manager · SSR.fun</span>
                  </div>
                  <div className="row">
                    <span className="muted">Fee settlement asset</span>
                    <span>USDC</span>
                  </div>
                </>
              )}
              <div className="row total">
                <span>Est. net received</span>
                <span className="num">{side === 'buy' ? `${fmtQty(quote.out, 3)} ${reserve.ticker}` : fmtUsdExact(quote.out)}</span>
              </div>
              <div className="row">
                <span className="muted">Min. received ({bpsPct(slipBps)} slippage)</span>
                <span className="num">{side === 'buy' ? `${fmtQty(minReceived, 3)} ${reserve.ticker}` : fmtUsdExact(minReceived)}</span>
              </div>
            </div>
            <p className="fee-note" style={{ marginBottom: 16 }}>{quote.routeDetail}</p>
            <div style={{ display: 'flex', gap: 10 }}>
              <button className="btn btn-ghost" style={{ flex: 1 }} onClick={() => setConfirming(false)}>
                Cancel
              </button>
              <button className="btn btn-primary" style={{ flex: 1 }} onClick={execute}>
                Confirm (mock)
              </button>
            </div>
          </>
        )}
      </Modal>
    </div>
  )
}
