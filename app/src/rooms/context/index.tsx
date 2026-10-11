import { fmtTokens, type CtxAll } from '../../../shared/context.ts'
import type { RoomDef } from '../types.ts'
import { Dot, Empty, Glyph, Group, Load, Seg } from '../../ui/kit.tsx'
import { useApi } from '../../lib/api.ts'
import { useNav, useSel } from '../../shell/nav.tsx'
import { Matrix } from './Matrix.tsx'
import { Panel } from './Panel.tsx'
import { FILTERS, type Filter } from './matrix.ts'
import './context.css'

// ROOM: context - what every agent loads at boot, by type, with the prompt viewer and the editor (B-0348).
// One column per agent, one row per file or chapter; a click on a column opens its panel. The link is
// #/context/<agent id>. Everything is read through the launch contract's own helpers (server/context/predict.ts).

/** the filter is the room's URL query (#/context?filter=shared), so a link carries it and Head and Main share it */
function useFilter(): [Filter, (f: Filter) => void] {
  const { query, setQuery } = useNav()
  const v = new URLSearchParams(query.context ?? '').get('filter')
  return [FILTERS.some(f => f.id === v) ? v as Filter : 'all', f => setQuery('context', f === 'all' ? null : `filter=${f}`)]
}

const useAll = () => useApi<CtxAll>('/api/context', ['context', 'config', 'library'])

function Explorer() {
  const q = useAll()
  const [sel, setSel] = useSel('context')
  const depts = new Map<string, CtxAll['agents']>()
  for (const a of q.data?.agents ?? []) depts.set(a.dept, [...(depts.get(a.dept) ?? []), a])
  return <>
    <Load q={q} skel="rows">{d => <>
      {[...depts.entries()].map(([dept, list]) => <Group key={dept} label={dept}>
        {list.map(a => <button key={a.id} className={`row context-arow ${sel === a.id ? 'on' : ''} ${a.mode === 'dormant' ? 'dormant' : ''}`} title={`${a.name}: ${a.error ?? `~${a.known.toLocaleString()} tokens measured`}`} onClick={() => setSel(sel === a.id ? null : a.id)}>
          <Glyph id={a.id} tone={a.mode === 'dormant' ? 'off' : undefined} /><span className="nm">{a.name}</span><span className="r">{a.error ? '?' : `${fmtTokens(a.known)}+`}</span>
        </button>)}
      </Group>)}
      {!!d.problems.length && <Group label="Problems">
        {d.problems.map((p, k) => <div key={k} className="row" title={`${p.path}: ${p.error}`}><Dot s="fail" /><span className="nm">{p.path.split('/').pop()}</span></div>)}
      </Group>}
    </>}</Load>
  </>
}

function Main() {
  const q = useAll()
  const [filter] = useFilter()
  const [sel, setSel] = useSel('context')
  return <Load q={q}>{d => {
    if (!d.agents.length) return <Empty state={d.problems.length ? 'failed' : 'empty'}>{d.problems.length ? d.problems.map(p => `${p.path}: ${p.error}`).join('; ') : 'no agents in the roster (app/agents/)'}</Empty>
    const picked = sel ? d.agents.find(a => a.id === sel) : null
    return <div className="context-main">
      <div className="context-body">
        {d.capsError && <div className="context-warn"><Dot s="unknown" />caps unknown: {d.capsError}. No cap is drawn.</div>}
        <Matrix data={d} filter={filter} sel={sel} onPick={id => setSel(sel === id ? null : id)} />
        <div className="context-key faint">
          <span>~tokens are chars / 4</span>
          <span><Dot s="ok" />within its cap</span><span><Dot s="warn" />over the writing target</span><span><Dot s="fail" />over its cap, or missing</span><span><Dot s="unknown" />? loaded, never measured</span>
          <span>· not loaded</span>
        </div>
      </div>
      {sel && (picked ? <Panel key={picked.id} id={picked.id} all={d} onClose={() => setSel(null)} /> : <aside className="context-panel"><Empty state="failed">{`no agent ${sel} on the roster`}</Empty></aside>)}
    </div>
  }}</Load>
}

function Head() {
  const [filter, setFilter] = useFilter()
  return <Seg value={filter} options={FILTERS.map(f => ({ id: f.id, label: f.label }))} onChange={setFilter} />
}

export const room: RoomDef = {
  id: 'context',
  label: 'Context',
  title: 'Context',
  icon: <><rect x="4" y="4" width="16" height="16" rx="2" /><path d="M4 10h16M10 4v16" /></>,
  Explorer,
  Main,
  Head,
}
