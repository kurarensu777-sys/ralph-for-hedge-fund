import { useEffect, useMemo, useRef, useState } from 'react'
import { api, relTime } from '../lib/api.ts'
import type { PaletteItem, RoomDef } from '../rooms/types.ts'
import type { AgentRow, Conversation } from '../../server/chat/types.ts'
import { chatTitle } from '../rooms/chats/title.ts'
import { CATEGORIES, categoryOf, initials } from '../ui/categories.ts'
import { Dot, markOf } from '../ui/kit.tsx'
import { useNav } from './nav.tsx'
import { arrange, convDot, flat, KEYS, sectionOf, type Cmd } from './command.ts'
import { loadAll } from './rooms.ts'
import { reloadUi } from './reload.ts'

// THE COMMAND BAR (Ctrl K / Ctrl P): a frosted panel of grouped sections. Recent conversations and
// agents are built here (they need an agent's colour and a live dot); every other row is the rooms'
// own `palette`, sorted into a section by its kind. Arrow keys walk the flat list, Enter runs it.

type ShellActions = { toggleList: () => void; toggleRail: () => void; sync: () => void; copyLink: () => void }

const DASH_COLOR = CATEGORIES.dashboards.color

/** an agent's two letters: kit's markOf, the one rule every surface uses */
export const agentMark = markOf

function fromRoom(x: PaletteItem): Cmd | null {
  if (x.kind === 'chat') return null // the shell builds Recent + Agents itself
  const section = sectionOf(x.kind)
  if (x.kind === 'dash') {
    const [verb, ...rest] = x.label.split(' ')
    const name = rest.join(' ') || x.label
    const start = verb === 'start'
    return { section, label: start ? `Start ${name}` : name, hint: x.hint, mark: { text: x.agent ? markOf(x.agent) : initials(name), color: DASH_COLOR }, verb: start ? 'Start' : 'Open', run: x.run }
  }
  if (section === 'Books') return { section, label: x.label, hint: x.hint, mark: { text: x.kind === 'text' ? '¶' : 'B' }, verb: 'Read', run: x.run }
  if (section === 'Board') return { section, label: x.label, hint: x.hint, mark: { text: '#' }, verb: 'Open', run: x.run }
  if (section === 'Runs') return { section, label: x.label, hint: x.hint, mark: { text: 'R' }, verb: 'Show', run: x.run }
  return { section, label: x.label, hint: x.hint, mark: { text: '>' }, verb: 'Run', run: x.run }
}

export function Palette({ onClose, actions, initial = '' }: { onClose: () => void; actions: ShellActions; initial?: string }) {
  const nav = useNav()
  const { go, toast } = nav
  const [q, setQ] = useState(initial)
  const [rows, setRows] = useState<Cmd[]>([])
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading')
  const [i, setI] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let live = true
    const own: Cmd[] = [
      { section: 'Actions', label: 'Copy link', mark: { text: '#' }, verb: 'Copy', run: actions.copyLink },
      { section: 'Actions', label: 'Toggle services', mark: { text: '>' }, verb: 'Run', run: actions.toggleRail },
      { section: 'Actions', label: 'Sync every repo', mark: { text: '>' }, verb: 'Run', run: actions.sync },
      { section: 'Actions', label: 'Reload the UI', hint: 'agents keep running', mark: { text: '>' }, verb: 'Run', run: () => void reloadUi(toast) },
    ]
    const keyRun: Record<typeof KEYS[number]['id'], () => void> = { bar: () => {}, list: actions.toggleList, close: () => nav.openDrawer(null) }
    const keys: Cmd[] = KEYS.map(k => ({ section: 'Keys', label: k.label, hint: 'hint' in k ? k.hint : undefined, mark: { text: '~' }, keys: k.keys, run: keyRun[k.id] }))
    setRows([...own, ...keys])
    const rooms = loadAll()
    const goRows = rooms.then(rs => rs.map((r): Cmd => ({ section: 'Actions', label: `Go to ${r.title}`, mark: { text: r.label[0] }, verb: 'Go', run: () => go(r.id) })))
    const newChat = (agent: string) =>
      api<{ id: string }>('/api/chats', { body: { agent } }).then(r => go('chats', r.id)).catch(e => toast(`new chat: ${e.message}`, true))
    const chats = Promise.all([
      api<{ agents: AgentRow[] }>('/api/chats/agents'),
      api<{ conversations: Conversation[] }>('/api/chats?limit=40'),
    ]).then(([ag, cv]) => {
      const byId = new Map(ag.agents.map(a => [a.id, a]))
      const recent: Cmd[] = [...cv.conversations].sort((a, b) => b.lastAt - a.lastAt).map(c => {
        const cat = categoryOf(c.agent)
        return {
          section: 'Recent', label: chatTitle(c.title) || `${byId.get(c.agent)?.name ?? c.agent} chat`,
          hint: `${byId.get(c.agent)?.name ?? c.agent} · ${relTime(c.lastAt)}`,
          mark: { text: agentMark(c.agent), color: cat.color }, dot: c.state === 'closed' ? undefined : convDot(c.state), verb: 'Open',
          run: () => go('chats', c.id),
        }
      })
      const agents: Cmd[] = ag.agents.filter(a => a.mode === 'active')
        .sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'standing' ? -1 : 1))
        .map(a => ({
          section: 'Agents', label: a.name,
          mark: { text: agentMark(a.id), color: categoryOf(a.id).color },
          dot: a.waiting ? 'ask' : a.working ? 'run' : undefined, verb: 'New chat',
          run: () => { void newChat(a.id) },
        }))
      // pinned: a new chat with whoever the owner talked to last, and filing a board item
      const last = [...cv.conversations].sort((a, b) => b.lastAt - a.lastAt).map(c => byId.get(c.agent)).find(a => a && a.mode === 'active')
      const pins: Cmd[] = [
        ...(last ? [{ section: 'Actions' as const, label: `New chat with ${last.name}`, mark: { text: agentMark(last.id), color: categoryOf(last.id).color }, verb: 'Start', pin: true, run: () => { void newChat(last.id) } }] : []),
        { section: 'Actions', label: 'File a board item', mark: { text: '+' }, verb: 'File', pin: true, run: () => go('board', 'new') },
      ]
      return [...pins, ...recent, ...agents]
    })
    const others = rooms.then(rs => Promise.all(rs.map(r => r.palette?.(nav).catch(() => []) ?? Promise.resolve([]))))
      .then(lists => lists.flat().map(fromRoom).filter((x): x is Cmd => !!x))
    Promise.allSettled([goRows, chats, others]).then(([g, a, b]) => {
      if (!live) return
      const goTo = g.status === 'fulfilled' ? g.value : []
      const got = [a, b].flatMap(r => (r.status === 'fulfilled' ? r.value : []))
      // a dashboard row wears its agent's letters (the same ones the chats list shows)
      const letters = new Map(got.filter(c => c.section === 'Agents' && c.mark).map(c => [c.label.toLowerCase(), c.mark!.text]))
      for (const c of got) if (c.section === 'Dashboards' && c.mark) c.mark.text = letters.get(c.label.replace(/^Start /, '').toLowerCase()) ?? c.mark.text
      setRows(prev => [...goTo, ...prev, ...got])
      setState(a.status === 'rejected' && b.status === 'rejected' ? 'failed' : 'ready')
    })
    return () => { live = false }
  }, [go]) // eslint-disable-line react-hooks/exhaustive-deps

  // live full-text hits (RoomDef.search) for the query, matched server-side: never re-filtered here
  const [found, setFound] = useState<{ q: string; items: Cmd[] }>({ q: '', items: [] })
  useEffect(() => {
    const t = q.trim()
    if (t.length < 3) return
    let live = true
    const h = setTimeout(() => {
      loadAll().then((rs: RoomDef[]) => Promise.all(rs.map(r => r.search?.(t).catch(() => []) ?? Promise.resolve([]))))
        .then(lists => { if (live) setFound({ q: t, items: lists.flat().map(fromRoom).filter((x): x is Cmd => !!x) }) })
    }, 200)
    return () => { live = false; clearTimeout(h) }
  }, [q])

  const groups = useMemo(() => arrange(rows, q, found.q.toLowerCase() === q.trim().toLowerCase() ? found.items : []), [rows, q, found])
  const list = useMemo(() => flat(groups), [groups])
  useEffect(() => setI(0), [q])
  useEffect(() => { listRef.current?.querySelector('.pal-item.on')?.scrollIntoView({ block: 'nearest' }) }, [i])
  const pick = (x?: Cmd) => { if (x) { onClose(); x.run() } }

  let n = -1
  return (
    <div className="pal-veil" onClick={onClose}>
      <div className="pal" role="dialog" aria-label="Command bar" onClick={e => e.stopPropagation()}>
        <div className="pal-in">
          <svg className="pal-glass" viewBox="0 0 16 16"><circle cx="7" cy="7" r="4.5" /><path d="M10.5 10.5L14 14" /></svg>
          <input autoFocus placeholder="Jump to anything" value={q} onChange={e => setQ(e.target.value)} aria-label="Search"
            onKeyDown={e => {
              if (e.key === 'ArrowDown') { e.preventDefault(); setI(Math.min(i + 1, list.length - 1)) }
              else if (e.key === 'ArrowUp') { e.preventDefault(); setI(Math.max(i - 1, 0)) }
              else if (e.key === 'Enter') { e.preventDefault(); pick(list[i]) }
              else if (e.key === 'Escape') { e.preventDefault(); onClose() }
            }} />
          {state === 'loading' && <span className="pal-load" title="loading agents, chats, books" />}
          <kbd className="pal-kbd">Esc</kbd>
        </div>
        <div className="pal-list" ref={listRef}>
          {groups.map((g, gi) => (
            <div key={`${gi}-${g.section}`} className="pal-grp">
              <div className="pal-g">{g.section}</div>
              {g.items.map(x => {
                const k = ++n
                return (
                  <div key={g.section + x.label + k} className={`pal-item ${k === i ? 'on' : ''}`} onMouseMove={() => k !== i && setI(k)} onClick={() => pick(x)}>
                    <span className="pal-ic" style={x.mark?.color ? { color: x.mark.color, background: `${x.mark.color}1f` } : undefined}>{x.mark?.text ?? ''}</span>
                    <span className="pal-lbl">{x.label}</span>
                    {x.hint && <span className="pal-h">{x.hint}</span>}
                    <span className="pal-r">
                      {x.dot && <Dot s={x.dot} title={x.dot === 'run' ? 'working' : x.dot === 'ask' ? 'needs you' : 'open'} />}
                      {x.keys ? <kbd>{x.keys}</kbd> : k === i && x.verb ? <kbd>{x.verb} ↵</kbd> : null}
                    </span>
                  </div>
                )
              })}
            </div>
          ))}
          {list.length === 0 && state !== 'loading' && <div className="pal-none">{state === 'failed' ? 'fundd unreachable' : 'no match'}</div>}
        </div>
        <div className="pal-foot"><span><kbd>↑</kbd><kbd>↓</kbd> move</span><span><kbd>↵</kbd> open</span><span><kbd>Esc</kbd> close</span><span className="pal-sp" />{KEYS.filter(k => k.id !== 'close').map(k => <span key={k.id} title={k.label}>{k.keys.split(' · ').map(x => <kbd key={x}>{x}</kbd>)} {k.id === 'bar' ? 'bar' : 'list'}</span>)}</div>
      </div>
    </div>
  )
}
