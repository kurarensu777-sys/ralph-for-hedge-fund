import { lazy, Suspense, useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import type { ServiceGroup, ServiceRow } from '../../shared/types.ts'
import { api, relTime, stamp, useApi, useConnected, useStored } from '../lib/api.ts'
import type { RoomDef } from '../rooms/types.ts'
import { Dot, Empty, setBadgeIds } from '../ui/kit.tsx'
import { CATEGORIES, UNKNOWN_COLOR } from '../ui/categories.ts'
import { useNav } from './nav.tsx'
import { ROOM_IDS, type RoomId } from './route.ts'
import { loadAll, loadRoom, useRooms } from './rooms.ts'
import { RailValue } from '../ui/value.tsx'
import { Island } from './Island.tsx'
import { dashTip, dashUp, railCard, railTally, repoOrder, repoStateTip, repoSync, tallyTip, type RailTally } from './rail.ts'
import { fmtIn, nextJobOf, spendWeek, sparkPoints, type SchedJob, type SpendRow } from './status.ts'
import './shell.css'
import { DrawerSlot } from './drawerSlot.ts'
import { CommandPill } from './CommandPill.tsx'
import { RELOAD_TIP, reloadUi } from './reload.ts'
import { useUiFresh } from './uifresh.ts'
import { getFocus, setFocus, useFocusOf } from './focus.ts'
import { Edge } from '../ui/edge.tsx'
import { Dock } from './Dock.tsx'

// the command bar is its own chunk: nothing on first paint needs it
const Palette = lazy(() => import('./Palette.tsx').then(m => ({ default: m.Palette })))

export function Shell() {
  const { room, drawer, openDrawer, toasts, toast } = useNav()
  const rooms = useRooms()
  const [exOpen, setExOpen] = useStored('ex', true)
  const [railOpen, setRailOpen] = useStored('rail', true)
  // the side list's width, dragged by its edge and kept per room; unset = the room's explorerWidth or the shell's
  const [exW, setExW] = useStored<Partial<Record<RoomId, number>>>('ex.w', {})
  const exRef = useRef<HTMLElement>(null)
  const mainRef = useRef<HTMLElement>(null)
  const [pal, setPal] = useState(false)
  const [seed, setSeed] = useState('')
  const [island, setIsland] = useState(false)
  const [slot, setSlot] = useState<HTMLDivElement | null>(null)
  const def = rooms.loaded[room]
  const failed = rooms.failed[room]
  // a focused part folds the side list and the rail away without touching their stored choices
  const focus = useFocusOf(room)
  const exShown = focus === 'ex' || (exOpen && !focus)
  useEffect(() => { if (!def) void loadRoom(room) }, [room, def])
  // the other rooms (their badges light the activity bar) load once the first frame is on screen,
  // so their evaluation never delays drawing the room the owner opened
  useEffect(() => afterFirstFrame(() => void loadAll()), [])
  const sync = useSync()
  const onIsland = useCallback((v: boolean) => setIsland(v), [])
  const configAgents = useApi<{ agents: { id: string }[] }>('/api/board/agents', ['config'])
  useEffect(() => { if (configAgents.data) setBadgeIds(configAgents.data.agents.map(a => a.id)) }, [configAgents.data])

  // THE KEYS, all of them (the command bar lists the same set, KEYS in command.ts): Ctrl K or
  // Ctrl P the command bar (Ctrl K stays the shell's kill-line inside a terminal), Ctrl B the
  // side list, Esc closes the bar and the drawer
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase()
      const inTerm = !!(e.target as HTMLElement | null)?.closest?.('.xterm')
      if (e.ctrlKey && !e.altKey && (k === 'p' || (k === 'k' && !inTerm))) { e.preventDefault(); setSeed(''); setPal(p => !p) }
      else if (e.ctrlKey && !e.altKey && k === 'b') { e.preventDefault(); setExOpen(!exOpen) }
      else if (k === 'escape') { if (!pal && !drawer && getFocus()) setFocus(null); setPal(false); openDrawer(null) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [exOpen, setExOpen, openDrawer, pal, drawer])

  const copyLink = useCallback(() => {
    navigator.clipboard.writeText(location.href).then(() => toast('link copied'), (e: Error) => toast(`copy: ${e.message}`, true))
  }, [toast])

  const title = def?.title ?? room
  return (
    <div className={`shell ${exShown ? '' : 'no-ex'} ${railOpen && !focus ? '' : 'no-rail'} ${island ? 'has-island' : ''} ${drawer ? 'has-drawer' : ''} ${focus === 'ex' ? 'focus-ex' : ''}`} style={exStyle(exShown, exW[room], def?.explorerWidth)}>
      <ActivityBar sync={sync} rooms={rooms.loaded} />
      <aside className="ex" ref={exRef}>
        {exShown && !focus && <Edge className="ex-edge" title="the side list's width" min={def?.explorerMin ?? EX_MIN}
          start={() => exRef.current?.getBoundingClientRect().width ?? EX_MIN}
          max={() => (exRef.current?.getBoundingClientRect().width ?? 0) + (mainRef.current?.getBoundingClientRect().width ?? 0) - MAIN_MIN}
          set={w => setExW({ ...exW, [room]: w })} reset={() => { const { [room]: _, ...rest } = exW; setExW(rest) }} />}
        <div className="ex-head"><span>{title}</span><button className="iconbtn" title="Hide (Ctrl+B)" onClick={() => setExOpen(false)}>&lsaquo;</button></div>
        <div className="ex-body">{def ? <Suspense fallback={<Empty state="loading" inline />}><def.Explorer /></Suspense> : !failed && <Empty state="loading" inline />}</div>
      </aside>
      <main className="main" ref={mainRef}>
        <div className="main-head">
          <div className="mh-l">
            {!exShown && !focus && <button className="iconbtn" title="Show list (Ctrl+B)" onClick={() => setExOpen(true)}>&rsaquo;</button>}
            <span className="main-title">{title}</span>
          </div>
          <CommandPill onOpen={(q = '') => { setSeed(q); setPal(true) }} />
          <div className="mh-r">{def?.Head && <Suspense fallback={null}><def.Head /></Suspense>}
            {!railOpen && !focus && <button className="iconbtn" title="Show services" onClick={() => setRailOpen(true)}>&lsaquo;</button>}
          </div>
        </div>
        <div className="main-body">{def
          ? <Suspense fallback={<Empty state="loading" />}><def.Main /></Suspense>
          : failed ? <Empty state="failed">{`${room}: ${failed}`}</Empty> : <Empty state="loading" />}</div>
        {/* the island lives in a band of its own under the room (reserved only while it shows), so
            it never covers a composer, a table's last rows or a board column */}
        <Island onShown={onIsland} />
      </main>
      <ServicesRail onHide={() => setRailOpen(false)} />
      <StatusBar />
      {pal && <Suspense fallback={null}><Palette initial={seed} onClose={() => setPal(false)} actions={{ toggleList: () => setExOpen(!exOpen), toggleRail: () => setRailOpen(!railOpen), sync, copyLink }} /></Suspense>}
      {drawer && <>
        <div className="drawer-veil" onClick={() => openDrawer(null)} />
        <section className="drawer">
          <div className="drawer-head"><div className="drawer-title">{drawer.title}</div><div className="drawer-slot" ref={setSlot} />{drawer.actions}<button className="iconbtn drawer-x" onClick={() => openDrawer(null)} title="Close (Esc)" aria-label="Close"><svg viewBox="0 0 16 16"><path d="M4 4l8 8M12 4l-8 8" /></svg></button></div>
          <DrawerSlot.Provider value={slot}><div className="drawer-body">{drawer.body}</div></DrawerSlot.Provider>
        </section>
      </>}
      <div className="toast-wrap">{toasts.map(t => <div key={t.id} className={`toast ${t.fail ? 'fail' : ''}`}>{t.text}</div>)}</div>
    </div>
  )
}

const EX_MIN = 200
const MAIN_MIN = 360

/** the side list's width: a dragged width (capped so a narrower window still leaves the room its
 *  space), else the room's own, else the stylesheet's default */
function exStyle(open: boolean, dragged: number | undefined, room: string | undefined): CSSProperties | undefined {
  if (!open) return undefined
  if (dragged) return { '--ex-w': `min(${dragged}px, calc(100vw - 60px - var(--rail-w, 264px) - ${MAIN_MIN}px))` } as CSSProperties
  return room ? { '--ex-w': room } as CSSProperties : undefined
}

/** run `f` once the next frame has painted (a rAF, then a task: the frame is on screen by then) */
function afterFirstFrame(f: () => void): () => void {
  let t: ReturnType<typeof setTimeout> | undefined
  const raf = requestAnimationFrame(() => { t = setTimeout(f, 0) })
  return () => { cancelAnimationFrame(raf); if (t) clearTimeout(t) }
}

function RoomButton({ r }: { r: RoomDef }) {
  const { room, go } = useNav()
  const badge = r.useBadge?.() ?? null
  return (
    <button className={`ab-btn ${room === r.id ? 'on' : ''}`} onClick={() => go(r.id)} title={r.title} aria-label={r.title} aria-current={room === r.id ? 'page' : undefined}>
      <span className="ab-tile"><svg viewBox="0 0 24 24">{r.icon}</svg>
        {badge && badge.n > 0 && <span className={`ab-badge ${badge.tone ?? ''}`}>{badge.n > 99 ? '99' : badge.n}</span>}</span>
      <span className="ab-lbl">{r.label.toUpperCase()}</span>
    </button>
  )
}

/** a room whose module has not arrived yet: the same footprint with an empty tile, so nothing
 *  shifts when it lands (a few ms after the first paint) */
function RoomSlot({ id }: { id: RoomId }) {
  const { room, go } = useNav()
  return (
    <button className={`ab-btn ${room === id ? 'on' : ''}`} onClick={() => go(id)} title={id} aria-label={id}>
      <span className="ab-tile"><svg viewBox="0 0 24 24" /></span><span className="ab-lbl">{id.toUpperCase()}</span>
    </button>
  )
}

function useSync() {
  const { toast } = useNav()
  return useCallback(async () => {
    try { const r = await api('/api/git/sync', { body: {} }); toast(r?.summary ?? 'synced') } catch (e: any) { toast(`sync: ${e.message}`, true) }
  }, [toast])
}

function ActivityBar({ sync, rooms }: { sync: () => void; rooms: Partial<Record<RoomId, RoomDef>> }) {
  const { toast } = useNav()
  return (
    <nav className="ab">
      <div className="ab-crest" title="AI Native Hedge Fund">AI</div>
      {ROOM_IDS.map(id => { const r = rooms[id]; return r ? <RoomButton key={id} r={r} /> : <RoomSlot key={id} id={id} /> })}
      <div className="ab-sp" />
      <button className="ab-btn" title="Sync every repo" aria-label="Sync every repo" onClick={sync}>
        <span className="ab-tile"><svg viewBox="0 0 24 24"><path d="M4 12a8 8 0 0 1 14-5l2 2M20 12a8 8 0 0 1-14 5l-2-2" /><path d="M20 4v5h-5M4 20v-5h5" /></svg></span><span className="ab-lbl">SYNC</span>
      </button>
      <button className="ab-btn" title={RELOAD_TIP} aria-label="Reload the UI" onClick={() => void reloadUi(toast)}>
        <span className="ab-tile"><svg viewBox="0 0 24 24"><path d="M20 12a8 8 0 1 1-2.3-5.7L20 8" /><path d="M20 3v5h-5" /></svg></span><span className="ab-lbl">RELOAD</span>
      </button>
    </nav>
  )
}

/** what "ok" means in a folded group's one line */
const OK_WORD: Record<string, string> = { dash: 'up' }

/** a repo row's right-hand reading: counts only (dirty, ahead, behind, conflicts); nothing when clean
 *  or local-only (the word stays in the tooltip); a dim "?" only when its state could not be read */
function repoValue(r: ServiceRow): ReactNode {
  if (r.status === 'unknown') return <span className="rd faint" title={r.reading}>?</span>
  const kept = (r.reading ?? '').split(/\s+-\s+/).filter(p => p && p !== 'clean' && p !== 'local').join(' - ')
  return kept ? <RailValue reading={kept} /> : null
}

const repoColor = (id: string) => (CATEGORIES as Record<string, { color: string }>)[id]?.color ?? UNKNOWN_COLOR

function ServicesRail({ onHide }: { onHide: () => void }) {
  const q = useApi<{ groups: ServiceGroup[] }>('/api/services', ['services', 'health', 'dash', 'git', 'chat', 'config'])
  const { go } = useNav()
  // every card starts as its summary (name, owner count, state bar); a click opens its rows, and
  // what is open is remembered on this machine
  const [open, setOpen] = useStored<Record<string, boolean>>('rail.open', {})
  useEffect(() => { const t = setInterval(q.reload, 30_000); return () => clearInterval(t) }, [q.reload])
  return (
    <aside className="rail">
      <div className="ex-head"><span>Services</span><button className="iconbtn" title="Hide" onClick={onHide}>&rsaquo;</button></div>
      <div className="rail-scroll">
      {q.error && !q.data && <div className="rail-card"><div className="rail-row"><Dot s="fail" /><span className="lbl">fundd unreachable</span></div></div>}
      {!q.error && !q.data && <div className="rail-card"><div className="rail-row"><Dot s="unknown" /><span className="lbl faint">loading</span></div></div>}
      <div className="rail-cards">
        {q.data?.groups.map(grp => {
          const { shown: rows, hidden } = railCard(grp)
          const g = { ...grp, rows }
          const foldable = rows.length > 0
          const shown = foldable && (open[g.id] ?? false)
          const repos = g.id === 'repos'
          const t = railTally(grp.rows)
          const tip = `${g.label}: ${tallyTip(t, OK_WORD[g.id])}${hidden ? `, ${hidden} at zero hidden` : ''}`
          const head = <>
            <span className="rail-nm">{g.label}</span>
            <span className="rail-r">
              {!repos && g.id !== 'dash' && rows.length > 0 && <RowCount rows={rows.length} hidden={hidden} tip={tip} />}
              {t.owner > 0 && <span className={`rail-owner ${t.fail ? 'fail' : 'ask'}`} title={`${t.owner} need you: ${[t.fail && `${t.fail} down`, t.ask && `${t.ask} waiting on you`].filter(Boolean).join(', ')}`}>{t.owner}</span>}
              {foldable && <span className="rail-chev"><svg viewBox="0 0 16 16"><path d="M4 6l4 4 4-4" /></svg></span>}</span>
            {repos ? <RepoSquares rows={grp.rows} /> : g.id === 'dash' ? <DashStat tally={grp.tally} rows={grp.rows} /> : <SegBar t={t} tip={tip} />}
          </>
          return <section className={`rail-card ${foldable && !shown ? 'closed' : ''} ${rows.length ? '' : 'quiet'}`} key={g.id}>
            {foldable
              ? <button className="rail-h rail-fold" aria-expanded={shown} title={shown ? 'fold to one line' : `show all ${rows.length}`} onClick={() => setOpen({ ...open, [g.id]: !shown })}>{head}</button>
              : <div className="rail-h">{head}</div>}
            {shown && rows.length > 0 && <div className="rail-k">{rows.map(r => {
              const rid = r.id.replace(/^repo:/, '')
              return <div className="rail-row" key={r.id} title={[r.reading, r.hint].filter((x, i, a) => x && a.indexOf(x) === i).join('\n')} onClick={() => r.room && go(r.room as any, r.target ?? null)}>
                {repos ? <span className="rail-cdot" style={{ '--c': repoColor(rid) } as CSSProperties} /> : <Dot s={r.status} />}
                <span className="lbl">{r.label}</span>
                {repos ? repoValue(r) : <RailValue reading={r.reading} />}
              </div>
            })}</div>}
          </section>
        })}
      </div>
      </div>
      <Dock />
    </aside>
  )
}

/** a card header's count: how many ROWS the card lists, named as rows so a lone row that reads
 *  "2 due, 1 late" is never taken for one item; the rows hidden at zero follow as a dim +N. One
 *  inline run inside the pill: the pill is a flex box, and a nested span would be its own flex
 *  item (blockified), which wrapped the +N under the count and over the state bar */
function RowCount({ rows, hidden, tip }: { rows: number; hidden: number; tip: string }) {
  return <span className="nchip lbl rail-n" title={tip}>
    <span>{rows} {rows === 1 ? 'row' : 'rows'}{hidden > 0 && <span className="rail-hid"> +{hidden}</span>}</span>
  </span>
}

const SEG_ORDER = ['fail', 'warn', 'ask', 'ok', 'grey'] as const

/** the card header's one state line: a 4px stacked bar, segments fail / warn / ask / ok (then an
 *  honest grey tail for off or unknown rows), widths by count; the tooltip names every count */
function SegBar({ t, tip }: { t: RailTally; tip: string }) {
  const segs = SEG_ORDER.filter(k => t[k] > 0)
  return <span className="rail-bar" title={tip} role="img" aria-label={tip}>
    {segs.length ? segs.map(k => <i key={k} className={k} style={{ flexGrow: t[k] }} />) : <i className="grey" style={{ flexGrow: 1 }} />}
  </span>
}

/** the dashboards card's one status row, set exactly like a rail row: a dot (green when any is up,
 *  dim when none), the word "up" and a right-hand count pill "N/M" from the group's own live tally;
 *  "unknown" (dim) when the count is missing. The tooltip names every counted dashboard and tool */
function DashStat({ tally, rows }: { tally?: string; rows: ServiceRow[] }) {
  const n = dashUp(tally)
  const tip = n ? dashTip(n, rows) : 'the dashboards count could not be read'
  return <span className="rail-row rail-stat" title={tip}>
    <Dot s={n ? (n.up > 0 ? 'ok' : 'off') : 'unknown'} />
    <span className="lbl">up</span>
    {n ? <span className="nchip">{n.up}/{n.total}</span> : <span className="rd">unknown</span>}
  </span>
}

/** the repos card's squares, FU AP PL EX RS: one 18px square per repo in its category colour, a 6px
 *  corner dot for its sync state (green in sync, amber behind or dirty, red conflict, hollow unknown) */
function RepoSquares({ rows }: { rows: ServiceRow[] }) {
  return <span className="rail-repos" role="list" aria-label="repos">
    {repoOrder(rows).map(r => {
      const id = r.id.replace(/^repo:/, '')
      const cat = (CATEGORIES as Record<string, { abbr: string }>)[id]
      const tip = `${r.label}: ${repoStateTip(r)}`
      return <span key={r.id} role="listitem" className={`rail-rq ${repoSync(r)}`} title={tip} aria-label={tip} style={{ '--c': repoColor(id) } as CSSProperties}>
        {cat?.abbr ?? id.slice(0, 2).toUpperCase()}<i />
      </span>
    })}
  </span>
}

function StatusBar() {
  const connected = useConnected()
  const h = useApi<{ started: number }>('/api/health')
  const s = useApi<any>('/api/system/summary', ['chat', 'board', 'dash', 'services'])
  const sch = useApi<{ now: number; stopped: boolean; jobs: SchedJob[] }>('/api/system/schedule', ['system', 'services'])
  const sp = useApi<{ rows: SpendRow[] }>('/api/system/spend', ['system'])
  const { toast, go } = useNav()
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(t) }, [])
  const stop = async () => {
    try { await api('/api/system/stop', { body: {} }); toast('stopped every agent and job') } catch (e: any) { toast(`stop: ${e.message}`, true) }
  }
  const d = s.data
  const stopped = sch.data?.stopped || d?.nextJob === 'stopped'
  const nj = sch.data && !stopped ? nextJobOf(sch.data.jobs, now) : null
  const week = spendWeek(sp.data?.rows, new Date(now))
  return (
    <footer className="sb">
      <span className="sb-chip sb-live" title={connected && h.data ? `fundd started ${relTime(h.data.started)}` : 'the event stream to fundd is down'}>
        <Dot s={connected ? 'ok' : 'fail'} />{connected ? <>fundd{h.data && <b>up {relTime(h.data.started)}</b>}</> : <b className="fail">fundd offline</b>}
      </span>
      <CodeChip />
      {stopped
        ? <span className="sb-chip warn" title="floor/STOP holds every job">jobs <b>stopped</b></span>
        : nj
          ? <button className="sb-chip" onClick={() => go('system', 'schedule')} title={`${nj.id} runs in ${fmtIn(nj.inMs)}${nj.frac === null ? '' : `, ${Math.round(nj.frac * 100)}% of its cycle gone`}`}>
              {nj.frac !== null && <Ring frac={nj.frac} />}next <b>{nj.id}</b><span className="sb-num">{fmtIn(nj.inMs)}</span>
            </button>
          : d?.nextJob && <span className="sb-chip">next <b>{d.nextJob}</b></span>}
      {d?.spendToday && <button className="sb-chip" onClick={() => go('system', 'spend')} title={week ? `billable tokens, last 7 days: ${week.map(fmtTokens).join(' · ')}` : 'billable tokens today (a 7-day line draws once 7 days are recorded)'}>
        today <b>{d.spendToday}</b>{week && <svg className="sb-spark" viewBox="0 0 36 12" preserveAspectRatio="none"><polyline points={sparkPoints(week, 36, 12)} /></svg>}
      </button>}
      <span className="sb-sp" />
      <button className="sb-stop" onClick={stop} title="Stop every agent and every scheduled job">STOP</button>
    </footer>
  )
}

/** landed but not live (B-0174): when dist/ was built and the newest commit landed, warn when dist/
 *  is older than the newest UI commit or fundd older than the newest server commit (server/uibuild.ts
 *  liveTell); fundd's own start is the chip beside it. Unknown until read, never a guessed "live" */
function CodeChip() {
  const q = useApi<LiveTimes>('/api/health/live', ['git'])
  const { toast } = useNav()
  useEffect(() => { const t = setInterval(q.reload, 60_000); return () => clearInterval(t) }, [q.reload])
  const d = q.data
  useUiFresh(d?.serveDist ? d.dist : null)
  // B-0254: the owner's restart - at the next idle moment, skipping the batch window, never cutting a turn
  const restartNow = async () => {
    try {
      const r = await api<{ tick: string; waitingOn: string[] }>('/api/restart', { body: {} })
      toast(r.tick === 'restarting' ? 'fundd restarting: the open conversations reopen' : `fundd restarts once idle: ${r.waitingOn.join('; ') || 'waiting'}`)
    } catch (e: any) { toast(`restart: ${e.message}`, true) }
    q.reload()
  }
  if (!d) return q.error ? <span className="sb-chip" title={`the build and commit times could not be read: ${q.error}`}>code <b>?</b></span> : null
  const stale = d.uiStale || d.serverStale
  const tip = [
    `fundd started ${stamp(d.started)}${d.serverStale ? `, BEFORE the newest server commit: ${restartLine(d.restart)}` : ''}`,
    d.serveDist ? `dist/ built ${d.dist ? stamp(d.dist) : 'never'}${d.uiStale ? ', BEFORE the newest UI commit: fundd rebuilds it by itself within a minute (or Reload now)' : ''}` : 'dist/ not served: vite serves the source (dev)',
    `newest commit ${d.head ? stamp(d.head) : 'unread'} (UI ${d.uiCommit ? stamp(d.uiCommit) : 'unread'}, server ${d.serverCommit ? stamp(d.serverCommit) : 'unread'})`,
  ].join('\n')
  const body = <>
    {d.serveDist && <>dist <b>{d.dist ? relTime(d.dist) : 'none'}</b>{' '}</>}commit <b>{relTime(d.head)}</b>
    {stale && <>{' '}<b>{d.uiStale && d.serverStale ? 'ui + fundd stale' : d.uiStale ? 'ui stale' : 'fundd stale'}</b></>}
  </>
  if (d.serverStale && d.restart?.supervised && !d.restart.restarting)
    return <button className="sb-chip warn" onClick={() => void restartNow()} title={`${tip}\nclick: ${d.restart.requested ? 'asked already: ' : ''}restart fundd at the next idle moment (skips the batch window, never cuts a running turn)`}>{body}</button>
  return <span className={`sb-chip ${stale ? 'warn' : ''}`} title={tip}>{body}</span>
}
type LiveTimes = { serveDist: boolean; started: number; dist: number | null; uiCommit: number | null; serverCommit: number | null; head: number | null; uiStale: boolean; serverStale: boolean; restart?: RestartStatus }
type RestartStatus = { supervised: boolean; waitingOn: string[]; restarting: boolean; requested?: boolean; batchUntil?: number | null }
/** what the idle restart (server/restart.ts) is doing about new server code, in one line */
function restartLine(r: RestartStatus | undefined): string {
  if (!r) return 'restart fundd to run it'
  if (r.restarting) return 'fundd is restarting now'
  if (!r.supervised) return 'restart fundd to run it (no supervisor here: start.cmd restarts on its own when idle)'
  return r.waitingOn.length ? `fundd restarts at the next idle moment, waiting on: ${r.waitingOn.join('; ')}` : 'fundd restarts at the next idle moment'
}

/** the next job's ring: how much of the gap from its last scheduled occurrence to the next has gone */
function Ring({ frac }: { frac: number }) {
  const r = 4.2, c = 2 * Math.PI * r
  return <svg className="sb-ring" viewBox="0 0 12 12" aria-hidden><circle cx="6" cy="6" r={r} /><circle className="on" cx="6" cy="6" r={r} strokeDasharray={`${(frac * c).toFixed(2)} ${c.toFixed(2)}`} /></svg>
}

const fmtTokens = (n: number) => n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : `${n}`
