import { useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'

// THE DRAG EDGE: one column's right border, dragged to set that column's width (the owner, 2026-09-28).
// The caller owns the width and where it is stored; the edge only measures, clamps and reports.
// Double-click resets; the arrow keys step 16px so it works without a mouse. While a drag runs the
// body carries `edge-drag` (one cursor everywhere, no text selection, no iframe swallowing the moves).

/** a width inside [min, max]; a max below the min yields the min (the column never goes to nothing) */
export function clampWidth(w: number, min: number, max: number): number {
  return Math.round(Math.max(min, Math.min(w, max)))
}

export type EdgeProps = {
  /** the column's width now, in px (measured, so a CSS default works as the start) */
  start: () => number
  min: number
  /** the widest the column may be now, in px (usually: what its neighbour can give up) */
  max: () => number
  set: (w: number) => void
  reset: () => void
  title: string
  className?: string
}

export function Edge({ start, min, max, set, reset, title, className = '' }: EdgeProps) {
  const [tip, setTip] = useState<number | null>(null)
  const from = useRef<{ x: number; w: number } | null>(null)
  const down = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    from.current = { x: e.clientX, w: start() }
    document.body.classList.add('edge-drag')
    setTip(from.current.w)
  }
  const move = (e: PointerEvent<HTMLDivElement>) => {
    if (!from.current) return
    const w = clampWidth(from.current.w + e.clientX - from.current.x, min, max())
    setTip(w)
    set(w)
  }
  const up = () => {
    from.current = null
    document.body.classList.remove('edge-drag')
    setTip(null)
  }
  const key = (e: KeyboardEvent<HTMLDivElement>) => {
    const d = e.key === 'ArrowLeft' ? -16 : e.key === 'ArrowRight' ? 16 : 0
    if (!d) return
    e.preventDefault()
    set(clampWidth(start() + d, min, max()))
  }
  return <div className={`edge ${tip !== null ? 'drag' : ''} ${className}`} role="separator" aria-orientation="vertical" tabIndex={0}
    title={`${title}\ndrag to resize, double-click to reset`}
    onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} onLostPointerCapture={up} onDoubleClick={reset} onKeyDown={key}>
    {tip !== null && <span className="edge-w">{tip}px</span>}
  </div>
}
