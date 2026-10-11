import { useCallback, useEffect, type ChangeEvent } from 'react'
import type { MapGraph, MapNode, MapViewId } from '../../../shared/map.ts'
import type { RoomDef } from '../types.ts'
import { Btn, Chip, Dot, Empty, Group, Load } from '../../ui/kit.tsx'
import { api, useApi } from '../../lib/api.ts'
import { useNav } from '../../shell/nav.tsx'
import { Canvas } from './Canvas.tsx'
import { NodeDrawer } from './Drawer.tsx'
import { askFocus, setOverlay, setQuery, targetOf, useMap, type Overlays } from './store.ts'
import type { DashRow } from './marks.ts'
import './map.css'

// ROOM: map - the fund as a graph (B-0207). Four views on one canvas, every node from a file
// (GET /api/map): Repos, System, Pipeline, Data. The link is #/map/<view>[/<node>]; a node's link opens
// its drawer. Overlays: owners (category colour, who else writes inside), running (the Dash room's
// reading).

const VIEWS: { id: MapViewId; label: string; title: string }[] = [
  { id: 'repos', label: 'Repos', title: 'every repo: its remote, branch, folders, build worktrees, and the agents whose writes cover them' },
  { id: 'system', label: 'System', title: 'what connects to what, and what runs' },
  { id: 'pipeline', label: 'Pipeline', title: 'the trading chain, front to back (app/library/law/the-atlas/pipeline.json)' },
  { id: 'data', label: 'Data', title: 'how a read gets from a source to a notebook, an agent or a dashboard, and what is kept (app/library/law/the-atlas/data-flow.json)' },
]
const OVERLAYS: { id: keyof Overlays; label: string; title: string }[] = [
  { id: 'owners', label: 'Owners', title: 'the owning agent\'s colour, the other agents writing inside, and (on hover) who writes where' },
  { id: 'running', label: 'Running', title: 'each dashboard\'s state as the Dash room reads it' },
]

const useGraph = () => useApi<MapGraph>('/api/map', ['config'])

function useView() {
  const nav = useNav()
  const t = targetOf(nav.sel.map)
  useEffect(() => { if (t.bad) nav.settle('map', t.view) }, [t.bad, t.view]) // eslint-disable-line react-hooks/exhaustive-deps
  const setView = (v: MapViewId) => { nav.openDrawer(null); nav.select('map', v) }
  return { ...t, setView }
}

/** a view's count and its worst dot: red when a node in it failed (a gone path, a stage's evidence) */
function viewReading(g: MapGraph | null, id: MapViewId) {
  const v = g?.views.find(x => x.id === id)
  if (!v) return { n: null, dot: undefined }
  const leaves = v.nodes.filter(n => n.kind !== 'group' && n.kind !== 'repo').length
  const fail = v.nodes.some(n => n.state === 'fail')
  return { n: v.error ? null : leaves, dot: v.error ? 'fail' : fail ? 'fail' : undefined }
}

function Explorer() {
  const q = useGraph()
  const { view, setView } = useView()
  const { overlays } = useMap()
  return <>
    <Group label="Views">
      {VIEWS.map(x => { const r = viewReading(q.data, x.id); return <button key={x.id} className={`row map-view ${view === x.id ? 'on' : ''}`} title={x.title} onClick={() => setView(x.id)}>
        {r.dot ? <Dot s={r.dot} title="a node in this view failed: open it to see which" /> : <span className="map-nodot" />}<span className="nm">{x.label}</span><span className="r">{r.n ?? ''}</span>
      </button> })}
    </Group>
    <Group label="Overlays">
      <div className="map-ovs">{OVERLAYS.map(o => <Chip key={o.id} sm on={overlays[o.id]} title={o.title} onClick={() => setOverlay(o.id, !overlays[o.id])}>{o.label}</Chip>)}</div>
    </Group>
    <Group label="Legend">
      <div className="map-legend">
        <span><Dot s="ok" />ok, running, live</span>
        <span><Dot s="warn" />dirty, behind, stale</span>
        <span><Dot s="fail" />failing, path gone</span>
        <span><Dot s="off" />stopped, guarded</span>
        <span><Dot s="unknown" />unknown, planned</span>
        <span><Dot s="ask" />the owner</span>
      </div>
    </Group>
    {!!q.data?.problems.length && <Group label="Problems">
      {q.data.problems.map((p, k) => <div key={k} className="row map-prob" title={`${p.path}: ${p.error}`}><Dot s="fail" /><span className="nm">{p.path}</span></div>)}
    </Group>}
  </>
}

function useDash() {
  const { overlays } = useMap()
  return useApi<{ items: DashRow[] }>(overlays.running ? '/api/dash' : null, ['dash'])
}

function Main() {
  const nav = useNav()
  const q = useGraph()
  const { view, node } = useView()
  const dash = useDash()
  const open = useCallback((n: MapNode) => {
    nav.openDrawer({ title: n.label, body: <NodeDrawer n={n} />, link: `${view}/${n.id}` })
  }, [nav, view])
  // a pasted link names a node: once it is open, the selection goes back to the view (the drawer's
  // link keeps the URL), so closing the drawer does not reopen it
  const opened = useCallback((n: MapNode) => { open(n); if (node) nav.select('map', view) }, [open, node, nav, view])
  return <Load q={q}>{g => {
    const v = g.views.find(x => x.id === view)
    if (!v) return <Empty state="failed">{`no ${view} view in the answer`}</Empty>
    if (v.error) return <Empty state="failed">{v.error}</Empty>
    if (!v.nodes.length) return <Empty>nothing to draw</Empty>
    return <div className="map-main">
      <Canvas view={v} dash={dash.data?.items ?? null} dashErr={dash.error} focusId={node} onOpen={opened} />
    </div>
  }}</Load>
}

function Head() {
  const { q } = useMap()
  const g = useGraph()
  const { toast } = useNav()
  const fresh = async () => {
    try { await api('/api/map?fresh=1'); g.reload() } catch (e: any) { toast(`map: ${e.message}`, true) }
  }
  return <>
    <input className="input sm map-search" placeholder="find: carry, fund_db, lab" value={q} title="highlights every node whose name, path or owner holds the words; Enter opens the first"
      onChange={(e: ChangeEvent<HTMLInputElement>) => setQuery(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') askFocus(); if (e.key === 'Escape') setQuery('') }} />
    <Btn sm title="read the files and git again (the map is cached for a minute)" onClick={fresh}>Refresh</Btn>
  </>
}

export const room: RoomDef = {
  id: 'map',
  label: 'Map',
  title: 'Map',
  icon: <><path d="M9 4L3 6.5v13.5l6-2.5 6 2.5 6-2.5V4l-6 2.5z" /><path d="M9 4v13.5M15 6.5V20" /></>,
  Explorer,
  Main,
  Head,
}
