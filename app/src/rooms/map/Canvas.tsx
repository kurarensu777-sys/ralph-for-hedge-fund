import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { BaseEdge, Handle, MarkerType, Position, ReactFlow, ReactFlowProvider, useReactFlow, type Edge, type EdgeProps, type Node, type NodeProps } from '@xyflow/react'
import '@xyflow/react/dist/base.css'
import type { MapNode, MapView } from '../../../shared/map.ts'
import { Dot, Glyph } from '../../ui/kit.tsx'
import { catVar, categoryOf } from '../../ui/categories.ts'
import { layoutView, sides, type Laid } from './layout.ts'
import { pathOf, routeEdges, type Pt, type RouteIn, type Side } from './route.ts'
import { matches, useMap, type Overlays } from './store.ts'
import { runMark, stateMark, STAGE_WORD, type DashRow, type Mark } from './marks.ts'

// THE CANVAS: one React Flow surface for every view. The layout (ELK, layout.ts) runs when the
// view's structure changes, never on an overlay or a refetch that moved nothing; an overlay only
// repaints. Nodes are not dragged: the map is generated, and a hand-placed node would be a lie the
// next read undoes. Every edge is routed around the boxes (route.ts) once per layout and drawn along
// its route, so no line runs through a box it does not connect.

type Data = { n: MapNode; ov: Overlays; run: Mark | null; hit: boolean; dim: boolean; pipe: 'right' | 'down'; hot: boolean }
type N = Node<Data>

const SIDES = [['l', Position.Left], ['r', Position.Right], ['t', Position.Top], ['b', Position.Bottom]] as const
function Handles() {
  return <>{SIDES.flatMap(([k, p]) => [<Handle key={`s-${k}`} type="source" id={`s-${k}`} position={p} isConnectable={false} />, <Handle key={`t-${k}`} type="target" id={`t-${k}`} position={p} isConnectable={false} />])}</>
}

/** the other agents writing inside a node: a dot in each one's category colour (four at most, the
 *  rest counted), the names in the tooltip */
function Also({ ids }: { ids: string[] }) {
  if (!ids.length) return null
  return <span className="map-also" title={`also written by: ${ids.join(', ')}`}>{ids.slice(0, 4).map(a => <i key={a} className="map-also-d" style={catVar(categoryOf(a))} />)}{ids.length > 4 && <span className="map-more">+{ids.length - 4}</span>}</span>
}

/** the kinds whose box is one line high: their sub line is in the tooltip and the drawer, never half-drawn */
const ONE_LINE = new Set<MapNode['kind']>(['agent', 'dir'])
const tipOf = (n: MapNode, m: Mark | null) => [n.title ?? n.label, ONE_LINE.has(n.kind) && n.sub?.join(' · '), n.path, n.owner && `owner ${n.owner}`, m?.title].filter(Boolean).join('\n')

const Box = memo(function Box({ data }: NodeProps<N>) {
  const { n, ov, run, hit, dim, hot } = data
  const m = run ?? stateMark(n)
  const c = n.owner ? categoryOf(n.owner) : null
  const cls = ['map-n', `map-k-${n.kind}`, m && `map-s-${m.s}`, ov.owners && c && 'map-own', hit && 'map-hit', dim && 'map-dim', hot && 'map-hot'].filter(Boolean).join(' ')
  return <div className={cls} style={ov.owners && c ? catVar(c) : undefined} title={tipOf(n, m)}>
    <Handles />
    <div className="map-n-h">
      {m && (ov.running || m.s === 'fail' || !run) && <Dot s={m.s} title={m.title} />}
      <span className="map-n-l">{n.label}</span>
      {ov.owners && <Also ids={n.also ?? []} />}
    </div>
    {!ONE_LINE.has(n.kind) && n.sub?.map((s, k) => <div key={k} className="map-n-s">{s}</div>)}
  </div>
})

const Group = memo(function Group({ data }: NodeProps<N>) {
  const { n, ov, hit, dim } = data
  const m = stateMark(n)
  const c = n.owner ? categoryOf(n.owner) : null
  const cls = ['map-g', `map-k-${n.kind}`, !n.parent && n.kind === 'group' && 'map-top', m && `map-s-${m.s}`, ov.owners && c && 'map-own', hit && 'map-hit', dim && 'map-dim'].filter(Boolean).join(' ')
  return <div className={cls} style={ov.owners && c ? catVar(c) : undefined} title={tipOf(n, m)}>
    <Handles />
    <div className="map-g-h">
      {m && <Dot s={m.s} title={m.title} />}
      <span className="map-g-l">{n.label}</span>
      {n.kind !== 'repo' && n.sub?.[0] && <span className="map-g-s">{n.sub[0]}</span>}
    </div>
    {n.kind === 'repo' && n.sub?.[0] && <div className="map-g-s2">{n.sub[0]}</div>}
  </div>
})

const Stage = memo(function Stage({ data }: NodeProps<N>) {
  const { n, hit, dim, pipe, ov } = data
  const st = n.state ?? 'unknown'
  const c = n.owner ? categoryOf(n.owner) : null
  const cls = ['map-stage', `map-st-${st}`, pipe === 'down' && 'map-stage-row', hit && 'map-hit', dim && 'map-dim'].filter(Boolean).join(' ')
  return <div className={cls} title={[n.label, n.why, n.owner && `owner ${n.owner}`].filter(Boolean).join('\n')}>
    <Handles />
    <div className="map-stage-h"><span className="map-stage-k">{n.n}</span><span className="map-stage-l">{n.label}</span>{ov.owners && c && <Glyph id={n.owner!} size={15} />}</div>
    <div className="map-stage-w">{STAGE_WORD[st] ?? st}</div>
    {pipe === 'down'
      ? <div className="map-stage-hold">{n.holds?.join(' · ')}</div>
      : <ul className="map-stage-holds">{n.holds?.map((h, k) => <li key={k}>{h}</li>)}</ul>}
  </div>
})

const TYPES = { box: Box, group: Group, stage: Stage }

type RoutedData = { points: Pt[]; at: Pt }
/** an edge drawn along its route: square corners softened, the label on the longest run */
const Routed = memo(function Routed({ id, data, markerEnd, style, label, labelBgPadding, labelBgBorderRadius }: EdgeProps<Edge<RoutedData>>) {
  if (!data) return null
  return <BaseEdge id={id} path={pathOf(data.points)} markerEnd={markerEnd} style={style} label={label} labelX={data.at.x} labelY={data.at.y} labelBgPadding={labelBgPadding} labelBgBorderRadius={labelBgBorderRadius} />
})
const EDGE_TYPES = { routed: Routed }
const isGroup = (n: MapNode) => n.kind === 'group' || n.kind === 'repo'

export type CanvasProps = {
  view: MapView
  dash: DashRow[] | null
  dashErr: string | null
  focusId: string | null
  onOpen: (n: MapNode) => void
}

export function Canvas(p: CanvasProps) {
  return <ReactFlowProvider><Inner {...p} /></ReactFlowProvider>
}

/** what a layout depends on: ids, parents, and every word a box is sized to (label, sub lines, holds,
 *  the count of other writers); an overlay or a refetch that changed none of them is not in it */
const shapeOf = (v: MapView, pipe: string) => `${v.id}|${pipe}|${v.nodes.map(n => `${n.id}<${n.parent ?? ''}:${n.label}:${(n.sub ?? []).join('/')}:${(n.holds ?? []).join('/')}:${(n.also ?? []).length}`).join(',')}|${v.edges.filter(e => !e.overlay).map(e => e.id).join(',')}`

function Inner({ view, dash, dashErr, focusId, onOpen }: CanvasProps) {
  const rf = useReactFlow()
  const box = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  const [height, setHeight] = useState(0)
  const [laid, setLaid] = useState<{ key: string; l: Laid } | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [hover, setHover] = useState<string | null>(null)
  const { q, overlays: ov, focus } = useMap()

  useEffect(() => {
    const el = box.current
    if (!el) return
    const ro = new ResizeObserver(() => { setWidth(el.clientWidth); setHeight(el.clientHeight) })
    ro.observe(el)
    setWidth(el.clientWidth)
    setHeight(el.clientHeight)
    return () => ro.disconnect()
  }, [])
  // the pipeline stands side by side when the canvas can hold it at a readable size, else one under another
  const pipe: 'right' | 'down' = width >= 1300 ? 'right' : 'down'
  const key = shapeOf(view, pipe)
  useEffect(() => {
    if (!width) return
    let on = true
    layoutView(view, { pipe }).then(l => { if (on) { setLaid({ key, l }); setErr(null) } }, e => { if (on) setErr(String((e as Error)?.message ?? e)) })
    return () => { on = false }
  }, [key, width > 0]) // eslint-disable-line react-hooks/exhaustive-deps

  const byId = useMemo(() => new Map(view.nodes.map(n => [n.id, n])), [view])
  const hits = useMemo(() => {
    if (!q.trim()) return null
    const s = new Set(view.nodes.filter(n => matches(n, q)).map(n => n.id))
    return s
  }, [q, view])
  // a hit's groups stay lit, so the eye can find where it sits
  const lit = useMemo(() => {
    if (!hits) return null
    const s = new Set(hits)
    for (const id of hits) { let p = byId.get(id)?.parent; while (p) { s.add(p); p = byId.get(p)?.parent } }
    return s
  }, [hits, byId])

  const runOf = useCallback((n: MapNode): Mark | null => (n.kind === 'dashboard' && n.dashboard ? runMark(n.dashboard, dash, dashErr) : null), [dash, dashErr])

  // every edge's route, once per layout; a hover or an overlay reuses it
  const routeKey = view.edges.map(e => e.id).join(',')
  const routes = useMemo(() => {
    if (!laid || laid.key !== key) return null
    const ins: RouteIn[] = view.edges.map(e => {
      // the loop runs back under the chain (beside it when the stages stand one under another)
      const loopSide: Side[] | undefined = e.kind === 'loop' ? [pipe === 'right' ? 'b' : 'r'] : undefined
      return { id: e.id, source: e.source, target: e.target, from: loopSide, to: loopSide }
    })
    return routeEdges(view.nodes, laid.l, ins)
  }, [laid, key, routeKey, pipe]) // eslint-disable-line react-hooks/exhaustive-deps

  const nodes: N[] = useMemo(() => {
    if (!laid || laid.key !== key) return []
    const touching = new Set<string>()
    if (hover) for (const e of view.edges) if (e.source === hover || e.target === hover) { touching.add(e.source); touching.add(e.target) }
    return [...laid.l.nodes.values()].map(pl => {
      const n = byId.get(pl.id)!
      return {
        id: pl.id, type: n.kind === 'stage' ? 'stage' : isGroup(n) ? 'group' : 'box',
        position: { x: pl.x, y: pl.y }, ...(pl.parent ? { parentId: pl.parent } : {}),
        style: { width: pl.w, height: pl.h }, width: pl.w, height: pl.h,
        draggable: false, connectable: false, selectable: false,
        zIndex: isGroup(n) ? 0 : 1,
        data: { n, ov, run: runOf(n), hit: !!hits?.has(n.id), dim: !!lit && !lit.has(n.id), pipe, hot: hover !== pl.id && touching.has(pl.id) },
      }
    })
  }, [laid, key, byId, ov, runOf, hits, lit, pipe, hover, view.edges])

  const edges: Edge[] = useMemo(() => {
    if (!laid || laid.key !== key) return []
    const out: Edge[] = []
    for (const e of view.edges) {
      const a = laid.l.nodes.get(e.source), b = laid.l.nodes.get(e.target)
      if (!a || !b) continue
      const touched = hover === e.source || hover === e.target
      // who-writes-what edges are many: drawn only for the node under the pointer
      if (e.overlay === 'owners' && !(ov.owners && touched)) continue
      const loop = e.kind === 'loop'
      const rt = routes?.get(e.id)
      // a route the router could not find (none on the real tree: the test holds it) falls back to a
      // plain curve rather than dropping what the files say connects
      const sd = rt ? { from: rt.from, to: rt.to } : sides(a, b)
      const tone = e.kind === 'guarded' ? 'var(--faint)' : loop ? 'var(--ok-line)' : touched ? 'var(--dim)' : 'var(--line3)'
      out.push({
        id: e.id, source: e.source, target: e.target, sourceHandle: `s-${sd.from}`, targetHandle: `t-${sd.to}`,
        // a label reads on hover (the canvas stays quiet), except the loop
        type: rt ? 'routed' : 'default', ...(rt ? { data: { points: rt.points, at: rt.label } } : {}), label: loop && pipe === 'down' ? e.label?.split(':')[0] : loop || touched ? e.label : undefined,
        className: ['map-e', `map-e-${e.kind}`, touched && 'map-e-hot', lit && !(lit.has(e.source) && lit.has(e.target)) && 'map-e-dim'].filter(Boolean).join(' '),
        markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14, color: tone },
        style: { stroke: tone },
        labelBgPadding: [4, 2] as [number, number], labelBgBorderRadius: 3,
        zIndex: e.overlay ? 2 : 0,
      })
    }
    return out
  }, [laid, key, view.edges, hover, ov.owners, pipe, lit, routes])

  // fit once per layout (and when the canvas is resized), never on a repaint
  const fitted = useRef('')
  useEffect(() => {
    if (!nodes.length) return
    const k = `${key}|${Math.round(width / 50)}|${Math.round(height / 50)}`
    if (fitted.current === k) return
    fitted.current = k
    requestAnimationFrame(() => rf.fitView({ padding: 0.04, maxZoom: 1, duration: 0 }))
  }, [nodes.length, key, width, height, rf])

  // a deep link or Enter in the search: centre on the node and open its drawer
  const centre = useCallback((id: string) => {
    const pl = laid?.l.nodes.get(id)
    const n = byId.get(id)
    if (!pl || !n) return false
    rf.setCenter(pl.ax + pl.w / 2, pl.ay + pl.h / 2, { zoom: Math.max(rf.getZoom(), 0.9), duration: 300 })
    onOpen(n)
    return true
  }, [laid, byId, rf, onOpen])
  const done = useRef<string | null>(null)
  useEffect(() => {
    if (!focusId || !nodes.length || done.current === `${key}|${focusId}`) return
    done.current = `${key}|${focusId}`
    requestAnimationFrame(() => centre(focusId))
  }, [focusId, nodes.length, key, centre])
  const lastFocus = useRef(focus)
  useEffect(() => {
    if (focus === lastFocus.current) return
    lastFocus.current = focus
    const first = view.nodes.find(n => hits?.has(n.id) && !isGroup(n)) ?? view.nodes.find(n => hits?.has(n.id))
    if (first) centre(first.id)
  }, [focus, hits, view.nodes, centre])

  return <div className="map-canvas" ref={box}>
    {err ? <div className="map-err">layout failed: {err}</div> : null}
    <ReactFlow
      nodes={nodes} edges={edges} nodeTypes={TYPES} edgeTypes={EDGE_TYPES}
      nodesDraggable={false} nodesConnectable={false} elementsSelectable={false} edgesFocusable={false}
      minZoom={0.2} maxZoom={2} colorMode="dark" onlyRenderVisibleElements={false}
      onNodeClick={(_e, node) => { const n = byId.get(node.id); if (n) onOpen(n) }}
      onNodeMouseEnter={(_e, node) => setHover(node.id)} onNodeMouseLeave={() => setHover(null)}
      proOptions={{ hideAttribution: false }}
    />
  </div>
}
