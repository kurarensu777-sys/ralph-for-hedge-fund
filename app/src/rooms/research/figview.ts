// THE FIGURE VIEWER's pure half (tested in test/research-figview.test.ts): which images of a notebook
// it steps through, and the fit / zoom arithmetic. The viewer itself is FigViewer.tsx.

export type View = { z: number; tx: number; ty: number }

/** the most a fitted figure is blown up: a small chart fills the screen, but not past 4x */
export const MAX_FIT = 4
export const MAX_ZOOM = 8
/** an image smaller than this on both sides is an icon or a spacer, never a figure */
export const MIN_FIG = 32

/** the scale that fits an iw x ih figure inside a vw x vh box, `padX` / `padY` px kept clear on each
 *  side (wider at the sides when the step arrows sit there) */
export function fitScale(iw: number, ih: number, vw: number, vh: number, padX = 24, padY = 24): number {
  if (!(iw > 0 && ih > 0)) return 1
  return Math.max(0.05, Math.min((vw - 2 * padX) / iw, (vh - 2 * padY) / ih, MAX_FIT))
}

/** the side margin that keeps a fitted figure clear of the step arrows */
export const ARROW_PAD = 72

/** the view that shows the figure at scale z, centred on the box's middle (tx, ty = its top-left
 *  offset from the middle) */
export function centred(iw: number, ih: number, z: number): View {
  return { z, tx: -iw * z / 2, ty: -ih * z / 2 }
}

/** zoom to nz keeping the point (px, py) - measured from the box's middle - still under the pointer */
export function zoomAt(v: View, nz: number, px: number, py: number): View {
  const k = nz / v.z
  return { z: nz, tx: px - (px - v.tx) * k, ty: py - (py - v.ty) * k }
}

/** the next zoom for one wheel notch: in on a negative delta, never below the fit, never past MAX_ZOOM */
export function wheelZoom(z: number, deltaY: number, fit: number): number {
  return Math.max(fit, Math.min(MAX_ZOOM, deltaY < 0 ? z * 1.15 : z / 1.15))
}

/** a step through n figures from i, wrapping at both ends */
export const step = (i: number, d: number, n: number) => (n ? ((i + d) % n + n) % n : 0)

/** is this element one of the notebook's figures (an image in an output or a markdown cell, or an SVG output)? */
export function isFigure(el: Element): boolean {
  if (el instanceof HTMLImageElement) {
    const w = el.naturalWidth || el.width, h = el.naturalHeight || el.height
    return w >= MIN_FIG || h >= MIN_FIG
  }
  return el.tagName.toLowerCase() === 'svg' && !!el.closest('.output_svg')
}

export const FIG_SELECTOR = 'img, .output_svg svg'

/** every figure on screen inside a rendered notebook, in reading order: one in a folded-away cell
 *  (the code cells, while Code is off) draws no box and is never stepped onto */
export function figuresIn(root: ParentNode): Element[] {
  return [...root.querySelectorAll(FIG_SELECTOR)].filter(el => isFigure(el) && el.getClientRects().length > 0)
}

/** an image URL for a figure: its own src, or an SVG output serialized */
export function srcOf(el: Element): string {
  if (el instanceof HTMLImageElement) return el.currentSrc || el.src
  const svg = el.cloneNode(true) as Element
  if (!svg.getAttribute('xmlns')) svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(new XMLSerializer().serializeToString(svg))
}

/** the section a figure sits in: the last heading (from `heads`) that comes before it in the document */
export function sectionOf(el: Element, heads: Record<string, Element>): string | null {
  let best: string | null = null
  for (const [s, h] of Object.entries(heads)) {
    if (h.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING && (!best || heads[best].compareDocumentPosition(h) & Node.DOCUMENT_POSITION_FOLLOWING)) best = s
  }
  return best
}
