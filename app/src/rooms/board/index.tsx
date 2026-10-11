import { useEffect, useMemo, useState, type DragEvent, type ReactNode } from 'react'
import type { BoardItem } from '../../../shared/types.ts'
import { api, relTime, useApi, useStored } from '../../lib/api.ts'
import { useNav, type Nav } from '../../shell/nav.tsx'
import { CardGroup, Dot, Empty, Icon, Seg, Skeleton, markOf } from '../../ui/kit.tsx'
import { modelTitle, type PermittedRead } from '../../../shared/models.ts'
import { CATEGORIES, CATEGORY_ORDER, categoryOf, isKnownAgent } from '../../ui/categories.ts'
import type { PaletteItem, RoomDef } from '../types.ts'
import { NewItemForm, openItem } from './ItemDrawer.tsx'
import { Lock } from './Lock.tsx'
import { Avatar } from './Avatar.tsx'
import { SuggestedLane } from './Suggested.tsx'
import { CeoLane, openCeo } from './ceo.tsx'
import { ChipSelect } from '../../ui/ChipSelect.tsx'
import { Choices, useRecent } from './Choices.tsx'
import { useRoomScope } from '../../shell/scope.ts'
import { ALL, AUTO, COLUMNS, KINDS, type BoardConfig, checklist, noLiveConversation, pickupReading, useMinute, convSteps, filedByAgent, isAuto, matches, patchItem, progressOf, setFilter, useFilter, type AgentLite, type Filter, type Listed } from './state.ts'
import './board.css'

// ROOM: board - the one to-do system for the owner and every agent. Items are files in
// app/board/B-NNNN.md, served by server/rooms/board.ts under /api/board/.

const useItems = () => useApi<{ items: Listed[] }>('/api/board', ['board'])
const useAgents = () => useApi<{ agents: AgentLite[] }>('/api/board/agents', ['config'])
const open = (i: BoardItem) => i.status !== 'done'

/** fundd's auto-pickup, as the server reports it (GET /api/board/auto) */
type AutoStatus = { on: boolean; manual?: boolean; model?: string | null; effort?: string | null; max: number; perDay?: number; today?: number; stopped: boolean; running: { id: string; owner: string; conversation?: string }[]; eligible: string[]; held: { id: string; reason: string }[]; last: { at: string; error: string | null; result?: { held: string | null } | null } | null }
const useAuto = () => useApi<AutoStatus>('/api/board/auto', ['board', 'system'])


// ---------- explorer: saved views ----------

type View = { key: string; label: string; set: Filter; n: number; title?: string }

function Explorer() {
  const q = useItems()
  const ag = useAgents()
  const f = useFilter()
  const au = useAuto()
  const items = q.data?.items ?? []
  const week = Date.now() - 7 * 86400_000
  const views: View[] = [
    { key: 'all', label: 'All', set: ALL, n: items.filter(open).length, title: 'Every open item' },
    { key: 'needs', label: 'Needs you', set: { ...ALL, only: 'needs-you' }, n: items.filter(i => i.status === 'needs-you').length },
    { key: 'mine', label: 'Mine', set: { ...ALL, owner: 'you' }, n: items.filter(i => open(i) && i.owner === 'you').length },
    { key: 'unassigned', label: 'Unassigned', set: { ...ALL, owner: '-' }, n: items.filter(i => open(i) && !i.owner).length },
    { key: 'agents', label: 'Filed by agents', set: { ...ALL, from: 'agents' }, n: items.filter(i => open(i) && filedByAgent(i)).length, title: 'Open items an agent filed' },
    { key: 'auto', label: 'Auto', set: { ...ALL, auto: true }, n: items.filter(i => open(i) && isAuto(i)).length, title: autoTitle(au.data, au.error) },
    { key: 'doneweek', label: 'Done this week', set: { ...ALL, only: 'done-week' }, n: items.filter(i => i.status === 'done' && Date.parse(i.updated) >= week).length },
  ]
  const same = (v: Filter) => v.owner === f.owner && v.only === f.only && v.kind === f.kind && (v.from ?? 'all') === (f.from ?? 'all') && !!v.auto === !!f.auto && !f.q
  const row = (v: View) => (
    <button key={v.key} className={`row ${same(v.set) ? 'on' : ''}`} title={v.title} onClick={() => setFilter(v.set)}>
      <span className="nm">{v.label}</span>
      {v.key === 'auto' && <AutoMark a={au.data} err={au.error} />}
      <span className="r" style={v.key === 'needs' && v.n ? { color: 'var(--ask)' } : undefined}>{q.data ? v.n : ''}</span>
    </button>
  )
  if (q.error && !q.data) return <Empty state="failed">{q.error}</Empty>
  return <>
    <div className="grp"><span>Views</span></div>
    {views.map(row)}
    <div className="grp"><span>Agents</span></div>
    {ag.error && !ag.data ? <Empty inline state="failed">{ag.error}</Empty> : !ag.data ? <Empty state="loading" skel="cg" /> : <AgentCards agents={ag.data.agents} items={items} f={f} />}
  </>
}

// ---------- explorer: the agents as card groups (the owner's option B) ----------

/** open statuses a card lists inside, in board order */
const KID_STATUS: { id: Filter['only']; label: string }[] = [
  { id: 'needs-you', label: 'Needs you' }, { id: 'ready', label: 'Ready' }, { id: 'doing', label: 'Doing' }, { id: 'review', label: 'Review' }, { id: 'backlog', label: 'Backlog' },
]

function AgentCards({ agents, items, f }: { agents: AgentLite[]; items: Listed[]; f: Filter }) {
  const ca = useApi<{ agents: AgentRowLite[] }>('/api/chats/agents', ['chat', 'config'])
  const [fold, setFold] = useStored<Record<string, boolean>>('board.fold', { dashboards: true })
  const rows = new Map((ca.data?.agents ?? []).map(a => [a.id, a]))
  const openOf = (id: string) => items.filter(i => open(i) && i.owner === id)
  const liveDot = (ids: string[]) => {
    const r = ids.map(id => rows.get(id)).filter(Boolean) as AgentRowLite[]
    if (r.some(a => a.waiting > 0)) return <Dot s="ask" title="a conversation is waiting on you" />
    if (r.some(a => a.working > 0)) return <Dot s="run" title={`${r.reduce((n, a) => n + a.working, 0)} conversation(s) working`} />
    return null
  }
  const pick = (set: Partial<Filter>) => setFilter({ ...ALL, ...set })
  const on = (owner: string, only: Filter['only'] = '') => f.owner === owner && f.only === only && f.kind === 'all' && (f.from ?? 'all') === 'all' && !f.auto && !f.q
  const toggle = (k: string, now: boolean) => setFold({ ...fold, [k]: !now })

  return <div className="cg-list board-cats">
    {CATEGORY_ORDER.map(cid => {
      const cat = CATEGORIES[cid]
      const members = agents.filter(a => categoryOf(a.id).id === cid)
      if (!members.length) return null
      const single = cid !== 'dashboards' && members.length === 1 ? members[0] : null
      const n = members.reduce((k, a) => k + openOf(a.id).length, 0)
      const dormant = single?.mode === 'dormant'
      // folded as the Chats list folds it: a dormant card starts shut (its chevron says so)
      const shut = fold[cid] ?? dormant
      const kids = single
        ? (() => {
            const mine = openOf(single.id)
            const ks = KID_STATUS.map(k => ({ ...k, n: mine.filter(i => i.status === k.id).length })).filter(k => k.n > 0)
            return ks.map(k => <button key={k.id} className={`cg-it ${on(single.id, k.id) ? 'on' : ''}`} onClick={() => pick({ owner: single.id, only: k.id })}>
              <span className={`board-kid-dot s-${k.id}`} /><span className="nm">{k.label}</span><span className="r">{k.n}</span></button>)
          })()
        : members.map(a => {
            const k = openOf(a.id).length
            return <button key={a.id} className={`cg-it ${on(a.id) ? 'on' : ''}`} title={rows.get(a.id)?.role ?? a.id} onClick={() => pick({ owner: a.id })}>
              <Avatar id={a.id} size={16} /><span className="nm">{a.name.replace(/^dash:/, '')}</span>{liveDot([a.id])}<span className="r">{k || ''}</span></button>
          })
      return (
        <CardGroup key={cid} abbr={single ? markOf(single.id) : CATEGORIES.dashboards.abbr} color={cat.color} name={single ? single.name : 'Dashboards'}
          role={dormant ? 'dormant' : undefined} dormant={dormant} closed={shut}
          title={single ? `${single.id}: ${rows.get(single.id)?.role ?? single.dept} (click: its open items)` : 'Fold / unfold the dashboards'}
          on={!!single && on(single.id)} onPick={single ? () => pick({ owner: single.id }) : undefined} onToggle={() => toggle(cid, shut)}
          live={liveDot(members.map(a => a.id))} right={<span className="board-cat-n" title={`${n} open`}>{n || ''}</span>}>
          {(!single || n > 0) && kids}
        </CardGroup>
      )
    })}
  </div>
}

function autoTitle(a: AutoStatus | null, err: string | null): string {
  if (err && !a) return `Auto-pickup status unknown: ${err}`
  if (!a) return 'Auto-pickup'
  const lines = [
    `Ready items owned by an agent and labelled auto are started by fundd (at most ${a.max} at once).`,
    !a.on ? 'Auto-pickup is OFF in this fundd (FUND_BOARD_AUTO=0).' : a.manual ? 'Manual: the board switch holds every pickup.' : a.stopped ? 'Held: floor/STOP exists.' : `Running ${a.running.length} of ${a.max}.`,
    ...a.running.map(r => `  ${r.id} ${r.owner} ${r.conversation ?? ''}`),
    ...a.held.map(h => `  ${h.id} held: ${h.reason}`),
  ]
  if (a.last?.error) lines.push(`Last tick failed: ${a.last.error}`)
  return lines.join('\n')
}

/** beside the Auto view only when pickup is not simply on: a dot for off / held / unknown (running/max is the row's tooltip) */
function AutoMark({ a, err }: { a: AutoStatus | null; err: string | null }) {
  if (err && !a) return <span className="board-am"><Dot s="unknown" title="auto-pickup status unknown" /></span>
  if (!a) return null
  if (!a.on) return <span className="board-am"><Dot s="off" title="auto-pickup off" /></span>
  if (a.manual) return <span className="board-am"><Dot s="off" title="manual: the board switch holds every pickup" /></span>
  if (a.stopped) return <span className="board-am"><Dot s="fail" title="held: floor/STOP" /></span>
  if (a.running.length) return <span className="board-am"><Dot s="run" title={`running ${a.running.length} of ${a.max}`} /></span>
  return null
}

// ---------- head: filters + new ----------

function Head() {
  const f = useFilter()
  const ag = useAgents()
  const nav = useNav()
  const agents = ag.data?.agents ?? []
  const newItem = () => nav.openDrawer({
    title: 'New item',
    body: <NewItemForm onDone={id => { nav.toast(`${id} filed`); openItem(nav, id) }} />,
  })
  return <>
    <ChipSelect label="Owner" title="Owner" value={f.owner} def="all" onChange={v => setFilter({ owner: v })}
      options={[{ value: 'all', label: 'all' }, { value: 'you', label: 'you', glyph: 'you' }, { value: '-', label: 'unassigned' },
        ...agents.map(a => ({ value: a.id, label: a.id, glyph: a.id }))]} />
    <ChipSelect label="Filed by" title="Filed by" value={f.from ?? 'all'} def="all" onChange={v => setFilter({ from: v })}
      options={[{ value: 'all', label: 'all' }, { value: 'you', label: 'you', glyph: 'you' }, { value: 'agents', label: 'agents', title: 'filed by any agent' },
        ...agents.map(a => ({ value: a.id, label: a.id, glyph: a.id }))]} />
    <ChipSelect label="Kind" title="Kind" value={f.kind} def="all" onChange={v => setFilter({ kind: v as Filter['kind'] })}
      options={[{ value: 'all', label: 'all' }, ...KINDS.map(k => ({ value: k, label: k }))]} />
    <Brain />
    <PickupsToday />
    <button className="btn primary" onClick={newItem} title="File a new item">+ New</button>
  </>
}

/** the owner's switches: Auto / Manual pickup, and the model + effort every conversation the board starts boots on */
function Brain() {
  const cq = useApi<BoardConfig>('/api/board/config', ['board', 'config'])
  const mq = useApi<PermittedRead>('/api/chats/models', ['config'])
  const nav = useNav()
  const [busy, setBusy] = useState(false)
  const cfg = cq.data
  const models = mq.data?.models ?? []
  const set = async (patch: Partial<BoardConfig>, said: string) => {
    if (busy) return
    setBusy(true)
    try { await api('/api/board/config', { body: patch }); cq.reload(); nav.toast(`board: ${said}`) }
    catch (e: any) { nav.toast(`board: ${e.message}`, true) } finally { setBusy(false) }
  }
  if (cq.error && !cfg) return <Dot s="unknown" title={`board setting unreadable: ${cq.error}`} />
  if (!cfg) return null
  const efforts = (cfg.model ? models.find(m => m.id === cfg.model)?.efforts : undefined) ?? ['low', 'medium', 'high', 'xhigh', 'max']
  const listNote = mq.error ? `\nThe model list is unreadable: ${mq.error}` : mq.data?.error ? `\nLast read failed: ${mq.data.error}` : ''
  return <>
    <span className={`board-mode ${busy ? 'busy' : ''}`} title={`Auto: fundd starts ready items labelled auto with their owner (at most ${cfg.max} at once, never while floor/STOP exists).\nManual: nothing is picked up; Start an item from its drawer.${cfg.source ? '' : '\nNo app/board/config.json yet: defaults'}`}>
      <Seg value={cfg.auto ? 'auto' : 'manual'} onChange={m => { if ((m === 'auto') !== cfg.auto) void set({ auto: m === 'auto' }, m) }}
        options={[{ id: 'auto', label: 'Auto' }, { id: 'manual', label: 'Manual' }]} />
    </span>
    <span className={`board-brain ${busy ? 'busy' : ''}`}>
      <select className="bare" aria-label="Board model" value={cfg.model ?? ''} disabled={busy}
        title={`Model for every conversation the board starts (auto-pickup and Start): ${cfg.model ? modelTitle(models, cfg.model) : "the owner agent's own"}${listNote}`}
        onChange={e => void set({ model: e.target.value || null }, `model ${e.target.value || 'agent'}`)}>
        <option value="" title="the owner agent's own model">agent</option>
        {[...(cfg.model && !models.some(m => m.id === cfg.model) ? [cfg.model] : []), ...models.map(m => m.id)]
          .map(id => <option key={id} value={id} title={modelTitle(models, id)}>{short(id)}</option>)}
      </select>
      {efforts.length > 0 && <select className="bare" aria-label="Board effort" value={cfg.effort ?? ''} disabled={busy}
        title={`Effort for board conversations: ${cfg.effort ?? "the owner agent's own"}`}
        onChange={e => void set({ effort: e.target.value || null }, `effort ${e.target.value || 'agent'}`)}>
        <option value="" title="the owner agent's own effort">agent</option>
        {efforts.map(x => <option key={x} value={x}>{x}</option>)}
      </select>}
    </span>
  </>
}

/** the day's pickups against the cap, and why the last tick held (three honest states: a count, unknown, failed) */
function PickupsToday() {
  const au = useAuto()
  if (au.error && !au.data) return <Dot s="unknown" title={`pickup count unreadable: ${au.error}`} />
  if (!au.data) return null
  const r = pickupReading(au.data)
  if (r.state === 'unknown') return <span className="board-day" title="the day's pickup count is not in this fundd's answer yet"><Dot s="unknown" /> pickups</span>
  return <span className={`board-day ${r.full ? 'full' : ''}`}
    title={`${r.today} pickups started today (UTC) of ${r.perDay} allowed (perDay in app/board/config.json).${r.held ? ` Held: ${r.held}.` : ' Not held.'}`}>
    {r.today}/{r.perDay} today{r.held && <span className="board-day-held"> · {r.held}</span>}
  </span>
}

/** a model id without its family prefix, for a tight head (the full id is the option's title) */
const short = (id: string) => id.replace(/^claude-/, '')

// ---------- main: the kanban ----------

const setQ = (q: string) => setFilter({ q })
const clearQ = () => setFilter({ q: '' })

function Main() {
  const q = useItems()
  const f = useFilter()
  const nav = useNav()
  const [doneOpen, setDoneOpen] = useStored('board.doneOpen', false)
  const [moved, setMoved] = useState<Record<string, BoardItem['status']>>({})
  const [over, setOver] = useState<string | null>(null)
  const [quick, setQuick] = useState('')
  const [unfold, setUnfold] = useState<Partial<Record<BoardItem['status'], boolean>>>({})
  // the text filter lives in the shell's command pill ("in Board") and never outlives the room
  useEffect(() => { if (f.q) setFilter({ q: '' }) }, []) // eslint-disable-line
  useRoomScope('board', 'Board', f.q, setQ, clearQ)

  // a selection from elsewhere: an item id opens its drawer, "view:x" sets the filter
  const sel = nav.sel.board ?? null
  useEffect(() => {
    if (!sel) return
    if (sel.startsWith('view:')) setFilter({ ...ALL, only: sel.slice(5) as Filter['only'] })
    else if (sel.startsWith('ceo:')) openCeo(nav, sel.slice(4))
    else if (sel === 'new') nav.openDrawer({ title: 'New item', body: <NewItemForm onDone={id => { nav.toast(`${id} filed`); openItem(nav, id) }} /> })
    else openItem(nav, sel)
    nav.select('board', null)
  }, [sel]) // eslint-disable-line

  useEffect(() => { setMoved({}) }, [q.data])

  // live dot: the item's conversation is working or waiting (the chats list), or auto-pickup is running it
  const chats = useChats()
  const au = useAuto()
  const rec = useRecent()
  const minute = useMinute()
  const liveOf = (i: Listed): ChatLite['state'] | null => {
    const c = i.conversation ? chats.data?.conversations.find(x => x.id === i.conversation) : undefined
    if (c && (c.state === 'live' || c.state === 'waiting')) return c.state
    return au.data?.running.some(r => r.id === i.id) ? 'live' : null
  }

  const items = useMemo(() => (q.data?.items ?? []).map(i => (moved[i.id] ? { ...i, status: moved[i.id] } : i)).filter(i => matches(i, f)), [q.data, moved, f])

  const drop = async (e: DragEvent, status: BoardItem['status']) => {
    e.preventDefault()
    setOver(null)
    const id = e.dataTransfer.getData('text/board')
    const it = q.data?.items.find(i => i.id === id)
    if (!it || (moved[id] ?? it.status) === status) return
    setMoved(m => ({ ...m, [id]: status }))
    try { await patchItem(id, { status }) } catch (err: any) {
      setMoved(m => { const n = { ...m }; delete n[id]; return n })
      nav.toast(`${id}: ${err.message}`, true)
    }
  }
  const addQuick = async () => {
    const title = quick.trim()
    if (!title) return
    try { await api('/api/board', { body: { title, status: 'backlog', from: 'you' } }); setQuick('') } catch (e: any) { nav.toast(e.message, true) }
  }

  if (q.error && !q.data) return <Empty state="failed">{q.error}</Empty>
  if (!q.data) return <div className="board-kb">{COLUMNS.slice(0, 4).map(c => <section key={c.id} className="lane board-col"><header className="lane-h cap">{c.label}</header><Skeleton kind="cards" n={3} /></section>)}</div>

  const showDone = doneOpen || f.only === 'done-week'
  // a text filter that matches nothing: every lane folds into the strip (keeping its 0 count) and
  // one dim line says so, instead of an empty Backlog that reads like an empty board
  const text = f.q.trim()
  const noMatch = !!text && items.length === 0
  // a card the owner just chose on stays in Needs you while its undo runs (10 s), then moves on
  const laneOf = (i: Listed) => (rec.some(r => r.id === i.id) ? 'needs-you' : i.status)
  const lanes = COLUMNS.map(c => {
    const col = items.filter(i => laneOf(i) === c.id)
    // Done folds on request; any other empty lane (Backlog keeps its + Add) folds into the summary strip
    const empty = col.length === 0 && c.id !== 'done' && c.id !== 'backlog'
    const folded = noMatch || (c.id === 'done' ? !showDone : empty && !unfold[c.id])
    return { c, col, folded }
  })
  const dragProps = (id: BoardItem['status']) => ({
    onDragOver: (e: DragEvent) => { if (e.dataTransfer.types.includes('text/board')) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; if (over !== id) setOver(id) } },
    onDragLeave: (e: DragEvent) => { if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) setOver(null) },
    onDrop: (e: DragEvent) => drop(e, id),
  })
  const unfoldLane = (id: BoardItem['status']) => id === 'done' ? setDoneOpen(true) : setUnfold(u => ({ ...u, [id]: true }))
  const foldLane = (id: BoardItem['status']) => id === 'done' ? setDoneOpen(false) : setUnfold(u => { const n = { ...u }; delete n[id]; return n })
  const shut = lanes.filter(l => l.folded)
  return (
    <div className="board-kb">
      <SuggestedLane />
      <CeoLane />
      {noMatch && <div className="board-nomatch" role="status">
        <span>no cards match <b>"{text}"</b></span><span><kbd>Esc</kbd> clears</span>
      </div>}
      {lanes.filter(l => !l.folded).map(({ c, col }) => {
        const canFold = (c.id === 'done' && f.only !== 'done-week') || (col.length === 0 && !!unfold[c.id])
        return (
          <section key={c.id} className={`lane board-col st-${c.id} ${c.id === 'needs-you' && col.length > 0 ? 'ask' : ''} ${over === c.id ? 'over' : ''}`} {...dragProps(c.id)}>
            <header className="lane-h cap board-col-h" title={c.title}>
              <span className="t">{c.label}</span><span className="lane-n">{col.length}</span>
              {canFold && <button className="lnk dim board-link" title="Fold into the strip" onClick={() => foldLane(c.id)}>hide</button>}
            </header>
            {c.id === 'backlog' && (
              <input className="input board-quick" placeholder="+ Add" value={quick} title="Enter to file into Backlog"
                onChange={e => setQuick(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') addQuick(); if (e.key === 'Escape') setQuick('') }} />
            )}
            <div className="lane-b board-cards">
              {col.map(i => <Card key={i.id} i={i} onOpen={() => openItem(nav, i.id)} live={liveOf(i)} noLive={noLiveConversation(i, chats.data?.conversations ?? null, minute)} />)}
            </div>
          </section>
        )
      })}
      {shut.length > 0 && <aside className="fold" aria-label="Folded lanes">
        {shut.map(({ c, col }) => (
          <button key={c.id} className={`fold-c st-${c.id} ${over === c.id ? 'over' : ''} ${col.length ? '' : 'zero'}`} {...dragProps(c.id)}
            title={`${c.title}: ${col.length} (click to unfold${col.length ? '' : ', or drop a card here'})`} onClick={() => unfoldLane(c.id)}>
            <span className="fold-n">{col.length}</span>
            <span className="fold-l">{c.label}</span>
          </button>
        ))}
      </aside>}
    </div>
  )
}

/** a title up to its first clause break (" - ", "; ", " (") */
const firstClause = (t: string) => t.split(/ - |; | \(/)[0].trim() || t
/** break opportunities inside a path-like token (after / . _ when more of the token follows), so a
 *  narrow card wraps `.claude/settings.json` at `settings.` rather than mid-word at `jso|n` */
export function softBreaks(t: string): ReactNode[] {
  const parts = t.split(/(?<=[\/._](?=[A-Za-z0-9]))/)
  return parts.flatMap((x, i) => (i ? [<wbr key={i} />, x] : [x]))
}

/** "platform: launchers point..." on a card the platform badge already owns -> "launchers point..." */
export function dropOwnerPrefix(t: string, owner: string): string {
  const m = /^([a-z0-9_.-]+(?::[a-z0-9_.-]+)?):\s+/i.exec(t)
  if (!m || !owner) return t
  const p = m[1].toLowerCase()
  const same = p === owner.toLowerCase() || (owner === 'you' && (p === 'owner' || p === 'you'))
  const rest = t.slice(m[0].length)
  return same && rest ? rest : t
}

type ChatLite = { id: string; agent: string; state: 'live' | 'waiting' | 'idle' | 'closed' }
type AgentRowLite = { id: string; name: string; role: string; kind: string; mode: string; working: number; waiting: number }
/** every conversation's live state, one fetch for the whole board (refreshed on the chat topic) */
const useChats = () => useApi<{ conversations: ChatLite[] }>('/api/chats?limit=1000', ['chat'])

const PRIORITY_WORD: Record<Listed['priority'], string> = { p0: 'p0 urgent', p1: 'p1 high', p2: 'p2 normal' }
/** everything the card no longer prints as a chip: id, priority, owner, filer, age, auto, labels, blockers, steps */
function cardTitle(i: Listed, blocked: string[], prog: ReturnType<typeof progressOf>): string {
  const extra = i.labels.filter(l => l !== AUTO)
  return [
    `${i.id} ${i.title}`,
    `${i.kind} · ${PRIORITY_WORD[i.priority] ?? i.priority} · ${i.owner || 'unassigned'} · filed by ${i.from || 'you'} · opened ${relTime(i.created)}`,
    isAuto(i) ? 'auto: fundd starts it when ready' : '',
    extra.length ? `labels: ${extra.join(', ')}` : '',
    blocked.length ? `blocked by ${blocked.join(', ')}` : '',
    prog ? `${prog.done}/${prog.total} ${prog.src === 'steps' ? 'steps' : 'done'}` : '',
  ].filter(Boolean).join('\n')
}

function Card({ i, onOpen, live, noLive }: { i: Listed; onOpen: () => void; live: ChatLite['state'] | null; noLive: boolean | null }) {
  const nav = useNav()
  const recentOne = useRecent().some(r => r.id === i.id)
  const blocked = i.blocked ?? []
  // the owner conversation's own steps (its last todo list); only fetched while the item is open
  const conv = useApi<{ entries: { action?: { type?: string; todos?: { status: string }[] } }[] }>(i.conversation && i.status !== 'done' ? `/api/chats/${i.conversation}` : null, ['chat'])
  const prog = progressOf(convSteps(conv.data?.entries), checklist(i.body))
  // the owner's category is the card's top edge; an owner no category claims (you, unassigned,
  // an unknown id) takes the neutral execution grey, never no edge
  const color = i.owner && isKnownAgent(i.owner) ? `var(--c-${categoryOf(i.owner).id})` : 'var(--c-execution)'
  const pct = prog ? Math.round((prog.done / prog.total) * 100) : 0
  const inFlight = i.status === 'doing' || i.status === 'review' || live === 'live' || live === 'waiting'
  // the choice buttons: a drag never starts from inside them (the note input keeps its text selection)
  const [noDrag, setNoDrag] = useState(false)
  const asking = i.status === 'needs-you' || recentOne
  const liveDot = live === 'live' ? <Dot s="run" title="its conversation is working" /> : live === 'waiting' ? <Dot s="ask" title="its conversation is waiting on you" /> : null
  return (
    <article className={`board-card pr-${i.priority} ${asking ? 'asks' : ''}`} draggable={!noDrag} style={{ ['--c' as string]: color }}
      onDragStart={e => { e.dataTransfer.setData('text/board', i.id); e.dataTransfer.effectAllowed = 'move' }}
      onClick={onOpen} onKeyDown={e => { if (e.key === 'Enter') onOpen() }} tabIndex={0}
      title={cardTitle(i, blocked, prog)}>
      {/* one chip: the kind (the owner's category is the top edge). id, priority, auto and other labels live in the title */}
      <div className="board-card-top">
        <span className={`tag sm board-kind k-${i.kind}`}>{i.kind}</span>
        <span className="sp" />
        {noLive === true && !live && <span className="tag sm board-nolive" title={`doing, but no live conversation${i.conversation ? ` (${i.conversation} is not working or waiting)` : ` (${i.owner} has none working or waiting)`}: nothing is working on it`}>no conversation</span>}
        {liveDot}
        {i.conversation && <button className="ibox board-conv" title={`Open conversation ${i.conversation}`}
          onClick={e => { e.stopPropagation(); nav.go('chats', i.conversation!) }} aria-label="open conversation">
          <svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinejoin="round"><path d="M4 5h16v11H9l-5 4z" /></svg></button>}
      </div>
      <div className="board-card-t">{blocked.length > 0 && <Lock ids={blocked} />}{softBreaks(firstClause(dropOwnerPrefix(i.title, i.owner)))}</div>
      {asking && <div onPointerEnter={() => setNoDrag(true)} onPointerLeave={() => setNoDrag(false)}><Choices i={i} /></div>}
      {prog
        ? <div className="board-prog" title={`${prog.done} of ${prog.total} ${prog.src === 'steps' ? "done in its conversation's step list" : 'ticked in the item checklist'}`}><i style={{ width: `${pct}%` }} /></div>
        : inFlight && !(noLive === true && !live)
          // in progress with no count yet: an EMPTY track (never a guessed fill), moving while its conversation works
          ? <div className={`board-prog none ${live === 'live' ? 'run' : ''}`} title={live === 'live' ? 'working, no step list yet' : 'in progress, no step list or checklist yet'}><i /></div>
          : null}
      {/* meta: avatar, age, comment count. Nothing else */}
      <div className="board-card-m">
        <Avatar id={i.owner} size={16} />
        <span className="board-age">{relTime(i.created)}</span>
        <span className="sp" />
        {i.notes > 0 && <span className="board-nn" title={`${i.notes} note${i.notes === 1 ? '' : 's'}`}><Icon name="note" />{i.notes}</span>}
      </div>
    </article>
  )
}

// ---------- badge + palette ----------

function useBadge() {
  const q = useApi<{ items: Listed[] }>('/api/board?status=needs-you', ['board'])
  const n = q.data?.items.length ?? 0
  return n ? { n } : null
}

async function palette(nav: Nav): Promise<PaletteItem[]> {
  const r = await api<{ items: Listed[] }>('/api/board')
  return r.items.filter(open).map(i => ({
    kind: 'board', label: `${i.id} ${i.title}`, hint: i.status,
    run: () => nav.go('board', i.id),
  }))
}

export const room: RoomDef = {
  id: 'board',
  label: 'Board',
  title: 'Board',
  icon: <><rect x="3" y="4" width="5" height="16" rx="1"/><rect x="10" y="4" width="5" height="11" rx="1"/><rect x="17" y="4" width="4" height="7" rx="1"/></>,
  Explorer,
  Main,
  Head,
  useBadge,
  palette,
}
