import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { RoomDef, PaletteItem } from '../types.ts'
import { api, relTime, useApi, useStored, useTopic } from '../../lib/api.ts'
import { useNav, useSel, type Nav } from '../../shell/nav.tsx'
import { Btn, CardGroup, Empty, Glyph, Icon, Live, Pill } from '../../ui/kit.tsx'
import { chatTitle, convLabel } from './title.ts'
import { askFirst, byDay } from './days.ts'
import { CATEGORIES, catVar, categoryOf, type Category } from '../../ui/categories.ts'
import type { AgentRow, Conversation, TerminalInfo } from '../../../server/chat/types.ts'
import { ChatPane, Title, stateDot } from './ChatPane.tsx'
import { LawChip } from './Law.tsx'
import { TerminalPane } from './TerminalPane.tsx'
import { bellState, makeDedupe, noteFor } from './notify.ts'
import { bellOn, keyToPane, noteSeen, useBellPref, useChatsApi, useDrafts, useLooking, usePanes, useSeen } from './state.ts'
import { litChats, litTitle, paneInView, rowMark, tabLight, watchedPane, type Light, type Mark } from './mark.ts'
import { placeAll, repoOfCwd } from './place.ts'
import { tabProgress } from './progress.ts'
import type { Progress } from '../../../server/chat/progress.ts'
import './chats.css'

// ROOM: chats. The explorer lists agents as the tree - one card per repo, the agents inside it as
// bands (place.ts) - with their live conversations, their terminals and an "N older" row; the main
// area is a strip of open panes, one visible.
// Server: server/rooms/chats.ts + server/chat/.

type Agents = { agents: AgentRow[] }
type Convs = { conversations: Conversation[] }
type Terms = { terminals: TerminalInfo[] }

function useData() {
  const agents = useChatsApi<Agents>('/api/chats/agents')
  const convs = useChatsApi<Convs>('/api/chats?limit=500')
  const terms = useChatsApi<Terms>('/api/chats/terminals')
  return { agents, convs, terms }
}

function useActions() {
  const { go, toast } = useNav()
  const newChat = (agent: string) =>
    api<{ id: string }>('/api/chats', { body: { agent } }).then(r => go('chats', r.id)).catch(e => toast(`new chat: ${e.message}`, true))
  const newTerm = (agent?: string) =>
    api<TerminalInfo>('/api/chats/terminal', { body: agent ? { agent } : {} }).then(t => go('chats', `term:${t.id}`)).catch(e => toast(`terminal: ${e.message}`, true))
  return { newChat, newTerm }
}

/** the pane key the owner is LOOKING at right now (room on screen, pane in view, tab visible and
 *  focused), or null: the one thing that marks a conversation seen and keeps its tab dark */
function useWatched(): string | null {
  const { room } = useNav()
  const [sel] = useSel('chats')
  const [panes] = usePanes()
  const look = useLooking()
  return watchedPane(paneInView(sel, panes), { room: room === 'chats', ...look })
}

/** the row mark slot: always 7px wide so titles line up; a dot only for running or unread */
function RowMark({ m }: { m: Mark }) {
  return <span className={`chats-mk ${m ?? ''}`} title={m ?? undefined} aria-label={m ?? undefined} />
}


function Explorer() {
  const { agents, convs, terms } = useData()
  const [sel] = useSel('chats')
  const [panes] = usePanes()
  const drafts = useDrafts()
  const seen = useSeen()
  const watched = useWatched()
  const { go } = useNav()
  const { newChat, newTerm } = useActions()
  const [older, setOlder] = useState<Record<string, boolean>>({})
  const [fold, setFold] = useStored<Record<string, boolean>>('chats.fold', {})

  if (agents.error && !agents.data) return <Empty state="failed">{agents.error}</Empty>
  if (!agents.data) return <Empty state="loading" skel="cg" />
  const all = convs.data?.conversations ?? []
  const openKeys = new Set(panes)
  /** an agent's newest conversation (the dashboard row's age and click target) */
  const lastOf = (id: string) => all.filter(c => c.agent === id).reduce<Conversation | null>((b, c) => (!b || c.lastAt > b.lastAt ? c : b), null)

  /** an agent's conversations, terminals and "N older" row (the kids of a card) */
  const kids = (a: AgentRow, withOlder = true) => {
    const mine = all.filter(c => c.agent === a.id && (c.title || c.state !== 'closed' || openKeys.has(c.id) || drafts[c.id] || c.id === sel))
    const open = mine.filter(c => c.state !== 'closed' || openKeys.has(c.id) || drafts[c.id] || c.id === sel)
    const closed = mine.filter(c => !open.includes(c)).sort((x, y) => y.lastAt - x.lastAt)
    // a card is never just "N older": the newest closed ones fill it up to three rows
    const fill = withOlder ? Math.max(0, 3 - open.length) : 0
    const active = [...open, ...closed.slice(0, fill)]
    const rest = closed.slice(fill)
    const tms = (terms.data?.terminals ?? []).filter(t => t.agent === a.id)
    return <>
      {active.map(c => (
        <button key={c.id} className={`cg-it ${sel === c.id ? 'on' : ''}`} onClick={() => go('chats', c.id)} title={c.title}>
          <RowMark m={rowMark(c, seen, watched === c.id)} />
          <span className="nm">{convLabel(c) || <i className="faint chats-new" title="no message yet">new</i>}</span>
          {drafts[c.id] ? <span className="r chats-draft">draft</span> : <span className="r">{c.state === 'waiting' ? 'you' : relTime(c.lastAt)}</span>}
        </button>
      ))}
      {tms.map(t => (
        <button key={t.id} className={`cg-it ${sel === `term:${t.id}` ? 'on' : ''}`} onClick={() => go('chats', `term:${t.id}`)} title={t.cwd}>
          <RowMark m={t.alive ? 'running' : null} />
          <span className="nm mono">{t.title || 'terminal'}</span>
          <span className="r">&gt;_</span>
        </button>
      ))}
      {withOlder && rest.length > 0 && <>
        <button className="cg-it chats-older" onClick={() => setOlder({ ...older, [a.id]: !older[a.id] })}>
          <span className="nm">{older[a.id] ? 'hide older' : `${rest.length} older`}</span>
        </button>
        {older[a.id] && rest.slice(0, 40).map(c => (
          <button key={c.id} className={`cg-it chats-old ${sel === c.id ? 'on' : ''}`} onClick={() => go('chats', c.id)} title={c.title}>
            <RowMark m={rowMark(c, seen, watched === c.id)} />
            <span className="nm">{convLabel(c) || <i className="faint chats-new" title="no message yet">new</i>}</span>
            <span className="r">{relTime(c.lastAt)}</span>
          </button>
        ))}
      </>}
    </>
  }

  const actions = (a: AgentRow) => a.mode === 'dormant' ? null : <>
    <button className="iconbtn" title={`New conversation with ${a.name}`} onClick={() => newChat(a.id)}>+</button>
    <button className="iconbtn" title={`Terminal in ${a.cwd}`} onClick={() => newTerm(a.id)}>&gt;_</button>
  </>

  /** the live mark on a card head: blue when something waits on the owner, the accent pulse while working */
  const live = (list: AgentRow[]) => <Live waiting={list.reduce((s, a) => s + a.waiting, 0)} working={list.reduce((s, a) => s + a.working, 0)} />

  const card = (key: string, cat: Category, name: string, list: AgentRow[], body: ReactNode, head: ReactNode, dormant: boolean, tip: string) => {
    const closed = fold[key] ?? dormant
    return (
      <CardGroup key={key} abbr={cat.abbr} color={cat.color} name={name} role={dormant ? 'dormant' : undefined} title={`${tip}${dormant ? ' (dormant)' : ''}`}
        closed={closed} dormant={dormant} onToggle={() => setFold({ ...fold, [key]: !closed })} hover={head} live={live(list)}>
        {body}
      </CardGroup>
    )
  }

  /** a dashboard's row: one line (click opens its newest chat, hover + and >_), its open chats under it */
  const dashRow = (a: AgentRow) => (
    <div key={a.id} className={`chats-dag ${a.mode === 'dormant' ? 'dormant' : ''}`}>
      <div className="cg-it chats-dag-h" title={a.role} role="button" tabIndex={0}
        onClick={() => { const last = lastOf(a.id); if (last) go('chats', last.id) }}>
        <RowMark m={a.working ? 'running' : all.some(c => c.agent === a.id && rowMark(c, seen, watched === c.id) === 'unread') ? 'unread' : null} />
        <span className="nm">{a.name}</span>
        <span className="r">{(a.working + a.waiting) > 0 ? a.working + a.waiting : lastOf(a.id) ? relTime(lastOf(a.id)!.lastAt) : ''}</span>
        <span className="chats-dag-a" onClick={e => e.stopPropagation()}>{actions(a)}</span>
      </div>
      <div className="chats-dag-k">{kids(a, false)}</div>
    </div>
  )

  /** a tenant inside a repo's card: the dashboards together, any other agent (research) on its own */
  const band = (b: { id: string; agents: AgentRow[] }) => {
    const dash = b.id === 'dashboards'
    const lead = b.agents[0]
    const bcat = dash ? CATEGORIES.dashboards : categoryOf(lead)
    const key = `band:${b.id}`
    const shut = fold[key] ?? b.agents.every(a => a.mode === 'dormant')
    const label = dash ? 'Dashboards' : bcat.id === lead.id ? bcat.name : lead.name
    const toggle = () => setFold({ ...fold, [key]: !shut })
    return (
      <div key={b.id} className={`chats-band ${shut ? 'closed' : ''}`} style={catVar(bcat)}>
        <div className="chats-band-h" role="button" tabIndex={0} aria-expanded={!shut} onClick={toggle}
          onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle() } }}
          title={dash ? b.agents.map(a => a.name).join(', ') : lead.role}>
          <span className="chats-band-nm">{label}</span>
          <span className="chats-band-ln" />
          {!dash && <span className="chats-band-a" onClick={e => e.stopPropagation()}>{actions(lead)}</span>}
          {live(b.agents)}
          <span className="cg-chev"><svg viewBox="0 0 16 16"><path d="M4 6l4 4 4-4" /></svg></span>
        </div>
        {!shut && <div className="chats-band-k">{dash ? b.agents.map(dashRow) : kids(lead)}</div>}
      </div>
    )
  }

  // the list IS the tree: one card per repo (its home agent), the agents inside it as bands (place.ts)
  const tree = placeAll(agents.data.agents)
  const loose = (terms.data?.terminals ?? []).filter(t => !t.agent)
  return (
    <div className="cg-list chats-ex">
      {tree.repos.map(r => {
        const a = r.home
        const cat = categoryOf(a)
        const tenants = r.bands.flatMap(b => b.agents)
        const tip = tenants.length ? `${a.role}
+ ${tenants.map(t => t.name).join(', ')}` : a.role
        return card(`repo:${repoOfCwd(a.cwd)}`, cat, cat.id === a.id ? cat.name : a.name, [a, ...tenants],
          <>{kids(a)}{r.bands.map(band)}</>, actions(a), a.mode === 'dormant', tip)
      })}
      {tree.unplaced.length > 0 && (
        <CardGroup key="unplaced" neutral abbr="?" color="var(--off)" name="Unplaced"
          title={['cwd in no repo: fix the roster file', ...tree.unplaced.map(a => `${a.id}: ${a.cwd}`)].join('\n')}>
          {tree.unplaced.map(dashRow)}
        </CardGroup>
      )}
      <div className="grp chats-ex-grp"><span>Terminals</span><button className="iconbtn" title="Terminal at the fund root" onClick={() => newTerm()}>+</button></div>
      {loose.map(t => (
        <button key={t.id} className={`cg-it chats-loose ${sel === `term:${t.id}` ? 'on' : ''}`} onClick={() => go('chats', `term:${t.id}`)} title={t.cwd}>
          <RowMark m={t.alive ? 'running' : null} />
          <span className="nm mono">{t.title || 'terminal'}</span>
        </button>
      ))}
      {convs.error && <Empty inline state="failed">{convs.error}</Empty>}
    </div>
  )
}

function Main() {
  const { agents, convs, terms } = useData()
  const [sel, setSel] = useSel('chats')
  const [panes, { open, close }] = usePanes()
  const { newChat } = useActions()
  const { toast } = useNav()
  const [chg, setChg] = useStored<boolean>('chats.changes', false)
  // the light in each tab: every conversation's turn progress (server/chat/progress.ts)
  const prog = useApi<{ progress: Record<string, Progress> }>('/api/chats/progress', ['chat:progress'])

  // a selection from anywhere (explorer, palette, another room's go('chats', id)) opens its pane
  useEffect(() => { if (sel && !panes.includes(sel)) open(sel) }, [sel, panes, open])
  const visible = paneInView(sel, panes)

  const byId = useMemo(() => new Map((convs.data?.conversations ?? []).map(c => [c.id, c])), [convs.data])
  const termById = useMemo(() => new Map((terms.data?.terminals ?? []).map(t => [t.id, t])), [terms.data])
  const agentList = agents.data?.agents ?? []
  // the conversation the owner is LOOKING at is seen as of its newest message (the row marks' unread,
  // the tab lights): never while the window is hidden or blurred, so a turn that ends then stays lit
  const seen = useSeen()
  const watched = useWatched()
  const seenAt = watched ? byId.get(watched)?.lastAt : undefined
  useEffect(() => { if (watched && seenAt) noteSeen(watched, seenAt) }, [watched, seenAt])

  const closePane = (k: string) => {
    const p = keyToPane(k)
    if (p.kind === 'term') api(`/api/chats/terminal/${p.id}`, { method: 'DELETE' }).catch(e => toast(e.message, true))
    const next = close(k)
    if (k === visible) setSel(next)
  }

  if (!panes.length) return <Home agents={agentList} onNew={newChat} />
  const vp = visible ? keyToPane(visible) : null
  const vc = vp?.kind === 'chat' ? byId.get(vp.id) : undefined
  return (
    <div className="chats-main">
      <div className="chats-tabs">
        <TabScroller active={visible} n={panes.length}>
        {panes.map(k => {
          const p = keyToPane(k)
          const c = p.kind === 'chat' ? byId.get(p.id) : undefined
          const t = p.kind === 'term' ? termById.get(p.id) : undefined
          const agent = c ? agentList.find(a => a.id === c.agent) : t?.agent ? agentList.find(a => a.id === t.agent) : undefined
          const label = p.kind === 'term' ? (t?.title || 'terminal') : (c ? convLabel(c) || 'new' : '-')
          const light = c ? tabLight(c, seen, k === watched) : null
          const dot = p.kind === 'term' ? (t?.alive ? 'ok' : 'off') : light === 'fail' ? 'fail' : stateDot(c?.state ?? 'closed')
          const pg = c ? tabProgress(prog.data?.progress[c.id], { light, watched: k === watched, now: Date.now() }) : null
          return (
            <div key={k} data-k={k} className={`chats-tab ${k === visible ? 'on' : ''} ${light ? `lit-${light}` : ''} ${pg ? `prog pk-${pg.kind}` : ''}`} onClick={() => setSel(k)} onAuxClick={e => { if (e.button === 1) closePane(k) }} title={`${agent?.name ?? ''}\n${c?.title || label}${light ? `\n${LIGHT_TIP[light]}` : ''}${pg ? `\n${pg.tip}` : ''}`}>
              {pg && <span className={`chats-pf ${pg.fade ? 'fade' : ''}`}>{pg.pct === null ? <i className="chats-pf-sw" /> : <i className="chats-pf-f" style={{ width: `${pg.pct}%` }} />}</span>}
              <span className={`dot ${dot}`} />
              {agent && <span className="chats-gc" style={catVar(categoryOf(agent))}><Glyph id={agent.id} size={16} /></span>}
              {k === visible && c ? <span className="chats-tab-t"><Title c={c} agentName={agent?.name} /></span>
                : <span className={`chats-tab-t ${p.kind === 'term' ? 'mono' : ''}`}>{label}</span>}
              <span className="chats-tab-sp" />
              {pg && k === visible && pg.now && <span className="chats-tab-now">{pg.now}</span>}
              {pg?.count && <span className="chats-tab-n">{pg.count}</span>}
              <button className="iconbtn" title="Close" onClick={e => { e.stopPropagation(); closePane(k) }}>x</button>
            </div>
          )
        })}
        </TabScroller>
        {vc && <span className="chats-tabs-r"><LawChip key={`law-${vc.id}`} id={vc.id} /><Btn sm kind={chg ? 'primary' : undefined} title="Commits and uncommitted files of this conversation" onClick={() => setChg(!chg)}><Icon name="logs" />Changes</Btn></span>}
      </div>
      <div className="chats-body">
        {vp?.kind === 'chat' && <ChatPane key={vp.id} id={vp.id} agents={agentList} onOpen={id => setSel(id)} onNew={newChat} chg={chg} setChg={setChg} />}
        {vp?.kind === 'term' && <TerminalPane key={vp.id} id={vp.id} />}
      </div>
    </div>
  )
}

const LIGHT_TIP: Record<Exclude<Light, null>, string> = {
  done: 'finished: new since you last looked',
  ask: 'waiting on you',
  fail: 'the last turn ended on an error',
}

/** the pane strip's tabs: they scroll sideways (mouse wheel too), the open tab is kept in view, and
 *  an edge with tabs beyond it fades, so a cut tab never reads as the last one */
function TabScroller({ active, n, children }: { active: string | null; n: number; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  const [edge, setEdge] = useState({ l: false, r: false })
  const measure = useCallback(() => {
    const el = ref.current
    if (!el) return
    const l = el.scrollLeft > 2, r = el.scrollLeft + el.clientWidth < el.scrollWidth - 2
    setEdge(e => (e.l === l && e.r === r ? e : { l, r }))
  }, [])
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>(`[data-k="${CSS.escape(active ?? '')}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    measure()
  }, [active, n, measure])
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    const wheel = (e: WheelEvent) => { if (Math.abs(e.deltaY) > Math.abs(e.deltaX) && el.scrollWidth > el.clientWidth) { e.preventDefault(); el.scrollLeft += e.deltaY } }
    el.addEventListener('wheel', wheel, { passive: false })
    return () => { ro.disconnect(); el.removeEventListener('wheel', wheel) }
  }, [measure])
  return <div ref={ref} className={`chats-tabs-l ${edge.l ? 'fl' : ''} ${edge.r ? 'fr' : ''}`} onScroll={measure}>{children}</div>
}

/** the main area with no pane open: start a conversation, or pick one back up. RECENT is a day
 *  timeline capped at 760px: title, the last message as one faint line (none when there is none),
 *  age, and the row mark at the right edge (running or unread, else none); what waits on the owner leads its day */
/** the "+" chips above Recent: one per repo, the agents inside it (research, the dashboards) in its menu */
function HomeNew({ agents, onNew }: { agents: AgentRow[]; onNew: (agent: string) => void }) {
  const [menu, setMenu] = useState<string | null>(null)
  useEffect(() => {
    if (!menu) return
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenu(null) }
    const off = (e: MouseEvent) => { if (!(e.target as HTMLElement).closest?.('.chats-home-pk')) setMenu(null) }
    window.addEventListener('keydown', esc); window.addEventListener('mousedown', off)
    return () => { window.removeEventListener('keydown', esc); window.removeEventListener('mousedown', off) }
  }, [menu])
  const tree = placeAll(agents)
  return (
    <span className="chats-home-new">
      {tree.repos.filter(r => r.home.mode === 'active').map(r => {
        const a = r.home
        const inside = r.bands.flatMap(b => b.agents).filter(x => x.mode === 'active')
        const chip = <button className="btn chats-home-cat" style={catVar(categoryOf(a))} title={`New conversation with ${a.name}: ${a.role}`} onClick={() => onNew(a.id)}>+ {a.name}</button>
        if (!inside.length) return <span key={a.id}>{chip}</span>
        return (
          <span key={a.id} className="chats-home-pk" style={catVar(categoryOf(a))}>
            {chip}
            <button className="btn chats-home-cat chats-home-more" aria-expanded={menu === a.id} title={`New conversation with an agent inside ${a.name}`}
              onClick={() => setMenu(menu === a.id ? null : a.id)}><svg viewBox="0 0 16 16"><path d="M4 6l4 4 4-4" /></svg></button>
            {menu === a.id && (
              <div className="pop chats-home-menu">
                {inside.map(x => (
                  <button key={x.id} className="pop-row" style={catVar(categoryOf(x))} title={x.role} onClick={() => { setMenu(null); onNew(x.id) }}>
                    <span className="chats-gc"><Glyph id={x.id} size={16} /></span><span className="nm">{categoryOf(x).id === x.id ? categoryOf(x).name : x.name}</span>
                  </button>
                ))}
              </div>
            )}
          </span>
        )
      })}
    </span>
  )
}

function Home({ agents, onNew }: { agents: AgentRow[]; onNew: (agent: string) => void }) {
  const { go } = useNav()
  const convs = useChatsApi<{ conversations: (Conversation & { preview?: string })[] }>('/api/chats?limit=300&preview=1')
  const seen = useSeen()
  const name = (id: string) => agents.find(a => a.id === id)?.name ?? id
  const recent = runs((convs.data?.conversations ?? []).filter(c => c.title || c.state !== 'closed').sort((a, b) => b.lastAt - a.lastAt)).slice(0, 14)
  const agentOf = (id: string) => agents.find(a => a.id === id) ?? id
  const days = askFirst(byDay(recent, r => r.c.lastAt, Date.now()), r => r.c.state === 'waiting')
  return (
    <div className="chats-home">
      <div className="grp chats-home-h">
        <span>Recent</span>
        <HomeNew agents={agents} onNew={onNew} />
      </div>
      {convs.error && !convs.data ? <Empty state="failed">{convs.error}</Empty>
        : !convs.data ? <Empty state="loading" skel="table" />
        : !recent.length ? <Empty title="NONE YET" />
        : days.map(g => (
          <section key={g.label} className="tl-day">
            <div className="cap tl-dh">{g.label}</div>
            <div className="tl bg2">
              {g.items.map(({ c, n }) => {
                const pv = (c as { preview?: string }).preview
                return (
                  <button key={c.id} className={`tl-r edge chats-home-row ${c.state === 'waiting' ? 'ask' : ''}`} style={catVar(categoryOf(agentOf(c.agent)))} onClick={() => go('chats', c.id)} title={`${name(c.agent)}
${c.title || '-'}${pv ? `
${pv}` : ''}${n > 1 ? `
${n} conversations with this title; opens the newest` : ''}`}>
                    <span className="chats-gc"><Glyph id={c.agent} /></span>
                    <span className="chats-home-tx">
                      <span className="chats-home-t">
                        <span className="chats-home-nm">{convLabel(c) || <i className="faint chats-new" title="no message yet">new</i>}</span>
                        {n > 1 && <Pill title={`${n} conversations with this title`}>{n}</Pill>}
                      </span>
                      {pv && <span className="chats-home-pv">{pv}</span>}
                    </span>
                    <span className="r chats-home-age">{relTime(c.lastAt)}</span>
                    <RowMark m={rowMark(c, seen)} />
                  </button>
                )
              })}
            </div>
          </section>
        ))}
    </div>
  )
}

/** closed conversations with the same agent and display title: one row with a count, where the newest sits (it opens) */
export function runs(list: Conversation[]): { c: Conversation; n: number }[] {
  const out: { c: Conversation; n: number }[] = []
  const seen = new Map<string, { c: Conversation; n: number }>()
  for (const c of list) {
    const t = chatTitle(c.title)
    const k = `${c.agent}|${t}`
    const hit = t && c.state === 'closed' ? seen.get(k) : undefined
    if (hit) { hit.n++; continue }
    const row = { c, n: 1 }
    out.push(row)
    if (t && c.state === 'closed') seen.set(k, row)
  }
  return out
}

function Head() {
  const { newTerm } = useActions()
  return <>
    <Bell />
    <Btn sm title="Terminal at the fund root" onClick={() => newTerm()}><Icon name="term" />Terminal</Btn>
  </>
}

const canNotify = () => typeof window !== 'undefined' && 'Notification' in window

/** the desktop-notification toggle: asks the browser once, remembers the owner's choice */
function Bell() {
  const { toast } = useNav()
  const [on, setOn] = useBellPref()
  const [perm, setPerm] = useState(() => (canNotify() ? Notification.permission : 'denied'))
  const s = bellState(canNotify(), perm, on)
  const click = async () => {
    if (s === 'unsupported' || s === 'denied') return
    if (s === 'on') return setOn(false)
    let p: string = Notification.permission
    if (p === 'default') { try { p = await Notification.requestPermission() } catch { p = Notification.permission } }
    setPerm(p as NotificationPermission)
    if (p === 'granted') { setOn(true); toast('notifications on') } else toast('notifications blocked by the browser', true)
  }
  const tip = s === 'on' ? 'Notifications on: a hidden tab raises one when a conversation waits on you or finishes a turn (click to turn off)'
    : s === 'off' ? 'Notifications off (click to turn on)'
    : s === 'denied' ? 'Notifications blocked in this browser site settings'
    : 'This browser has no desktop notifications'
  return (
    <button className={`btn sm ghost chats-bell ${s}`} title={tip} disabled={s === 'unsupported'} onClick={click}>
      <svg viewBox="0 0 24 24" width="14" height="14"><path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z" /><path d="M10 20.5a2 2 0 0 0 4 0" />{s !== 'on' && <path d="M4 4l16 16" />}</svg>
    </button>
  )
}

// the notifier rides the badge hook because the activity bar mounts it in every room
const seen = makeDedupe()
function useNotify() {
  const { go } = useNav()
  useTopic('chat', (d: any, topic) => {
    if (topic !== 'chat' || !canNotify()) return
    const n = noteFor(d, { hidden: document.hidden, on: bellOn(), permission: Notification.permission })
    if (!n || seen(n.tag)) return
    try {
      const x = new Notification(n.title, { body: n.body, tag: n.tag })
      x.onclick = () => { window.focus(); go('chats', n.conv); x.close() }
    } catch { /* the browser refused (e.g. permission revoked mid-session) */ }
  })
}

// the browser tab's own title, before any count went in front of it
const BASE_TITLE = typeof document !== 'undefined' ? litTitle(document.title, 0) : ''

/** the rail icon's count = the lit chats (litChats), and the browser tab title carries it too, so a
 *  finished or parked chat shows from another room or another browser tab. Unknown (the list has not
 *  loaded or failed) shows no count rather than a zero it did not measure */
function useBadge() {
  useNotify()
  const convs = useChatsApi<Convs>('/api/chats?limit=500')
  const [panes] = usePanes()
  const seen = useSeen()
  const watched = useWatched()
  const lit = convs.data ? litChats(convs.data.conversations, panes, seen, watched) : null
  const n = lit?.n ?? 0
  useEffect(() => { document.title = litTitle(BASE_TITLE, n) }, [n])
  return lit && lit.n ? lit : null
}

async function palette(nav: Nav): Promise<PaletteItem[]> {
  const go = (id: string) => nav.go('chats', id)
  const [ag, cv] = await Promise.all([
    api<Agents>('/api/chats/agents').catch(() => ({ agents: [] as AgentRow[] })),
    api<Convs>('/api/chats?limit=40').catch(() => ({ conversations: [] as Conversation[] })),
  ])
  const items: PaletteItem[] = ag.agents.filter(a => a.mode === 'active').map(a => ({
    kind: 'chat', label: `New chat with ${a.name}`, hint: a.dept,
    run: () => { api<{ id: string }>('/api/chats', { body: { agent: a.id } }).then(r => go(r.id)).catch(e => nav.toast(`new chat: ${e.message}`, true)) },
  }))
  for (const c of cv.conversations) items.push({ kind: 'chat', label: convLabel(c) || 'new', hint: `${c.agent} ${relTime(c.lastAt)}`, run: () => go(c.id) })
  return items
}

export const room: RoomDef = {
  id: 'chats',
  label: 'Chats',
  title: 'Chats',
  icon: <><path d="M4 5h16v11H9l-5 4z" /></>,
  Explorer,
  Main,
  Head,
  useBadge,
  palette,
}

