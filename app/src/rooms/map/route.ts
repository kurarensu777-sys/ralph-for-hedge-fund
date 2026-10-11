import type { MapNode } from '../../../shared/map.ts'
import { HEAD, REPO_HEAD, type Laid, type Placed } from './layout.ts'
import { GROUP_CHROME, groupWidth } from './measure.ts'

// THE MAP'S EDGE ROUTER (pure, tested in test/map.test.ts). ELK places the boxes group by group, so
// an edge between two groups' insides has no route of ELK's; drawn as a curve from box to box it ran
// straight through whatever stood between (a cockpit edge across the Dashboards group). Here every edge is routed ORTHOGONALLY around the boxes: the
// candidate lines are every box's sides a clearance off, the middle of every gap between them and a
// frame round the whole map; an edge may cross the borders of the groups that hold its own ends and
// passes through nothing else, a group's title included. The cheapest path wins (A*: length, plus
// BEND px a corner). The test checks every segment of every route against every box it may not touch.

export type Side = 'l' | 'r' | 't' | 'b'
export type Pt = { x: number; y: number }
export type RouteIn = { id: string; source: string; target: string; from?: Side[]; to?: Side[] }
export type Route = { points: Pt[]; from: Side; to: Side; label: Pt }
/** a box a route must stay out of; `owner` = the node that may let a route through it (a group's
 *  title, `<id>#title`, lets none) */
export type Rect = { id: string; x0: number; y0: number; x1: number; y1: number; owner: string }
type Shaped = Pick<MapNode, 'id' | 'kind' | 'label' | 'sub' | 'state' | 'parent'>

const CLEAR = 12   // a route's distance off a box side, where the gap allows
const FRAME = 28   // the ring round the whole map a route may take
const BEND = 26    // a corner costs as much as this many px of length
const SIDES: Side[] = ['l', 'r', 't', 'b']
// headings: 0 left, 1 right, 2 up, 3 down
const STEP = [[-1, 0], [1, 0], [0, -1], [0, 1]] as const
const OUT: Record<Side, number> = { l: 0, r: 1, t: 2, b: 3 }
const INTO: Record<Side, number> = { l: 1, r: 0, t: 3, b: 2 }

/** the boxes routes stay out of: every node, and every group's title (its name and sub line) */
export function obstacles(nodes: Shaped[], l: Laid): Rect[] {
  const out: Rect[] = []
  for (const n of nodes) {
    const p = l.nodes.get(n.id)
    if (!p) continue
    out.push({ id: n.id, x0: p.ax, y0: p.ay, x1: p.ax + p.w, y1: p.ay + p.h, owner: n.id })
    if (n.kind === 'group' || n.kind === 'repo') {
      // the title's text from the frame's left edge (12px padding, 6px to spare): an edge entering
      // the group passes beside it, never through the words - it is its own owner, so even an edge
      // that may cross the group's border (one of its ends is inside) stays off it
      const tw = Math.min(p.w, groupWidth(n) - GROUP_CHROME + 18)
      out.push({ id: `${n.id}#title`, x0: p.ax, y0: p.ay, x1: p.ax + tw, y1: p.ay + (n.kind === 'repo' ? REPO_HEAD : HEAD), owner: `${n.id}#title` })
    }
  }
  return out
}

/** the groups an edge may pass through: those holding either end (it has to cross their borders) */
export function passable(e: Pick<RouteIn, 'source' | 'target'>, l: Laid): Set<string> {
  const up = (id: string) => { const o: string[] = []; let cur = l.nodes.get(id)?.parent ?? null; while (cur) { o.push(cur); cur = l.nodes.get(cur)?.parent ?? null } return o }
  return new Set([...up(e.source), ...up(e.target)])
}

/** where an edge leaves or enters a box: the middle of that side */
export function port(p: Placed, s: Side): Pt {
  return s === 'l' ? { x: p.ax, y: p.ay + p.h / 2 } : s === 'r' ? { x: p.ax + p.w, y: p.ay + p.h / 2 }
    : s === 't' ? { x: p.ax + p.w / 2, y: p.ay } : { x: p.ax + p.w / 2, y: p.ay + p.h }
}

/** a binary min-heap of (cost, state) */
class Heap {
  private k: number[] = []
  private v: number[] = []
  get size() { return this.k.length }
  push(key: number, val: number) {
    const k = this.k, v = this.v
    let i = k.length
    k.push(key); v.push(val)
    while (i > 0) { const p = (i - 1) >> 1; if (k[p] <= key) break; k[i] = k[p]; v[i] = v[p]; i = p }
    k[i] = key; v[i] = val
  }
  pop(): number {
    const k = this.k, v = this.v
    const top = v[0], lk = k.pop()!, lv = v.pop()!
    if (k.length) {
      let i = 0
      for (;;) {
        const a = 2 * i + 1, b = a + 1
        let m = i, mk = lk
        if (a < k.length && k[a] < mk) { m = a; mk = k[a] }
        if (b < k.length && k[b] < mk) { m = b; mk = k[b] }
        if (m === i) break
        k[i] = k[m]; v[i] = v[m]; i = m
      }
      k[i] = lk; v[i] = lv
    }
    return top
  }
}

const snap = (v: number) => Math.round(v * 2) / 2
const uniq = (xs: number[]) => [...new Set(xs.map(snap))].sort((a, b) => a - b)
const mids = (b: number[]) => b.slice(1).map((v, k) => (v + b[k]) / 2)
function findLast<T>(xs: T[], f: (x: T) => boolean): number {
  for (let k = xs.length - 1; k >= 0; k--) if (f(xs[k])) return k
  return -1
}

/** route every edge of a laid-out view. An edge the router cannot route is left out of the answer,
 *  so the canvas draws nothing rather than a line through a box (and the test names it) */
export function routeEdges(nodes: Shaped[], l: Laid, edges: RouteIn[]): Map<string, Route> {
  const out = new Map<string, Route>()
  const rects = obstacles(nodes, l)
  if (!rects.length || !edges.length) return out
  const placed = [...l.nodes.values()]
  const minX = Math.min(...rects.map(r => r.x0)) - FRAME, maxX = Math.max(...rects.map(r => r.x1)) + FRAME
  const minY = Math.min(...rects.map(r => r.y0)) - FRAME, maxY = Math.max(...rects.map(r => r.y1)) + FRAME
  const within = (lo: number, hi: number) => (v: number) => v >= lo && v <= hi

  // the candidate lines: box sides a clearance off, the middle of every gap, every port, the frame
  const X = uniq([minX, maxX, ...mids(uniq(rects.flatMap(r => [r.x0, r.x1]))), ...rects.flatMap(r => [r.x0 - CLEAR, r.x1 + CLEAR]), ...placed.map(p => p.ax + p.w / 2)]).filter(within(minX, maxX))
  const Y = uniq([minY, maxY, ...mids(uniq(rects.flatMap(r => [r.y0, r.y1]))), ...rects.flatMap(r => [r.y0 - CLEAR, r.y1 + CLEAR]), ...placed.map(p => p.ay + p.h / 2)]).filter(within(minY, maxY))
  const NX = X.length, NY = Y.length
  const xi = new Map(X.map((x, k) => [x, k])), yi = new Map(Y.map((y, k) => [y, k]))

  // which boxes hold each point and each unit segment, strictly inside (a route may run ON a side)
  const ownersAt = (x: number, y: number) => {
    let o: string[] | null = null
    for (const r of rects) if (x > r.x0 && x < r.x1 && y > r.y0 && y < r.y1) (o ??= []).push(r.owner)
    return o
  }
  const pt: (string[] | null)[] = new Array(NX * NY)
  const hz: (string[] | null)[] = new Array(NX * NY) // (i, j) -> (i + 1, j)
  const vt: (string[] | null)[] = new Array(NX * NY) // (i, j) -> (i, j + 1)
  for (let j = 0; j < NY; j++) for (let i = 0; i < NX; i++) {
    const k = j * NX + i
    pt[k] = ownersAt(X[i], Y[j])
    hz[k] = i + 1 < NX ? ownersAt((X[i] + X[i + 1]) / 2, Y[j]) : null
    vt[k] = j + 1 < NY ? ownersAt(X[i], (Y[j] + Y[j + 1]) / 2) : null
  }

  type Stub = { side: Side; port: Pt; at: number; len: number }
  for (const e of edges) {
    const a = l.nodes.get(e.source), b = l.nodes.get(e.target)
    if (!a || !b || e.source === e.target) continue
    const ok = passable(e, l)
    const free = (o: string[] | null) => !o || o.every(id => ok.has(id))

    // a stub: out of an allowed side of the box, to the first candidate line beyond it
    const stubs = (p: Placed, sides: Side[]): Stub[] => sides.flatMap(s => {
      const q = port(p, s)
      let i: number | undefined, j: number | undefined
      if (s === 'l' || s === 'r') { j = yi.get(snap(q.y)); i = s === 'r' ? X.findIndex(x => x > q.x + 0.25) : findLast(X, x => x < q.x - 0.25) }
      else { i = xi.get(snap(q.x)); j = s === 'b' ? Y.findIndex(y => y > q.y + 0.25) : findLast(Y, y => y < q.y - 0.25) }
      if (i === undefined || j === undefined || i < 0 || j < 0) return []
      const k = j * NX + i
      // the port sits on the stub's line (the lines are snapped to half a pixel), so the stub is square
      const at = s === 'l' || s === 'r' ? { x: q.x, y: Y[j] } : { x: X[i], y: q.y }
      if (!free(pt[k]) || !free(ownersAt((at.x + X[i]) / 2, (at.y + Y[j]) / 2))) return []
      return [{ side: s, port: at, at: k, len: Math.abs(at.x - X[i]) + Math.abs(at.y - Y[j]) }]
    })
    const ss = stubs(a, e.from ?? SIDES), ts = stubs(b, e.to ?? SIDES)
    if (!ss.length || !ts.length) continue
    const goal = new Map<number, Stub[]>()
    for (const t of ts) goal.set(t.at, [...(goal.get(t.at) ?? []), t])
    const h = (k: number) => {
      const x = X[k % NX], y = Y[Math.floor(k / NX)]
      let m = Infinity
      for (const t of ts) m = Math.min(m, Math.abs(x - X[t.at % NX]) + Math.abs(y - Y[Math.floor(t.at / NX)]) + t.len)
      return m
    }

    // A* over (point, heading), so a corner costs what it should
    const g = new Float64Array(NX * NY * 4).fill(Infinity)
    const prev = new Int32Array(NX * NY * 4).fill(-1)
    const heap = new Heap()
    ss.forEach((s, n) => {
      const st = s.at * 4 + OUT[s.side]
      if (s.len < g[st]) { g[st] = s.len; prev[st] = -2 - n; heap.push(s.len + h(s.at), st) }
    })
    let best = -1, bestCost = Infinity, bestT: Stub | null = null
    while (heap.size) {
      const st = heap.pop()
      const k = st >> 2, d = st & 3, c = g[st]
      if (c + h(k) >= bestCost) break
      for (const t of goal.get(k) ?? []) {
        const total = c + t.len + (d === INTO[t.side] ? 0 : BEND)
        if (total < bestCost) { bestCost = total; best = st; bestT = t }
      }
      const i = k % NX, j = (k - i) / NX
      for (let nd = 0; nd < 4; nd++) {
        const ni = i + STEP[nd][0], nj = j + STEP[nd][1]
        if (ni < 0 || nj < 0 || ni >= NX || nj >= NY) continue
        const nk = nj * NX + ni
        const seg = nd === 0 ? hz[nk] : nd === 1 ? hz[k] : nd === 2 ? vt[nk] : vt[k]
        if (!free(seg) || !free(pt[nk])) continue
        const nc = c + Math.abs(X[ni] - X[i]) + Math.abs(Y[nj] - Y[j]) + (nd === d ? 0 : BEND)
        const ns = nk * 4 + nd
        if (nc < g[ns]) { g[ns] = nc; prev[ns] = st; heap.push(nc + h(nk), ns) }
      }
    }
    if (best < 0 || !bestT) continue
    const pts: Pt[] = [bestT.port]
    let cur = best, first: Stub
    for (;;) {
      const k = cur >> 2
      pts.push({ x: X[k % NX], y: Y[Math.floor(k / NX)] })
      const p = prev[cur]
      if (p <= -2) { first = ss[-2 - p]; break }
      cur = p
    }
    pts.push(first.port)
    pts.reverse()
    const points = simplify(pts)
    out.set(e.id, { points, from: first.side, to: bestT.side, label: labelAt(points) })
  }
  return out
}

/** drop repeated and collinear points: a route is its corners */
export function simplify(ps: Pt[]): Pt[] {
  const out: Pt[] = []
  for (const p of ps) {
    const q = out[out.length - 1]
    if (q && q.x === p.x && q.y === p.y) continue
    const r = out[out.length - 2]
    if (q && r && ((r.x === q.x && q.x === p.x) || (r.y === q.y && q.y === p.y))) out[out.length - 1] = p
    else out.push(p)
  }
  return out
}

/** a label sits at the middle of the route's longest run */
function labelAt(ps: Pt[]): Pt {
  let best = -1, at = ps[0]
  for (let k = 1; k < ps.length; k++) {
    const len = Math.abs(ps[k].x - ps[k - 1].x) + Math.abs(ps[k].y - ps[k - 1].y)
    if (len > best) { best = len; at = { x: (ps[k].x + ps[k - 1].x) / 2, y: (ps[k].y + ps[k - 1].y) / 2 } }
  }
  return at
}

/** an SVG path through the corners, each corner rounded by up to `r` */
export function pathOf(ps: Pt[], r = 6): string {
  if (ps.length < 2) return ''
  let d = `M ${ps[0].x} ${ps[0].y}`
  for (let k = 1; k < ps.length - 1; k++) {
    const p = ps[k - 1], q = ps[k], n = ps[k + 1]
    const rr = Math.min(r, (Math.abs(q.x - p.x) + Math.abs(q.y - p.y)) / 2, (Math.abs(n.x - q.x) + Math.abs(n.y - q.y)) / 2)
    const ux = Math.sign(q.x - p.x), uy = Math.sign(q.y - p.y), vx = Math.sign(n.x - q.x), vy = Math.sign(n.y - q.y)
    d += ` L ${q.x - ux * rr} ${q.y - uy * rr} Q ${q.x} ${q.y} ${q.x + vx * rr} ${q.y + vy * rr}`
  }
  const z = ps[ps.length - 1]
  return `${d} L ${z.x} ${z.y}`
}

/** the boxes a drawn line passes through that it may not: anything but the groups holding its ends,
 *  and its own ends only along their sides (the reading the test holds every route to) */
export function crossings(line: Pt[], e: Pick<RouteIn, 'source' | 'target'>, rects: Rect[], l: Laid): string[] {
  const ok = passable(e, l)
  const hit = new Set<string>()
  for (let k = 1; k < line.length; k++) {
    const p = line[k - 1], q = line[k]
    for (const r of rects) if (!ok.has(r.owner) && cuts(p, q, r)) hit.add(r.id)
  }
  return [...hit]
}

/** whether the segment p-q passes through the inside of r (running along a side is not inside):
 *  Liang-Barsky, clipped to r shrunk by a quarter pixel */
export function cuts(p: Pt, q: Pt, r: Pick<Rect, 'x0' | 'y0' | 'x1' | 'y1'>): boolean {
  const e = 0.25, dx = q.x - p.x, dy = q.y - p.y
  let t0 = 0, t1 = 1
  const clip = (den: number, num: number) => {
    if (den === 0) return num >= 0
    const t = num / den
    if (den < 0) { if (t > t1) return false; if (t > t0) t0 = t } else { if (t < t0) return false; if (t < t1) t1 = t }
    return true
  }
  return clip(-dx, -(r.x0 + e - p.x)) && clip(dx, r.x1 - e - p.x) && clip(-dy, -(r.y0 + e - p.y)) && clip(dy, r.y1 - e - p.y) && t1 - t0 > 1e-9
}
