import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import type { RoomDef } from '../types.ts'
import { Btn, Chip, Dot, Empty, Glyph, Group, Icon, Load, Pill, Skeleton, Sq, markOf } from '../../ui/kit.tsx'
import { RailValue } from '../../ui/value.tsx'
import { repoVar } from './repo.ts'
import { parseShow, shortSubject, splitSubject, type Show } from './show.ts'
import { eraRange, eraSpan, type Era } from './eras.ts'
import { Lands, NewBranchHead } from './Branches.tsx'
import { DayBars, OTHER, Spark, seriesColor, seriesName } from './charts.tsx'
import { isKnownAgent } from '../../ui/categories.ts'
import { api, relTime, stamp, useApi, useStored } from '../../lib/api.ts'
import { useNav, useSel } from '../../shell/nav.tsx'
import { DrawerHead, KvCards, Sec } from '../drawers/index.tsx'
import './git.css'

// ROOM: git - every repo in repos.json: cards, build branches + the land queue, the log with trailers, sync.

type State = { branch: string | null; upstream: string | null; dirty: number; conflicts: number; midOp: string | null; ahead: number | null; behind: number | null; head: { sha: string; subject: string; ts: number; author: string } | null; error?: string }
type Guard = { state: 'guarded' | 'open' | 'foreign' | 'missing' | 'unknown'; detail: string }
type Card = { id: string; path: string; holds: string; guarded?: boolean; state: State; tone: string; reading: string; fetchedAt: number | null; guard?: Guard }
type Conv = { id: string; last: number; n: number; agent: string | null; title: string | null }

const GUARD_TONE: Record<Guard['state'], string> = { guarded: 'ok', open: 'warn', foreign: 'warn', missing: 'fail', unknown: '' }
const GUARD_TIP = 'pre-commit: agent writes scope, api/execution, secrets; library book without its _series.md warns. commit-msg: Agent + Conversation trailers; a library book losing > 30% of its lines or ## sections warns unless a Consolidation: trailer declares it'

type Commit = { repo: string; sha: string; author: string; ts: number; subject: string; body: string; files: string[]; trailers: { agent: string | null; conversation: string | null; why: string | null; changeId: string | null; all: Record<string, string> }; shrink?: Shrink | null; nfiles?: number }
type Shrink = { files: { path: string; linesPct: number; sectionsPct: number; lostHeadings: string[]; renamedHeadings?: { from: string; to: string }[]; deleted: boolean }[]; worst: number | null; ok: boolean; reason: string | null }

const hasShrink = (c: Commit) => (c.shrink?.files.length ?? 0) > 0
/** "fund (fixer round 1)" -> "fund": an Agent trailer names the agent first, any note after it */
export const agentIdOf = (t: string) => t.trim().split(/\s+/)[0]

/** the tooltip: every flagged book, what it lost, and the Consolidation reason when declared */
export function shrinkTip(s: Shrink): string {
  const lines = s.files.map(f => `${f.path}  ${f.deleted ? 'deleted' : `${f.linesPct}% lines, ${f.sectionsPct}% sections`}${f.lostHeadings.length ? `\n  lost: ${f.lostHeadings.map(h => `## ${h}`).join(', ')}` : ''}${f.renamedHeadings?.length ? `\n  renamed: ${f.renamedHeadings.map(r => `## ${r.from} -> ## ${r.to}`).join(', ')}` : ''}`)
  return [s.ok ? `Consolidation: ${s.reason}` : 'book shrink, no Consolidation: trailer', ...lines].join('\n')
}

/** red = a book lost > 30% with no Consolidation trailer; dim grey = declared a consolidation */
function ShrinkChip({ s }: { s?: Shrink | null }) {
  if (!s || !s.files.length) return null
  // labelled: the chip says what shrank, a book deleted outright says so instead of "-100%"
  return <span className={`tag ${s.ok ? '' : 'fail'}`} title={shrinkTip(s)}>{s.files.every(f => f.deleted) ? 'book gone' : `book ${s.worst ?? -100}%`}</span>
}

const useRepos = () => useApi<{ repos: Card[] }>('/api/git/repos', ['git'])

const useEras = () => useApi<{ series: string; eras: Era[] }>('/api/git/eras', ['git', 'library'])

/** the era band: one chip per annals book; click filters the log to its range, again clears */
type EraSel = { era: string; setEra: (id: string) => void }

function Eras({ era, setEra }: EraSel) {
  const q = useEras()
  const { go } = useNav()
  if (q.error && !q.data) return <div className="git-eras"><Empty inline state="failed">{`eras: ${q.error}`}</Empty></div>
  if (!q.data) return <div className="git-eras"><Skeleton kind="lines" n={1} /></div>
  const d = q.data
  if (!d.eras.length) return <div className="git-eras"><Empty inline title="NO ERAS">{`no era books in ${d.series}`}</Empty></div>
  // one full-width timeline: each era a segment sized by its commits (min 72px so a small era reads)
  return <div className="git-eras" role="group" aria-label="eras">
    {d.eras.map(e => {
      if (e.error) return <div key={e.id} className="git-era bad" style={{ flexGrow: 1 }} title={[e.book, e.error].join('\n')}>
        <span className="git-era-t">{e.title ?? e.id}</span><span className="git-era-seg"><span className="git-era-s">bad frontmatter</span></span></div>
      const on = era === e.id
      const counts = Object.entries(e.counts)
      const total = counts.reduce((t, [, n]) => t + (n ?? 0), 0)
      const unknown = counts.some(([, n]) => n == null)
      const live = e.to === 'open'
      return <div key={e.id} role="button" tabIndex={0} aria-pressed={on} className={`git-era ${on ? 'on' : ''} ${live ? 'open' : ''}`} style={{ flexGrow: Math.max(1, total) }}
        title={[`${e.title}  ${eraSpan(e.from!, e.to!)}`, `first ${e.from}`, `last ${live ? 'now (open)' : e.to}`, `${unknown ? '? (a repo count is unknown)' : total} commit${total === 1 ? '' : 's'}`,
          ...counts.map(([r, n]) => `  ${r} ${n ?? 'unknown'}`), on ? 'click to clear' : 'click to filter the log'].join('\n')}
        onClick={() => setEra(on ? '' : e.id)} onKeyDown={k => { if (k.key === 'Enter' || k.key === ' ') { k.preventDefault(); setEra(on ? '' : e.id) } }}>
        <span className="git-era-t"><span className="git-era-tt">{e.title}</span>
          {on && <button className="lnk git-era-book" title={e.book} onClick={ev => { ev.stopPropagation(); go('library', e.book) }}>book</button>}</span>
        <span className="git-era-seg">
          <EraCounts counts={counts} total={total} />
          <span className="git-era-n">{unknown ? '?' : total}</span>
          {live && <span className="git-era-now"><i />now</span>}
        </span>
      </div>
    })}
  </div>
}

/** an era's commits per repo as one stacked bar in the repos' category colours; unknown counts leave
 *  their share out (the total beside it reads "?", never 0) */
function EraCounts({ counts, total }: { counts: [string, number | null][]; total: number }) {
  return <span className="git-era-bar">{total > 0 && counts.filter(([, n]) => n).map(([r, n]) =>
    <i key={r} style={{ ...repoVar(r), width: `${(n! / total) * 100}%` }} />)}</span>
}

let syncBusy = false
async function sync(repo: string | undefined, toast: (t: string, fail?: boolean) => void, setBusy: (b: boolean) => void) {
  if (syncBusy) return
  syncBusy = true; setBusy(true)
  try {
    const r = await api<{ summary: string; repos: { id: string; action: string; note: string }[] }>('/api/git/sync', { body: repo ? { repo } : {} })
    const bad = r.repos.some(x => x.action === 'failed')
    toast(repo ? `${repo}: ${r.repos[0]?.note ?? r.summary}` : r.summary, bad)
  } catch (e: any) { toast(`sync: ${e.message}`, true) } finally { syncBusy = false; setBusy(false) }
}

/** where a card's branch tracks, for its tooltip; a branch with no remote shows a "local" chip instead */
const trackTip = (c: Card) => c.state.upstream
  ? `tracks ${c.state.upstream}\n${c.fetchedAt ? `last fetch from this daemon ${relTime(c.fetchedAt)} (${stamp(c.fetchedAt)})` : 'not fetched by this daemon yet'}`
  : 'the branch tracks no remote: nothing to fetch, pull or push'

/** "app: the fix" in the app row -> "the fix": the REPO column already says it */
export function dropRepoPrefix(subject: string, repo: string): string {
  const m = /^([a-z0-9_.-]+):\s+/i.exec(subject)
  return m && m[1].toLowerCase() === repo.toLowerCase() && subject.length > m[0].length ? subject.slice(m[0].length) : subject
}

/** commits per local day per repo and per agent (server/git/activity.ts); null counts = git could not say */
type Act = { days: string[]; repos: { id: string; total: number[] | null; agents: Record<string, number[]> | null }[] }
const useActivity = (range: { since: string; until: string } | null) =>
  useApi<Act>(`/api/git/activity${range ? `?since=${range.since}&until=${range.until}` : ''}`, ['git'])

/** a card's state as count pills: ahead, behind, dirty, conflicts, a stopped operation. Nothing when
 *  clean: the dot beside the name already says it (measured) */
function StateBadges({ s }: { s: State }) {
  return <span className="git-badges">
    {s.midOp && <Pill tone="fail" title={`a ${s.midOp} is stopped in this tree: the owning hand settles it`}>{s.midOp}</Pill>}
    {s.conflicts > 0 && <Pill tone="fail" title={`${s.conflicts} conflicted file${s.conflicts === 1 ? '' : 's'}`}>!{s.conflicts}</Pill>}
    {(s.ahead ?? 0) > 0 && <Pill title={`${s.ahead} commit${s.ahead === 1 ? '' : 's'} not on ${s.upstream}: push`}>↑{s.ahead}</Pill>}
    {(s.behind ?? 0) > 0 && <Pill tone="warn" title={`${s.behind} commit${s.behind === 1 ? '' : 's'} on ${s.upstream} not here: pull`}>↓{s.behind}</Pill>}
    {s.dirty > 0 && <Pill tone="warn" title={`${s.dirty} uncommitted file${s.dirty === 1 ? '' : 's'}`}>~{s.dirty}</Pill>}
  </span>
}

/** the commit guard as a lock: green only when read as guarded; absent = this daemon did not report one */
function GuardMark({ g }: { g?: Guard }) {
  const tone = g ? GUARD_TONE[g.state] || 'unknown' : 'unknown'
  const word = !g ? 'unknown' : g.state === 'open' ? 'unguarded' : g.state
  return <span className={`git-lock ${tone}`} title={`commit guard: ${word}${g ? `\n${g.detail}` : '\nnot reported by this daemon'}\n${GUARD_TIP}`}><Icon name="lock" /></span>
}

function Cards() {
  const q = useRepos()
  const act = useActivity(null)
  const [sel, setSel] = useSel('git')
  const { toast } = useNav()
  const [busy, setBusy] = useState<string | null>(null)
  return <Load q={q} skel="cards" empty={d => d.repos.length === 0}>{d => <div className="git-cards">
    {d.repos.map(c => {
      const a = act.data?.repos.find(x => x.id === c.id)
      const n = a?.total ? a.total.reduce((x, y) => x + y, 0) : null
      const who = c.state.head ? agentIdOf(c.state.head.author) : null
      return <div key={c.id} className={`card hov edge git-card ${sel === c.id ? 'on' : ''}`} style={repoVar(c.id)} onClick={() => setSel(sel === c.id ? null : c.id)}
        title={[c.holds, c.path, trackTip(c)].filter(Boolean).join('\n')}>
        <div className="git-card-h"><Dot s={c.tone} title={c.reading} /><span className="git-name">{c.id}</span><span className="sp" />
          <GuardMark g={c.guard} />
          <span onClick={e => e.stopPropagation()}><Btn sm kind="ghost" disabled={!!busy || !c.state.upstream}
            title={c.state.upstream ? `sync ${c.id}: fetch; pull --rebase if clean and behind; push if clean and ahead` : 'no remote to sync with'}
            onClick={() => { setBusy(c.id); sync(c.id, toast, b => !b && setBusy(null)) }}>{busy === c.id ? '...' : 'sync'}</Btn></span></div>
        <div className="git-card-s"><span className="git-br mono" title={trackTip(c)}>{c.state.branch ?? '-'}</span>
          {!c.state.upstream && !c.state.error && <span className="tag faint" title={trackTip(c)}>local</span>}
          {c.state.error && <span className="tag fail" title={c.state.error}>error</span>}
          <span className="sp" /><StateBadges s={c.state} /></div>
        <div className="git-card-a" title={act.error && !act.data ? `activity: ${act.error}` : undefined}>
          {act.data ? <Spark counts={a?.total ?? null} days={act.data.days} /> : <span className="git-spark-wait" />}
          <span className="git-card-n" title={n == null ? 'commits in 14 days: unknown' : `${n} commit${n === 1 ? '' : 's'} in ${act.data?.days.length ?? 14} days`}>{n ?? ''}</span>
        </div>
        <div className="git-foot">
          {c.state.head ? <span className="git-head" title={`${c.state.head.sha}\n${c.state.head.subject}\n${stamp(c.state.head.ts)}`}>
            <Glyph id={who ?? 'you'} /><span className="git-sha">{c.state.head.sha.slice(0, 7)}</span><span>{relTime(c.state.head.ts)}</span></span>
            : <span className="nil" title="no head commit" />}
          <span className="sp" />
          {c.state.upstream && <span className="git-fetch" title={trackTip(c)}><Icon name="clock" />{c.fetchedAt ? relTime(c.fetchedAt) : <span className="nil" />}</span>}
        </div>
      </div>
    })}
  </div>}</Load>
}

/** the diffstat as green / red bars with their counts; bars share one scale (the largest file) */
function Stat({ s }: { s: Show }) {
  if (!s.stat.length) return null
  const max = Math.max(1, ...s.stat.map(r => r.n))
  return <table className="git-stat"><tbody>
    {s.stat.map(r => <tr key={r.path}>
      <td className="mono git-stat-p" title={r.path}>{r.path}</td>
      <td className="num">{r.bin ? <span className="faint">bin</span> : r.n}</td>
      <td className="git-stat-b" title={r.bin ? 'binary' : `+${r.plus} -${r.minus} (split read from git's stat bar)`}>{!r.bin && <span className="git-bars"><i className="p" style={{ width: `${r.plus / max * 100}%` }} /><i className="m" style={{ width: `${r.minus / max * 100}%` }} /></span>}</td>
    </tr>)}
    {s.totals && <tr className="git-stat-t"><td className="mono faint">{s.totals.files} file{s.totals.files === 1 ? '' : 's'}</td><td colSpan={2} className="mono"><span className="t-ok">+{s.totals.plus}</span> <span className="t-fail">-{s.totals.minus}</span></td></tr>}
  </tbody></table>
}

/** the commit message, three lines and a fade; "+N lines" opens the rest, so FILES sits above the fold */
function Msg({ s }: { s: Show }) {
  const ref = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [more, setMore] = useState(0)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el || open) return
    const lh = parseFloat(getComputedStyle(el).lineHeight) || 19
    setMore(Math.max(0, Math.round((el.scrollHeight - el.clientHeight) / lh)))
  }, [s, open])
  if (s.blocks.length === 0) return <div className="git-msg"><span className="nil" title="no message body" /></div>
  return <>
    <div ref={ref} className={`git-msg ${open ? 'open' : more ? 'clamp' : ''}`} title={s.subject}>
      {s.blocks.map((b, i) => b.kind === 'li' ? <div key={i} className="git-li">{b.text}</div> : <p key={i}>{b.text}</p>)}
    </div>
    {(more > 0 || open) && <button className="lnk dim git-more" onClick={() => setOpen(!open)} aria-expanded={open} title={open ? 'Collapse' : 'Show the whole message'}>
      {open ? '▴ less' : `▾ +${more} line${more === 1 ? '' : 's'}`}</button>}
  </>
}

function CommitBody({ c, known = true }: { c: Commit; known?: boolean }) {
  const q = useApi<{ text: string }>(`/api/git/show?repo=${c.repo}&sha=${c.sha}`)
  const { go, openDrawer, toast } = useNav()
  const conv = c.trailers.conversation
  const show = useMemo(() => q.data ? parseShow(q.data.text) : null, [q.data])
  const agent = c.trailers.agent ? agentIdOf(c.trailers.agent) : null
  // co-authored-by is a small bot mark beside the author, not a row
  const bots = Object.entries(c.trailers.all).filter(([k]) => k.toLowerCase() === 'co-authored-by').map(([, v]) => v)
  const bot = bots.length > 0 && <> <Icon name="bot" tone="faint" title={`co-authored by ${bots.join(', ')}`} /></>
  const t = Object.entries(c.trailers.all).filter(([k]) => !['conversation', 'co-authored-by', 'agent'].includes(k.toLowerCase()))
  const tot = show?.totals
  return <div className="git-detail">
    <DrawerHead agent={agent ?? 'you'} known={!agent || known} title={<span title={c.subject}>{dropRepoPrefix(c.subject, c.repo)}</span>}
      sub={<span title={stamp(c.ts)}>{`${c.repo} · ${c.sha.slice(0, 7)} · ${relTime(c.ts)}`}</span>}
      chips={[
        { k: 'FILES', v: c.nfiles ?? c.files.length, title: `${c.nfiles ?? c.files.length} file${(c.nfiles ?? c.files.length) === 1 ? '' : 's'} changed` },
        { k: '+/-', v: tot ? <><span className="t-ok">+{tot.plus}</span> <span className="t-fail">-{tot.minus}</span></> : null, title: tot ? `+${tot.plus} -${tot.minus} lines` : q.error ? `git show failed: ${q.error}` : 'reading git show' },
        { k: 'AGENT', v: c.trailers.agent ? agent : 'you', title: c.trailers.agent ? `Agent: ${c.trailers.agent}` : 'no Agent trailer: the owner' },
      ]} />
    <KvCards cards={[
      { title: 'Identity', rows: [
        ['repo', <span className="mono">{c.repo}</span>],
        ['sha', <span className="mono"><span title={c.sha}>{c.sha.slice(0, 7)}</span> <button className="iconbtn git-copy" title={`Copy ${c.sha}`} aria-label="copy sha"
          onClick={() => { void navigator.clipboard?.writeText(c.sha).then(() => toast('sha copied'), () => toast('copy refused', true)) }}><Icon name="copy" /></button></span>],
        ['by', <span className="mono">{c.trailers.agent ?? 'you'}{bot}</span>],
        ['when', <span className="mono">{stamp(c.ts)}</span>],
        conv ? ['conversation', <button className="lnk mono" title="open this conversation in Chats" onClick={() => { openDrawer(null); go('chats', conv) }}>{conv}</button>] : null,
      ] },
      { title: 'Trailers', wide: t.length > 2, rows: [
        hasShrink(c) && ['shrink', <><ShrinkChip s={c.shrink} /> <span className="faint git-shr-files">{c.shrink!.files.map(f => f.path).join(', ')}</span></>],
        ...t.map(([k, v]): [string, ReactNode] => [k.toLowerCase(), <span className="mono">{v}</span>]),
      ] },
    ]} />
    <Load q={q} skel="lines">{() => show && <>
      {show.blocks.length > 0 && <><Sec>Message</Sec><Msg s={show} /></>}
      {show.stat.length > 0 && <><Sec>Files</Sec><Stat s={show} /></>}
    </>}</Load>
  </div>
}

/** the Agent filter value against a commit: '-' = no Agent trailer; an agent id matches the trailer's
 *  first word (an older stored value, a whole trailer, still matches exactly) */
export const agentMatch = (want: string, trailer: string | null, known: Set<string> | null = null) => {
  if (!want) return true
  if (want === '-') return !trailer
  if (!trailer) return false
  if (want === OTHER) return !inRoster(agentIdOf(trailer), known)
  return trailer === want || agentIdOf(trailer) === want
}

/** an agent id the roster answers to (before the roster is read, the category rule decides) */
const inRoster = (id: string, known: Set<string> | null) => known ? known.has(id) : isKnownAgent(id)

type Range = { since: string; until: string } | null

/** commits per day by agent over the log's scope (the selected repo, the era's days or the last 14);
 *  each agent a chip: its colour, its two letters and its count; a click filters the log to it. Ids no
 *  roster agent answers to fold into ONE neutral "other" series, never letters that pose as an agent */
function DayChart({ sel, range, agent, setAgent, known }: { sel: string | null; range: Range; agent: string; setAgent: (a: string) => void; known: Set<string> | null }) {
  const q = useActivity(range)
  const d = q.data
  const { series, others } = useMemo(() => {
    if (!d) return { series: [], others: '' }
    const m = new Map<string, number[]>()
    const strays = new Set<string>()
    for (const r of d.repos) {
      if (sel && r.id !== sel) continue
      for (const [raw, xs] of Object.entries(r.agents ?? {})) {
        const id = raw === '-' || inRoster(raw, known) ? raw : OTHER
        if (id === OTHER) strays.add(raw)
        const acc = m.get(id) ?? d.days.map(() => 0)
        xs.forEach((n, i) => { acc[i] += n })
        m.set(id, acc)
      }
    }
    const series = [...m.entries()].map(([id, counts]) => ({ id, counts, n: counts.reduce((a, b) => a + b, 0) }))
      .sort((a, b) => b.n - a.n || a.id.localeCompare(b.id))
    return { series, others: [...strays].sort().join(', ') }
  }, [d, sel, known])
  if (q.error && !d) return <div className="card git-act"><Empty inline state="failed">{`activity: ${q.error}`}</Empty></div>
  if (!d) return <div className="card git-act"><Skeleton kind="lines" n={2} /></div>
  const scope = d.repos.filter(r => !sel || r.id === sel)
  const unread = scope.filter(r => !r.agents).map(r => r.id)
  if (scope.length && unread.length === scope.length) return <div className="card git-act"><Empty inline state="unknown">{`git could not read the log of ${unread.join(', ')}`}</Empty></div>
  const peers = series.map(s => s.id)
  const pick = (id: string) => setAgent(agent === id ? '' : id)
  const stray = agent && !series.some(s => s.id === agent)
  return <div className="card git-act">
    <DayBars days={d.days} series={series} focus={series.some(s => s.id === agent) ? agent : ''} onPick={pick} />
    <div className="git-legend">
      {series.map(s => <Chip key={s.id} sm on={agent === s.id} onClick={() => pick(s.id)}
        title={`${seriesName(s.id)}: ${s.n} commit${s.n === 1 ? '' : 's'} in these ${d.days.length} days${s.id === OTHER ? `\n${others}` : ''}\n${agent === s.id ? 'click to clear' : 'click to filter the log'}`}>
        <i className="git-sw" style={{ background: seriesColor(s.id, peers) }} />{s.id === '-' ? '?' : s.id === OTHER ? 'other' : markOf(s.id)}<b>{s.n}</b></Chip>)}
      {stray && <Chip sm on onClick={() => setAgent('')} title="the log is filtered to an agent with no commit in these days: click to clear">{agent === '-' ? '?' : agentIdOf(agent)} <Icon name="x" /></Chip>}
      {unread.length > 0 && <span className="tag none" title={`git could not read ${unread.join(', ')}: their commits are not in the chart`}>{unread.length} unread</span>}
      {!series.length && !unread.length && <span className="faint git-legend-0" title="no commit in these days">0</span>}
    </div>
  </div>
}

type LogData = { commits: Commit[]; total: number; scope: number; shrink: number; offset: number; agents: string[]; conversations?: Conv[]; capped?: string[] }
/** rows per "More": the server filters the whole history, this only sets how much of it is drawn */
const PAGE = 100

/** j / k (or the arrows) move between focusable rows of the same list; Enter opens the one in focus */
export function rowKeys(e: KeyboardEvent<HTMLElement>, open: () => void) {
  const el = e.currentTarget
  const step = e.key === 'j' || e.key === 'ArrowDown' ? 1 : e.key === 'k' || e.key === 'ArrowUp' ? -1 : 0
  if (e.key === 'Enter') { e.preventDefault(); open(); return }
  if (!step) return
  e.preventDefault()
  const next = (step > 0 ? el.nextElementSibling : el.previousElementSibling) as HTMLElement | null
  next?.focus()
}

function Log({ era, setEra }: EraSel) {
  const [sel] = useSel('git')
  const [agent, setAgent] = useStored<string>('git.agent', '')
  const [conv, setConv] = useStored<string>('git.conv', '')
  const [shrink, setShrink] = useStored<boolean>('git.shrink', false)
  const [text, setText] = useState('')
  const [find, setFind] = useState('')
  const [pages, setPages] = useState(1)
  const box = useRef<HTMLInputElement>(null)
  useEffect(() => { const t = setTimeout(() => setFind(text.trim()), 250); return () => clearTimeout(t) }, [text])
  // "/" puts the cursor in the search box, from anywhere in the room that is not already an input
  useEffect(() => {
    const on = (e: globalThis.KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey || (t && (t.closest('input, textarea, select, [contenteditable]')))) return
      if (!box.current?.offsetParent) return
      e.preventDefault(); box.current.focus(); box.current.select()
    }
    window.addEventListener('keydown', on)
    return () => window.removeEventListener('keydown', on)
  }, [])
  const eras = useEras()
  const range = eraRange(eras.data?.eras, era)
  const key = [sel, range?.since, range?.until, agent, conv, shrink, find].join('|')
  useEffect(() => { setPages(1) }, [key])
  const qs = new URLSearchParams()
  if (sel) qs.set('repo', sel)
  if (range) { qs.set('since', range.since); qs.set('until', range.until) }
  if (agent) qs.set('agent', agent)
  if (conv) qs.set('conversation', conv)
  if (shrink) qs.set('shrink', '1')
  if (find) qs.set('q', find)
  qs.set('limit', String(PAGE * pages))
  const q = useApi<LogData>(`/api/git/log?${qs}`, ['git'])
  // "More" only lengthens the same query: the rows already drawn stay while the longer page loads
  const last = useRef<{ key: string; d: LogData } | null>(null)
  if (q.data) last.current = { key, d: q.data }
  const d = q.data ?? (last.current?.key === key ? last.current.d : null)
  // an Agent trailer naming no agent in the roster wears a neutral mark, never a category's colour
  const config = useApi<{ agents: { id: string }[] }>('/api/chats/agents', ['config'])
  const known = useMemo(() => config.data ? new Set(config.data.agents.map(a => a.id)) : null, [config.data])
  const { openDrawer } = useNav()
  const rows = d?.commits ?? []
  const eraOn = range ? eras.data?.eras.find(x => x.id === era) : undefined
  const convs = d?.conversations ?? []
  const convLabel = (x: Conv) => `${x.title ?? x.id}${x.agent ? ` - ${x.agent}` : ''} (${x.n})`
  const on = [era, agent, conv, shrink, find].filter(Boolean).length
  const clear = () => { setEra(''); setAgent(''); setConv(''); setShrink(false); setText(''); setFind('') }
  const open = (c: Commit) => openDrawer({ title: <span title={c.subject}>{shortSubject(c.subject)}</span>, body: <CommitBody c={c} known={!c.trailers.agent || !known || known.has(agentIdOf(c.trailers.agent))} /> })
  const more = d ? d.total - rows.length : 0
  return <section className="git-log">
    <div className="git-bar">
      <span className="cap">Log</span>
      <span className="git-find">
        <input ref={box} className="input" value={text} placeholder="Search" spellCheck={false}
          title={'subject, message, file path or sha; every word must match. "/" to focus, Esc to clear'}
          onChange={e => setText(e.target.value)} onKeyDown={e => { if (e.key === 'Escape') { setText(''); setFind(''); e.currentTarget.blur() } }} />
        {text && <button className="iconbtn" title="clear the search" aria-label="clear the search" onClick={() => { setText(''); setFind('') }}><Icon name="x" /></button>}
      </span>
      {eraOn && <button className="chip sm on git-era-x" title="clear the era filter" onClick={() => setEra('')}>{eraOn.title} <Icon name="x" /></button>}
      <span className="sp" />
      <select className="input git-sel git-sel-conv" value={conv} onChange={e => setConv(e.target.value)} title="Conversation trailer">
        <option value="">Chat</option>
        <option value="-">no Conversation trailer</option>
        {conv && conv !== '-' && !convs.some(x => x.id === conv) && <option value={conv}>{conv}</option>}
        {convs.map(x => <option key={x.id} value={x.id} title={x.id}>{convLabel(x)}</option>)}
      </select>
      <Chip sm on={shrink} onClick={() => setShrink(!shrink)} title="only commits where a library book lost > 30% of its lines or ## sections">Shrink {d ? d.shrink : ''}</Chip>
      {on > 0 && <Chip sm onClick={clear} title="clear the era, agent, chat, shrink and search filters">Clear {on}</Chip>}
      <span className="faint mono git-n" title={d ? `${rows.length} drawn of ${d.total} matching; ${d.scope} in ${sel ?? 'every repo'}${range ? ` from ${range.since} to ${range.until}` : ''}${d.capped?.length ? `\nread up to the newest 5000 of ${d.capped.join(', ')}` : ''}` : ''}>
        {d ? (d.total === d.scope ? `${d.total}` : `${d.total} of ${d.scope}`) : ''}</span>
    </div>
    <DayChart sel={sel} range={range} agent={agent} setAgent={setAgent} known={known} />
    {!d ? <Load q={q} skel="table">{() => null}</Load> : rows.length === 0 ? <Empty>{find ? `nothing matches "${find}"` : shrink ? 'no book shrank' : 'no commit matches'}</Empty> : <>
      <table className="tbl dense git-tbl">
        <tbody>{rows.map(c => {
          const aid = c.trailers.agent ? agentIdOf(c.trailers.agent) : null
          const isKnown = !!aid && (!known || known.has(aid))
          const subj = splitSubject(dropRepoPrefix(c.subject, c.repo))
          const nf = c.nfiles ?? c.files.length
          return <tr key={c.repo + c.sha} className="click" tabIndex={0} title={[c.subject, c.trailers.why && `Why: ${c.trailers.why}`].filter(Boolean).join('\n')}
            onClick={() => open(c)} onKeyDown={e => rowKeys(e, () => open(c))}>
            {!sel && <td className="git-rr" style={repoVar(c.repo)} title={c.repo}><i /></td>}
            <td className="git-agent" title={aid ? `Agent: ${c.trailers.agent}${isKnown ? '' : ' (not in the roster: author unknown)'}` : 'no Agent trailer: author unknown'}>
              {isKnown ? <Glyph id={aid!} /> : <Sq tone="unk">?</Sq>}</td>
            <td className="fill git-subj">{subj.prefix && <span className="git-subj-p">{subj.prefix}</span>}{subj.rest}</td>
            <td className="git-shr"><ShrinkChip s={c.shrink} /></td>
            <td className="num faint git-files" title={`${nf} file${nf === 1 ? '' : 's'}`}>{nf}</td>
            <td className="git-sha" title={c.sha}>{c.sha.slice(0, 7)}</td>
            <td className="num faint git-age" title={stamp(c.ts)}>{relTime(c.ts)}</td>
          </tr>
        })}</tbody>
      </table>
      {more > 0 && <div className="git-more-row">
        <Btn sm disabled={q.loading} title={`draw the next ${Math.min(PAGE, more)} of the ${more} not drawn yet`} onClick={() => setPages(pages + 1)}>{q.loading ? 'Loading' : `More ${Math.min(PAGE, more)}`}</Btn>
        <span className="faint mono">{rows.length} of {d.total}</span>
      </div>}
    </>}
  </section>
}

function Main() {
  // one era selection shared by the band and the log (useStored state is per component)
  const [era, setEra] = useStored<string>('git.era', '')
  return <div className="git-main"><Eras era={era} setEra={setEra} /><Cards /><Lands /><Log era={era} setEra={setEra} /></div>
}

function Explorer() {
  const q = useRepos()
  const [sel, setSel] = useSel('git')
  return <Load q={q} skel="lines">{d => <Group label="Repos" right={<span>{d.repos.length}</span>}>
    <button className={`row ${!sel ? 'on' : ''}`} onClick={() => setSel(null)}><span className="nm">All</span><span className="r">{d.repos.length}</span></button>
    {d.repos.map(c => <button key={c.id} className={`row ${sel === c.id ? 'on' : ''}`} onClick={() => setSel(c.id)} title={`${c.path} - ${c.holds}`}>
      <Dot s={c.tone} /><span className="nm git-repo" style={repoVar(c.id)}>{c.id}</span><span className="r git-r" title={c.reading}><RailValue reading={c.reading} /></span>
    </button>)}
  </Group>}</Load>
}

function Head() {
  const { toast } = useNav()
  const [busy, setBusy] = useState(false)
  return <><NewBranchHead /><Btn sm kind="primary" disabled={busy} title="every repo: fetch; pull --rebase if clean and behind; push if clean and ahead; a dirty tree is never pulled" onClick={() => sync(undefined, toast, setBusy)}>{busy ? 'syncing' : 'Sync all'}</Btn></>
}

function useBadge() {
  const q = useRepos()
  const n = q.data?.repos.filter(r => r.tone === 'fail').length ?? 0
  return n ? { n, tone: 'fail' as const } : null
}

export const room: RoomDef = {
  id: 'git',
  label: 'Git',
  title: 'Git',
  icon: <><circle cx="6" cy="6" r="2"/><circle cx="6" cy="18" r="2"/><circle cx="18" cy="12" r="2"/><path d="M6 8v8M8 6c6 0 8 2 8 4M8 18c6 0 8-2 8-4"/></>,
  Explorer,
  Main,
  Head,
  useBadge,
}
