import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent, type WheelEvent } from 'react'
import { createPortal } from 'react-dom'
import { ARROW_PAD, centred, fitScale, sectionOf, srcOf, step, wheelZoom, zoomAt, type View } from './figview.ts'

// THE FIGURE VIEWER (the owner, 2026-09-28): a notebook figure over the whole window. Fitted first;
// 1:1 is actual pixels; the wheel zooms at the pointer, a drag pans, a click on a fitted figure goes
// 1:1; Left / Right step through every figure in the notebook; Esc, Close or a click on the backdrop
// closes. Its keys run before the shell's, so Esc here closes the viewer and nothing else.

export function FigViewer({ figs, at, heads, close }: { figs: Element[]; at: number; heads: Record<string, Element>; close: () => void }) {
  const [i, setI] = useState(at)
  const [v, setV] = useState<View | null>(null)
  const [fit, setFit] = useState(1)
  const box = useRef<HTMLDivElement>(null)
  const img = useRef<HTMLImageElement>(null)
  const pan = useRef<{ x: number; y: number } | null>(null)
  const el = figs[i]
  const src = el ? srcOf(el) : ''
  const sec = el ? sectionOf(el, heads) : null
  // the renderer's own alt ("output png") names nothing: the section's heading does
  const alt = el?.getAttribute('alt') ?? ''
  const cap = (alt && !/^output\b/i.test(alt) ? alt : null) || (sec ? heads[sec]?.textContent?.trim() : null) || 'Figure'

  const toFit = useCallback(() => {
    const im = img.current, b = box.current
    if (!im || !b || !im.naturalWidth) return
    const r = b.getBoundingClientRect()
    const f = fitScale(im.naturalWidth, im.naturalHeight, r.width, r.height, figs.length > 1 ? ARROW_PAD : 24)
    setFit(f)
    setV(centred(im.naturalWidth, im.naturalHeight, f))
  }, [figs.length])
  const actual = useCallback(() => {
    const im = img.current
    if (im?.naturalWidth) setV(centred(im.naturalWidth, im.naturalHeight, 1))
  }, [])

  useLayoutEffect(() => { setV(null) }, [src])
  useEffect(() => { const f = () => toFit(); window.addEventListener('resize', f); return () => window.removeEventListener('resize', f) }, [toFit])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const k = e.key
      if (k === 'Escape') close()
      else if (k === 'ArrowLeft') setI(n => step(n, -1, figs.length))
      else if (k === 'ArrowRight') setI(n => step(n, 1, figs.length))
      else if (k === 'f' || k === 'F') toFit()
      else if (k === '1') actual()
      else return
      e.preventDefault()
      e.stopImmediatePropagation()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [close, figs.length, toFit, actual])

  const wheel = (e: WheelEvent<HTMLDivElement>) => {
    if (!v || !box.current) return
    const r = box.current.getBoundingClientRect()
    setV(zoomAt(v, wheelZoom(v.z, e.deltaY, fit), e.clientX - r.left - r.width / 2, e.clientY - r.top - r.height / 2))
  }
  const zoomed = !!v && v.z > fit + 1e-3
  const down = (e: PointerEvent<HTMLImageElement>) => {
    if (e.button !== 0 || !v) return
    e.preventDefault()
    if (!zoomed) { actual(); return }
    pan.current = { x: e.clientX - v.tx, y: e.clientY - v.ty }
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  const move = (e: PointerEvent<HTMLImageElement>) => { const p = pan.current; if (p && v) setV({ ...v, tx: e.clientX - p.x, ty: e.clientY - p.y }) }
  const up = () => { pan.current = null }

  const pct = v ? `${Math.round(v.z * 100)}%` : ''
  return createPortal(<div className="research-fv" role="dialog" aria-modal="true" aria-label={cap}>
    <div className="research-fv-top">
      <b title={cap}>{cap}</b>
      <span className="where">{`figure ${i + 1} of ${figs.length}`}</span>
      <span className="sp" />
      <span className="where" title="the scale on screen">{v && Math.abs(v.z - fit) < 1e-3 ? `fit ${pct}` : pct}</span>
      <button className="chip sm" onClick={toFit} title="fit to the window (F)">Fit</button>
      <button className="chip sm" onClick={actual} title="actual pixels (1)">1:1</button>
      <button className="chip sm" onClick={close} title="close (Esc)">Close</button>
    </div>
    <div ref={box} className={`research-fv-box ${zoomed ? 'z' : ''}`} onWheel={wheel} onClick={e => { if (e.target === e.currentTarget) close() }}>
      <img ref={img} key={src} src={src} alt={cap} draggable={false} onLoad={toFit}
        style={v ? { transform: `translate(${v.tx}px, ${v.ty}px) scale(${v.z})` } : { visibility: 'hidden' }}
        onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} />
      {figs.length > 1 && <>
        <button className="research-fv-nav prev" onClick={() => setI(n => step(n, -1, figs.length))} title="previous figure (Left)" aria-label="previous figure">&lsaquo;</button>
        <button className="research-fv-nav next" onClick={() => setI(n => step(n, 1, figs.length))} title="next figure (Right)" aria-label="next figure">&rsaquo;</button>
      </>}
    </div>
  </div>, document.body)
}
