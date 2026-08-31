import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { navigate, usePath } from '../lib/router'
import { avatarStyle } from '../lib/avatarStyle'
import {
  searchReserves,
  getPopularReserves,
  splitForHighlight,
  shortenAddress,
  nextActiveIndex,
  resolveEnterSelection,
  reservePath,
  type SearchableReserve,
} from '../lib/reserveSearch'
import { useAppStore } from '@/store/useAppStore'
import type { DTR } from '@/lib/types'

function toSearchable(dtr: DTR): SearchableReserve {
  return {
    id: dtr.id,
    name: dtr.name,
    ticker: dtr.ticker,
    dtrAddress: dtr.dtrAddress,
    reserveTokenMint: dtr.onChain?.reserveTokenMint,
    aum: dtr.aum,
  }
}

function SearchIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </svg>
  )
}

function Highlighted({ text, query }: { text: string; query: string }) {
  const split = splitForHighlight(text, query)
  if (!split) return <>{text}</>
  return (
    <>
      {split.before}
      <mark className="search-match">{split.match}</mark>
      {split.after}
    </>
  )
}

function SuggestionRow({
  reserve,
  query,
  active,
  addressOnlyMatch,
  optionId,
  onSelect,
}: {
  reserve: SearchableReserve
  query: string
  active: boolean
  addressOnlyMatch: boolean
  optionId: string
  onSelect: () => void
}) {
  const address = reserve.reserveTokenMint ?? reserve.dtrAddress
  return (
    <button
      type="button"
      id={optionId}
      role="option"
      aria-selected={active}
      className={`search-result${active ? ' active' : ''}`}
      onMouseDown={e => e.preventDefault()}
      onClick={onSelect}
    >
      <span className="search-result-avatar" style={avatarStyle(reserve.ticker)}>
        {reserve.ticker.slice(0, 2)}
      </span>
      <span className="search-result-info">
        <span className="search-result-name">
          {query ? <Highlighted text={reserve.name} query={query} /> : reserve.name}
        </span>
        <span className="search-result-meta">
          <span className="search-result-ticker">
            {query ? <Highlighted text={reserve.ticker} query={query} /> : reserve.ticker}
          </span>
          {address && <span className="search-result-ca">{shortenAddress(address)}</span>}
          {addressOnlyMatch && <span className="search-result-tag">Matched by contract address</span>}
        </span>
      </span>
    </button>
  )
}

export function ReserveSearch() {
  const path = usePath()
  const dtrs = useAppStore(s => s.dtrs)
  const [q, setQ] = useState('')
  const [open, setOpen] = useState(false)
  const [mobileOpen, setMobileOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(-1)
  const containerRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const searchable = useMemo(() => dtrs.map(toSearchable), [dtrs])
  const trimmedQuery = q.trim()

  const results = useMemo(
    () => (trimmedQuery ? searchReserves(searchable, trimmedQuery) : []),
    [searchable, trimmedQuery],
  )
  const popular = useMemo(() => (trimmedQuery ? [] : getPopularReserves(searchable)), [searchable, trimmedQuery])

  const items = trimmedQuery ? results.map(r => r.reserve) : popular
  const showDropdown = open && (trimmedQuery ? true : popular.length > 0)

  useEffect(() => {
    setActiveIndex(-1)
  }, [trimmedQuery])

  useEffect(() => {
    function handleDocMouseDown(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false)
        setMobileOpen(false)
      }
    }
    document.addEventListener('mousedown', handleDocMouseDown)
    return () => document.removeEventListener('mousedown', handleDocMouseDown)
  }, [])

  useEffect(() => {
    setOpen(false)
    setMobileOpen(false)
    setActiveIndex(-1)
  }, [path])

  function selectReserve(reserve: SearchableReserve) {
    navigate(reservePath(reserve.id))
    setQ('')
    setOpen(false)
    setMobileOpen(false)
    setActiveIndex(-1)
  }

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      if (!open) {
        setOpen(true)
        return
      }
      setActiveIndex(i => nextActiveIndex(i, items.length, 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      if (!open) {
        setOpen(true)
        return
      }
      setActiveIndex(i => nextActiveIndex(i, items.length, -1))
    } else if (e.key === 'Enter') {
      const chosen = resolveEnterSelection(items, activeIndex)
      if (!chosen) return
      e.preventDefault()
      selectReserve(chosen)
    } else if (e.key === 'Escape') {
      if (!open) return
      e.preventDefault()
      setOpen(false)
      setActiveIndex(-1)
      inputRef.current?.blur()
    }
  }

  return (
    <div className={`nav-search-wrap${mobileOpen ? ' nav-search-wrap--mobile-open' : ''}`} ref={containerRef}>
      <form
        className="nav-search"
        role="search"
        onSubmit={e => {
          e.preventDefault()
          const chosen = resolveEnterSelection(items, activeIndex)
          if (chosen) selectReserve(chosen)
        }}
      >
        <SearchIcon />
        <input
          ref={inputRef}
          placeholder="Search Reserves..."
          value={q}
          onChange={e => {
            setQ(e.target.value)
            setOpen(true)
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={handleKeyDown}
          aria-label="Search Reserves by name, ticker, or contract address"
          role="combobox"
          aria-expanded={showDropdown}
          aria-controls="nav-search-listbox"
          aria-autocomplete="list"
          aria-activedescendant={activeIndex >= 0 ? `nav-search-option-${activeIndex}` : undefined}
          autoComplete="off"
        />
        {mobileOpen && (
          <button
            type="button"
            className="nav-search-close"
            aria-label="Close search"
            onClick={() => {
              setMobileOpen(false)
              setOpen(false)
              setActiveIndex(-1)
            }}
          >
            ✕
          </button>
        )}
      </form>

      {showDropdown && (
        <div className="search-dropdown" id="nav-search-listbox" role="listbox" aria-label="Reserve search results">
          {trimmedQuery ? (
            results.length > 0 ? (
              results.map((r, i) => (
                <SuggestionRow
                  key={r.reserve.id}
                  reserve={r.reserve}
                  query={trimmedQuery}
                  active={i === activeIndex}
                  addressOnlyMatch={r.addressMatched && !r.nameMatched && !r.tickerMatched}
                  optionId={`nav-search-option-${i}`}
                  onSelect={() => selectReserve(r.reserve)}
                />
              ))
            ) : (
              <div className="search-empty" role="status">
                No Reserves found
              </div>
            )
          ) : (
            <>
              <div className="search-section-label">Popular Reserves</div>
              {popular.map((reserve, i) => (
                <SuggestionRow
                  key={reserve.id}
                  reserve={reserve}
                  query=""
                  active={i === activeIndex}
                  addressOnlyMatch={false}
                  optionId={`nav-search-option-${i}`}
                  onSelect={() => selectReserve(reserve)}
                />
              ))}
            </>
          )}
        </div>
      )}
    </div>
  )
}
