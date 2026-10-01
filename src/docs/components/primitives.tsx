import { useState, type ReactNode } from 'react'

/** Highlighted note. `warn` for cautions, `good` for reassurance, default for facts. */
export function Callout({ kind, title, children }: { kind?: 'warn' | 'good'; title?: string; children: ReactNode }) {
  const cls = kind === 'warn' ? 'callout warn' : kind === 'good' ? 'callout good' : 'callout'
  return (
    <div className={`${cls} doc-callout`} role="note">
      {title && <b>{title} </b>}
      {children}
    </div>
  )
}

/** Two-column facts table: [label, value] rows. */
export function Facts({ rows, caption }: { rows: Array<[string, ReactNode]>; caption?: string }) {
  return (
    <table className="doc-table doc-facts">
      {caption && <caption>{caption}</caption>}
      <tbody>
        {rows.map(([k, v]) => (
          <tr key={k}>
            <th scope="row">{k}</th>
            <td>{v}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

/** General table with a header row. */
export function Table({ head, rows, caption }: { head: string[]; rows: ReactNode[][]; caption?: string }) {
  return (
    <div className="doc-table-wrap">
      <table className="doc-table">
        {caption && <caption>{caption}</caption>}
        <thead>
          <tr>
            {head.map(h => (
              <th key={h} scope="col">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              {r.map((c, j) => (
                <td key={j}>{c}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** An on-chain address (or any identifier) with a copy button. */
export function Addr({ value, label }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false)
  async function copy() {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1600)
    } catch {
      // Clipboard may be unavailable; the value stays selectable.
    }
  }
  return (
    <span className="doc-addr">
      <code>{value}</code>
      <button type="button" className="doc-copy" onClick={copy} aria-label={`Copy ${label ?? 'address'}`} aria-live="polite">
        {copied ? 'Copied' : 'Copy'}
      </button>
    </span>
  )
}

/** Numbered steps. Each child is one step. */
export function Steps({ children }: { children: ReactNode[] }) {
  return (
    <ol className="doc-steps">
      {children.map((c, i) => (
        <li key={i}>{c}</li>
      ))}
    </ol>
  )
}
