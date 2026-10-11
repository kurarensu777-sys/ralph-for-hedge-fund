import { useEffect, useRef, useState } from 'react'
import { clearScope, dropScope, restoreScope, takeFocus, useScope } from './scope.ts'
import './pill.css'

/** the centred command-bar pill in every room header: opens the one Palette (Ctrl K does the same).
 *  It gives way first when the header is tight, and hides once it is too narrow to read. While a
 *  room registers a scope (scope.ts: the Board), it is an input with an "in <Room>" chip that
 *  filters that room live; Enter opens the command bar with the text, Esc clears the text (the
 *  chip stays), Backspace in an empty input drops the chip, and a click on the plain pill in that
 *  room brings it back */
export function CommandPill({ onOpen }: { onOpen: (q?: string) => void }) {
  const ref = useRef<any>(null)
  const input = useRef<HTMLInputElement>(null)
  const [tight, setTight] = useState(false)
  const scope = useScope()
  useEffect(() => {
    const el = ref.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => setTight(el.getBoundingClientRect().width < 150))
    ro.observe(el)
    return () => ro.disconnect()
  }, [scope !== null])
  useEffect(() => { if (scope && takeFocus()) input.current?.focus() }, [scope !== null])
  const glass = <svg className="mh-cmd-glass" viewBox="0 0 16 16"><circle cx="7" cy="7" r="4.5" /><path d="M10.5 10.5L14 14" /></svg>
  if (scope) return (
    <div ref={ref} className={`mh-cmd scoped ${tight ? 'tight' : ''}`} aria-hidden={tight || undefined}
      onClick={() => input.current?.focus()} title={`Filters the ${scope.label} as you type; Enter opens the command bar, Esc clears the text, Backspace on empty drops the scope`}>
      {glass}
      <span className="mh-cmd-scope">in {scope.label}</span>
      <input ref={input} className="mh-cmd-in" value={scope.value} placeholder="Filter, or Enter to jump" aria-label={`Filter ${scope.label}`} tabIndex={tight ? -1 : 0}
        onChange={e => scope.set(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter') { e.preventDefault(); onOpen(scope.value) }
          else if (e.key === 'Escape') { e.preventDefault(); if (scope.value) clearScope(); else input.current?.blur() }
          else if (e.key === 'Backspace' && !scope.value) { e.preventDefault(); dropScope() }
        }} />
      <kbd>Ctrl K</kbd>
    </div>
  )
  return (
    <button ref={ref} className={`mh-cmd ${tight ? 'tight' : ''}`} onClick={() => { if (!restoreScope()) onOpen() }} title="Command bar (Ctrl K or Ctrl P)" aria-label="Command bar" aria-hidden={tight || undefined} tabIndex={tight ? -1 : 0}>
      {glass}
      <span className="mh-cmd-ph">Jump, run, ask</span>
      <kbd>Ctrl K</kbd>
    </button>
  )
}
