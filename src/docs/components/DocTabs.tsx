import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'

export interface DocTab {
  /** URL-safe id, used as ?tab=<id> so a specific tab can be linked. */
  id: string
  label: string
  content: ReactNode
}

/**
 * Accessible tab set (WAI-ARIA tabs pattern): arrow keys move between tabs,
 * Home/End jump to the ends, the active tab is mirrored into ?tab= so a
 * link can open a document on a specific tab. Styled with the native
 * segmented control (.seg) from src/index.css per the UI baseline.
 */
export function DocTabs({ tabs, ariaLabel }: { tabs: DocTab[]; ariaLabel: string }) {
  const [active, setActive] = useState<string>(() => {
    const wanted = new URLSearchParams(window.location.search).get('tab')
    return tabs.some(t => t.id === wanted) ? (wanted as string) : tabs[0].id
  })
  const buttons = useRef<Array<HTMLButtonElement | null>>([])

  useEffect(() => {
    const url = new URL(window.location.href)
    if (active === tabs[0].id) url.searchParams.delete('tab')
    else url.searchParams.set('tab', active)
    window.history.replaceState(null, '', url)
  }, [active, tabs])

  function focusAndSelect(index: number) {
    const i = (index + tabs.length) % tabs.length
    setActive(tabs[i].id)
    buttons.current[i]?.focus()
  }

  function onKeyDown(e: KeyboardEvent<HTMLButtonElement>, index: number) {
    switch (e.key) {
      case 'ArrowRight':
        e.preventDefault()
        focusAndSelect(index + 1)
        break
      case 'ArrowLeft':
        e.preventDefault()
        focusAndSelect(index - 1)
        break
      case 'Home':
        e.preventDefault()
        focusAndSelect(0)
        break
      case 'End':
        e.preventDefault()
        focusAndSelect(tabs.length - 1)
        break
      default:
    }
  }

  return (
    <div className="doc-tabs">
      <div role="tablist" aria-label={ariaLabel} className="seg doc-tablist">
        {tabs.map((t, i) => {
          const selected = t.id === active
          return (
            <button
              key={t.id}
              ref={el => {
                buttons.current[i] = el
              }}
              type="button"
              role="tab"
              id={`tab-${t.id}`}
              aria-selected={selected}
              aria-controls={`panel-${t.id}`}
              tabIndex={selected ? 0 : -1}
              className={selected ? 'active' : undefined}
              onClick={() => setActive(t.id)}
              onKeyDown={e => onKeyDown(e, i)}
            >
              {t.label}
            </button>
          )
        })}
      </div>
      {tabs.map(t => (
        <section
          key={t.id}
          role="tabpanel"
          id={`panel-${t.id}`}
          aria-labelledby={`tab-${t.id}`}
          hidden={t.id !== active}
          tabIndex={0}
          className="doc-panel"
        >
          {t.content}
        </section>
      ))}
    </div>
  )
}
