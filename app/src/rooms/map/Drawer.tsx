import type { MapNode } from '../../../shared/map.ts'
import { Dot, Empty } from '../../ui/kit.tsx'
import { relTime, useApi } from '../../lib/api.ts'
import { useNav } from '../../shell/nav.tsx'
import { DrawerHead, KvCards, Sec, type Chip, type KvRow } from '../drawers/index.tsx'
import { runMark, stateMark, STAGE_WORD, type DashRow } from './marks.ts'

// A node's drawer: what it is, who owns it, where it lives, its state, its checks, its books, the
// owner's open board and its last commit. A dashboard's running state is read here from the Dash
// room's own route, so the drawer stays current while it is open.

const KIND: Record<MapNode['kind'], string> = {
  group: 'group', repo: 'repo', dir: 'folder', files: 'root files', worktree: 'build worktree', remote: 'GitHub remote',
  agent: 'agent', dashboard: 'dashboard', container: 'container', external: 'outside', stage: 'pipeline stage',
}

export function NodeDrawer({ n }: { n: MapNode }) {
  const nav = useNav()
  const dash = useApi<{ items: DashRow[] }>(n.dashboard ? '/api/dash' : null, ['dash'])
  const run = n.dashboard ? runMark(n.dashboard, dash.data?.items ?? null, dash.error) : null
  const m = run ?? stateMark(n)
  const row = n.dashboard ? dash.data?.items.find(d => d.id === n.dashboard) : undefined

  const word = n.kind === 'stage' ? STAGE_WORD[n.state ?? 'unknown'] ?? n.state : m ? m.title.split('\n')[0] : null
  const chips: Chip[] = [
    { k: 'kind', v: KIND[n.kind] },
    ...(word ? [{ k: 'state', v: word, tone: (m?.s === 'ok' ? 'ok' : m?.s === 'warn' ? 'warn' : m?.s === 'fail' ? 'fail' : m?.s === 'ask' ? 'ask' : '') as Chip['tone'], title: m?.title }] : []),
    ...(n.port ? [{ k: 'port', v: `:${n.port}` }] : []),
  ]
  const what: KvRow[] = [
    ['owner', n.owner ?? <span className="faint" title="no one agent's writes cover all of it">shared</span>],
    !!n.also?.length && ['also', n.also.join(', ')],
    !!n.path && ['path', <span className="mono">{n.path}</span>],
    !!n.port && ['port', `:${n.port}`],
    !!m && ['state', <span className="map-dr-st"><Dot s={m.s} title={m.title} /><span>{m.title}</span></span>],
    !!n.sub?.length && ['summary', n.sub.join(' · ')],
  ]
  const checks = [
    ...(n.checks ?? []).map(c => ({ ...c, got: undefined as string | undefined })),
    ...(row?.checks ?? []).map(c => ({ label: c.id, state: c.status as 'ok' | 'fail' | 'unknown', detail: c.reading, got: 'measured' })),
  ]
  const declared = !!row?.checks?.length
  return <>
    <DrawerHead agent={n.owner ?? null} title={n.title ?? n.label} sub={n.path ?? KIND[n.kind]} chips={chips} />
    <KvCards cards={[{ title: 'What', rows: what }, ...(n.facts?.length ? [{ title: 'Facts', rows: n.facts.map(([k, v]): KvRow => [k, v]), wide: true }] : [])]} />
    {n.kind === 'stage' && !!n.holds?.length && <><Sec>Holds</Sec><ul className="map-dr-list">{n.holds.map(h => <li key={h}>{h}</li>)}</ul></>}
    {checks.length > 0 && <><Sec>Checks</Sec><div className="map-dr-list">
      {checks.filter(c => !(declared && c.state === 'info')).map((c, k) => <div key={k} className="map-dr-row" title={c.detail}>
        {c.state === 'info' ? <span className="map-dr-i" title="declared, not run here">-</span> : <Dot s={c.state} />}
        <span className="mono">{c.label}</span><span className="faint">{c.detail}</span>
      </div>)}
    </div></>}
    {!!n.books?.length && <><Sec>Books</Sec><div className="map-dr-list">
      {n.books.map(b => <button key={b} className="map-dr-link" title={`open ${b} in the Library`} onClick={() => { nav.openDrawer(null); nav.go('library', b) }}>{b.split('/').pop()}<span className="faint"> {b.split('/').slice(0, -1).join('/')}</span></button>)}
    </div></>}
    {!!n.law?.length && <><Sec>Law</Sec><div className="map-dr-list">{n.law.map(l => <div key={l} className="map-dr-row mono">{l}</div>)}</div></>}
    {n.board && <><Sec right={n.owner && <span className="faint">{n.owner}</span>}>Open board</Sec>{n.board.length
      ? <div className="map-dr-list">{n.board.map(b => <button key={b.id} className="map-dr-link" title={`${b.status}: ${b.title}`} onClick={() => { nav.openDrawer(null); nav.go('board', b.id) }}><span className="mono">{b.id}</span> {b.title}<span className="faint"> · {b.status}</span></button>)}</div>
      : <Empty inline sm>none open</Empty>}</>}
    {n.commit !== undefined && <><Sec>Last commit</Sec>{n.commit
      ? <div className="map-dr-row map-dr-commit" title={new Date(n.commit.ts).toISOString()}><span className="mono">{n.commit.sha}</span><span>{n.commit.subject}</span><span className="faint">{n.commit.repo} · {relTime(n.commit.ts)}</span></div>
      : <Empty inline sm>none found</Empty>}</>}
    {n.kind === 'agent' && n.owner && <div className="map-dr-go"><button className="map-dr-link" title="what it loads at boot, its prompt, brief, boot list and header" onClick={() => { nav.openDrawer(null); nav.go('context', n.owner!) }}>open in the Context room</button></div>}
    {n.dashboard && <div className="map-dr-go"><button className="map-dr-link" onClick={() => { nav.openDrawer(null); nav.go('dash', n.dashboard!) }}>open in the Dash room</button></div>}
  </>
}
