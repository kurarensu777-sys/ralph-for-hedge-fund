import { useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from 'react'
import { IpynbRenderer } from 'react-ipynb-renderer'
import { SECTION_IDS } from '../../../shared/research.ts'
import { prepare } from './prepare.ts'
import { Empty, Load } from '../../ui/kit.tsx'
import { useApi } from '../../lib/api.ts'
import { FIG_SELECTOR, figuresIn, isFigure } from './figview.ts'
import { FigViewer } from './FigViewer.tsx'

// The right column: the notebook as its file holds it, drawn by react-ipynb-renderer (Apache-2.0,
// DOMPurify on every HTML output). Loaded lazily, so only this room pays for it. The renderer knows
// no text/markdown OUTPUT (our Conclusions and verdict tables are exactly that), so those become
// text/html here and go through the same sanitizer; the card's JSON is shown in the card column.
// A sticky S0-S7 strip jumps to each section's heading (`## S3 · ...`, the nine sections); a section
// the notebook does not head is drawn disabled, and a legacy notebook with none gets no chips. The
// strip's right end holds the column's focus button. A click on any figure opens it over the whole
// window (FigViewer.tsx), stepping through every figure of this notebook.

const secOf = (h: Element) => /^\s*(S[0-7])\b/.exec(h.textContent ?? '')?.[1] ?? null

export default function Reader({ id, code, focus }: { id: string; code: boolean; focus?: ReactNode }) {
  const q = useApi<{ id: string; nb: unknown }>(`/api/research/notebook?id=${encodeURIComponent(id)}`, ['research'])
  const nb = useMemo(() => (q.data ? prepare(q.data.nb) : null), [q.data])
  const ref = useRef<HTMLDivElement>(null)
  const [heads, setHeads] = useState<Record<string, HTMLElement>>({})
  const [open, setOpen] = useState<{ figs: Element[]; at: number } | null>(null)
  const pick = (e: MouseEvent<HTMLDivElement>) => {
    const el = (e.target as Element).closest(FIG_SELECTOR)
    if (!el || !ref.current || !isFigure(el)) return
    const figs = figuresIn(ref.current)
    const at = figs.indexOf(el)
    if (at >= 0) setOpen({ figs, at })
  }
  // the renderer paints after mount: find the headings once it has, and again if it repaints
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const scan = () => {
      const found: Record<string, HTMLElement> = {}
      for (const h of el.querySelectorAll<HTMLElement>('.rendered_html h1, .rendered_html h2')) { const s = secOf(h); if (s && !found[s]) found[s] = h }
      setHeads(prev => (Object.keys(prev).join() === Object.keys(found).join() && Object.keys(found).every(k => prev[k] === found[k]) ? prev : found))
    }
    scan()
    const mo = new MutationObserver(scan)
    mo.observe(el, { childList: true, subtree: true })
    return () => mo.disconnect()
  }, [nb])
  return <>
    <div className="research-jump">{Object.keys(heads).length > 0 && SECTION_IDS.map(s => <button key={s} className="chip sm" disabled={!heads[s]}
      title={heads[s] ? heads[s].textContent ?? s : `${s}: no heading in this notebook`} onClick={() => heads[s]?.scrollIntoView({ block: 'start' })}>{s}</button>)}
      <span className="sp" />{focus}</div>
    {open && <FigViewer figs={open.figs} at={open.at} heads={heads} close={() => setOpen(null)} />}
    <div ref={ref} className={`research-nb ${code ? '' : 'nocode'}`} onClick={pick}>
      <Load q={q} skel="doc">{() => nb && nb.cells.length
        ? <IpynbRenderer ipynb={nb} syntaxTheme="vscDarkPlus" bgTransparent language="python" />
        : <Empty title="EMPTY NOTEBOOK">This notebook has no cells.</Empty>}</Load>
    </div>
  </>
}
