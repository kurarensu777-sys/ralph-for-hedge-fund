import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import { Glyph } from './kit.tsx'

// ChipSelect (kit): a filter pill "Label: value" that opens a small popover list. Neutral while on its
// default; accent-bordered with a clear x once away from it. Keyboard: Enter / Space / ArrowDown
// open, arrows + Home / End move, Enter picks, Esc closes, a letter jumps. Born in the board room;
// every room's filter chip is this one.

export type ChipOpt = {
  value: string
  label: string
  /** an agent id (or "you"): the option leads with that agent's glyph */
  glyph?: string
  title?: string
}

export function ChipSelect({ label, value, def, options, onChange, title }: {
  label: string
  value: string
  /** the default value: neutral styling, no clear x */
  def: string
  options: ChipOpt[]
  onChange: (v: string) => void
  title?: string
}) {
  const [open, setOpen] = useState(false)
  const [hi, setHi] = useState(0)
  const wrap = useRef<HTMLSpanElement>(null)
  const btn = useRef<HTMLButtonElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const id = useId()
  const cur = options.find(o => o.value === value)
  const away = value !== def
  const shown = cur?.label ?? value

  useEffect(() => {
    if (!open) return
    const off = (e: MouseEvent) => { if (!wrap.current?.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', off)
    return () => document.removeEventListener('mousedown', off)
  }, [open])
  useEffect(() => {
    if (!open) return
    list.current?.querySelector<HTMLElement>(`[data-i="${hi}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [open, hi])

  const show = () => { setHi(Math.max(0, options.findIndex(o => o.value === value))); setOpen(true) }
  const pick = (v: string) => { setOpen(false); onChange(v); btn.current?.focus() }
  const key = (e: KeyboardEvent) => {
    if (!open) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ') { e.preventDefault(); show() }
      return
    }
    const n = options.length
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setOpen(false); btn.current?.focus() }
    else if (e.key === 'ArrowDown') { e.preventDefault(); setHi(h => (h + 1) % n) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setHi(h => (h - 1 + n) % n) }
    else if (e.key === 'Home') { e.preventDefault(); setHi(0) }
    else if (e.key === 'End') { e.preventDefault(); setHi(n - 1) }
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (options[hi]) pick(options[hi].value) }
    else if (e.key === 'Tab') setOpen(false)
    else if (e.key.length === 1 && /\S/.test(e.key)) {
      const k = e.key.toLowerCase()
      const from = options.map((_, i) => (hi + 1 + i) % n)
      const j = from.find(i => options[i].label.toLowerCase().startsWith(k))
      if (j !== undefined) setHi(j)
    }
  }

  return (
    <span ref={wrap} className={`cs ${away ? 'away' : ''} ${open ? 'open' : ''}`}>
      <button ref={btn} type="button" className="cs-b" title={title ?? label} aria-haspopup="listbox" aria-expanded={open} aria-controls={id}
        onClick={() => (open ? setOpen(false) : show())} onKeyDown={key}>
        <span className="cs-l">{label}:</span>
        {away && cur?.glyph && <Glyph id={cur.glyph} size={15} />}
        <span className="cs-v">{away ? shown : 'all'}</span>
        {!away && <svg className="cs-chev" viewBox="0 0 16 16" width="9" height="9" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 6l4 4 4-4" /></svg>}
      </button>
      {away && <button type="button" className="cs-x" title={`Clear ${label}`} aria-label={`clear ${label}`} onClick={() => onChange(def)}>
        <svg viewBox="0 0 16 16" width="9" height="9" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M4 4l8 8M12 4l-8 8" /></svg>
      </button>}
      {open && <div ref={list} id={id} className="pop cs-pop" role="listbox" aria-label={label} onKeyDown={key}>
        {options.map((o, i) => (
          <div key={o.value} data-i={i} role="option" aria-selected={o.value === value} title={o.title}
            className={`pop-row cs-o ${i === hi ? 'hi' : ''} ${o.value === value ? 'sel' : ''}`}
            onMouseEnter={() => setHi(i)} onMouseDown={e => e.preventDefault()} onClick={() => pick(o.value)}>
            {o.glyph ? <Glyph id={o.glyph} size={16} /> : <span className="cs-ng" />}
            <span className="cs-ol">{o.label}</span>
            {o.value === value && <svg viewBox="0 0 16 16" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M3.5 8.5l3 3 6-7" /></svg>}
          </div>
        ))}
      </div>}
    </span>
  )
}
