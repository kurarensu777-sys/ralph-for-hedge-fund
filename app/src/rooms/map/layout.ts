import type { ELK as Elk, ElkExtendedEdge, ElkNode } from 'elkjs/lib/elk-api'
import type { MapLayout, MapNode, MapView } from '../../../shared/map.ts'
import { groupWidth, holdLines, leafWidth, stageWidth } from './measure.ts'

// THE MAP'S LAYOUT (pure, tested in test/map.test.ts). Bottom up: each group lays out its own
// children - `right` / `down` with ELK's layered algorithm along the edges between them, `grid` /
// `stack` packed in columns - and takes the size they need; its parent then places it as one box.
// An edge between two groups' insides counts, at the level where they meet, as an edge between the
// two children of that level that hold its ends, so ELK orders the groups by what flows between
// them. The loop edge is drawn, never laid out (it runs backwards by design).

export const HEAD = 34     // a group's title band
export const REPO_HEAD = 48 // a repo's: its name, then its branch and sync
export const PAD = 12      // a group's inner margin
const GAP = 6              // between packed children
const FOLD = 8             // a stack longer than this folds into two columns
/** a side-by-side stage above what it holds: padding, its name, its word, the gap (map.css .map-stage) */
export const STAGE_TOP = 62

export type Placed = { id: string; parent: string | null; x: number; y: number; w: number; h: number; ax: number; ay: number }
export type Laid = { nodes: Map<string, Placed>; w: number; h: number }

/** the pipeline's stages stand side by side (`right`) or one under another (`down`) */
export type Opts = { pipe: 'right' | 'down' }

/** a leaf's box. Every text line has a fixed height, so the height is known before it is drawn; the
 *  width is the kind's own, or wider when the label or a sub line needs it (measure.ts), so no text
 *  is ever cut. `stageW` = the widest stage's need, so the chain's boxes stand one width */
export function sizeOf(n: MapNode, o: Opts, stageW = 0): { w: number; h: number } {
  const b = baseSize(n, o)
  if (n.kind === 'stage' && o.pipe === 'right') {
    // side by side, a stage is as wide as the widest name and what it holds wraps inside it
    const w = Math.max(b.w, stageW)
    return { w, h: STAGE_TOP + 15 * Math.max(4, holdLines(n, w)) }
  }
  return { w: Math.max(b.w, n.kind === 'stage' ? stageW : leafWidth(n)), h: b.h }
}

function baseSize(n: MapNode, o: Opts): { w: number; h: number } {
  const subs = n.sub?.length ?? 0
  const lines = (w: number) => ({ w, h: 28 + 14 * subs })
  switch (n.kind) {
    case 'dir': return { w: 118, h: 26 }
    case 'files': return lines(118)
    case 'worktree': return lines(118)
    case 'remote': return lines(150)
    case 'agent': return { w: 136, h: 26 }
    case 'dashboard': return lines(144)
    case 'container': case 'external': return lines(n.kind === 'external' ? 152 : 164)
    case 'stage': return o.pipe === 'right' ? { w: 132, h: STAGE_TOP + 15 * Math.max(4, n.holds?.length ?? 0) } : { w: 640, h: 44 }
    default: return lines(140)
  }
}

const headOf = (n: MapNode) => (n.kind === 'repo' ? REPO_HEAD : HEAD)

// ELK is a large bundle: fetched the first time a map is laid out, never with the room's chunk
let elkP: Promise<Elk> | null = null
const elk = () => (elkP ??= import('elkjs/lib/elk.bundled.js').then(m => new m.default()))

/** grid columns: the arrangement whose overall shape is nearest `aspect` (width / height) */
export function gridCols(n: number, cw: number, ch: number, aspect: number): number {
  if (n <= 1) return 1
  let best = 1, diff = Infinity
  for (let c = 1; c <= n; c++) {
    const r = Math.ceil(n / c)
    const d = Math.abs(Math.log(((c * cw) / (r * ch)) / aspect))
    if (d < diff - 1e-9) { diff = d; best = c }
  }
  return best
}

export async function layoutView(view: Pick<MapView, 'nodes' | 'edges' | 'layout'>, o: Opts): Promise<Laid> {
  const byId = new Map(view.nodes.map(n => [n.id, n]))
  const kids = new Map<string | null, MapNode[]>()
  for (const n of view.nodes) {
    const p = n.parent && byId.has(n.parent) ? n.parent : null
    kids.set(p, [...(kids.get(p) ?? []), n])
  }
  const size = new Map<string, { w: number; h: number }>()
  const rel = new Map<string, { x: number; y: number }>()
  const parentOf = (id: string) => { const p = byId.get(id)?.parent; return p && byId.has(p) ? p : null }
  /** the ancestor of `id` (itself included) whose parent is `g` */
  const under = (id: string, g: string | null): string | null => {
    let cur: string | null = id
    while (cur !== null && parentOf(cur) !== g) cur = parentOf(cur)
    return cur
  }
  const stageW = Math.max(0, ...view.nodes.filter(n => n.kind === 'stage').map(n => stageWidth(n, o.pipe)))
  const laidEdges = view.edges.filter(e => e.kind !== 'loop' && byId.has(e.source) && byId.has(e.target))

  async function place(g: string | null, how: MapLayout, parentHow: MapLayout | null, top = false): Promise<{ w: number; h: number }> {
    const cs = kids.get(g) ?? []
    for (const c of cs) {
      const nested = kids.get(c.id)
      size.set(c.id, nested?.length || c.kind === 'group' || c.kind === 'repo' ? await group(c, how) : sizeOf(c, o, stageW))
    }
    if (!cs.length) return { w: 0, h: 0 }
    if (how === 'grid' || how === 'stack' || how === 'row') {
      const cw = Math.max(...cs.map(c => size.get(c.id)!.w)), ch = Math.max(...cs.map(c => size.get(c.id)!.h))
      // a long stack folds into two columns; a grid in a top-to-bottom parent spreads wide (widest at the top level)
      const cols = how === 'row' ? cs.length : how === 'stack' ? (cs.length > FOLD ? 2 : 1) : gridCols(cs.length, cw + GAP, ch + GAP, parentHow === 'down' ? (top ? 6 : 3) : 0.9)
      // a column's height is the sum of its own children, so a stack of unlike boxes packs tight
      const colY = Array(cols).fill(0)
      cs.forEach((c, k) => {
        const col = how === 'stack' ? Math.floor(k / Math.ceil(cs.length / cols)) : k % cols
        rel.set(c.id, { x: col * (cw + GAP), y: colY[col] })
        colY[col] += size.get(c.id)!.h + GAP
      })
      return { w: (how === 'stack' && cols === 1 ? Math.max(...cs.map(c => size.get(c.id)!.w)) : cols * (cw + GAP) - GAP), h: Math.max(...colY) - GAP }
    }
    const inside = new Set(cs.map(c => c.id))
    const seen = new Set<string>()
    const edges: ElkExtendedEdge[] = []
    for (const e of laidEdges) {
      const s = under(e.source, g), t = under(e.target, g)
      if (!s || !t || s === t || !inside.has(s) || !inside.has(t)) continue
      const k = `${s}>${t}`
      if (seen.has(k)) continue
      seen.add(k)
      edges.push({ id: k, sources: [s], targets: [t] })
    }
    // a chain of stages sits tight; everything else leaves room for an edge's label
    const stages = cs.every(c => c.kind === 'stage')
    const graph: ElkNode = {
      id: g ?? 'root',
      layoutOptions: {
        'elk.algorithm': 'layered', 'elk.direction': how === 'down' ? 'DOWN' : 'RIGHT',
        'elk.spacing.nodeNode': '22', 'elk.layered.spacing.nodeNodeBetweenLayers': stages ? (how === 'down' ? '14' : '22') : '40',
        'elk.spacing.componentComponent': '28', 'elk.padding': '[top=0,left=0,bottom=0,right=0]',
        // the canvas draws its own edges: no room is reserved between layers for routed ones
        'elk.edgeRouting': 'POLYLINE',
        // the files' order decides which way a cycle breaks: Outside stays left of This machine
        'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES', 'elk.layered.cycleBreaking.strategy': 'MODEL_ORDER',
        // and a layer keeps the files' order, so the repos and their GitHub remotes run side by side
        // in the same order and the repo -> remote edges do not cross
        'elk.layered.crossingMinimization.forceNodeModelOrder': 'true',
      },
      // a layer's boxes line up on their leading edge, not their centres
      children: cs.map(c => ({ id: c.id, width: size.get(c.id)!.w, height: size.get(c.id)!.h, layoutOptions: { 'elk.alignment': how === 'down' ? 'TOP' : 'LEFT' } })),
      edges,
    }
    const out = await (await elk()).layout(graph)
    let w = 0, h = 0
    for (const c of out.children ?? []) {
      rel.set(c.id, { x: c.x ?? 0, y: c.y ?? 0 })
      w = Math.max(w, (c.x ?? 0) + (c.width ?? 0))
      h = Math.max(h, (c.y ?? 0) + (c.height ?? 0))
    }
    return { w, h }
  }

  async function group(n: MapNode, parentHow: MapLayout): Promise<{ w: number; h: number }> {
    const inner = await place(n.id, n.layout ?? 'grid', parentHow, !n.parent)
    return { w: Math.max(inner.w + 2 * PAD, 150, groupWidth(n)), h: headOf(n) + inner.h + PAD }
  }

  const root = await place(null, view.layout === 'right' && o.pipe === 'down' && view.nodes.every(n => n.kind === 'stage') ? 'down' : view.layout, null)
  const nodes = new Map<string, Placed>()
  const put = (n: MapNode) => {
    const p = parentOf(n.id)
    const r = rel.get(n.id) ?? { x: 0, y: 0 }
    const x = p ? PAD + r.x : r.x, y = p ? headOf(byId.get(p)!) + r.y : r.y
    const pp = p ? nodes.get(p)! : null
    const s = size.get(n.id)!
    nodes.set(n.id, { id: n.id, parent: p, x, y, w: s.w, h: s.h, ax: (pp?.ax ?? 0) + x, ay: (pp?.ay ?? 0) + y })
    for (const c of kids.get(n.id) ?? []) put(c)
  }
  for (const n of kids.get(null) ?? []) put(n)
  return { nodes, w: root.w, h: root.h }
}

/** which sides an edge leaves and enters by, from where its ends were placed: top and bottom when one
 *  box sits wholly above the other, else the facing sides */
export function sides(a: Placed, b: Placed): { from: 'l' | 'r' | 't' | 'b'; to: 'l' | 'r' | 't' | 'b' } {
  if (b.ay >= a.ay + a.h) return { from: 'b', to: 't' }
  if (a.ay >= b.ay + b.h) return { from: 't', to: 'b' }
  return (b.ax + b.w / 2) >= (a.ax + a.w / 2) ? { from: 'r', to: 'l' } : { from: 'l', to: 'r' }
}
