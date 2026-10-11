import { useState, useSyncExternalStore } from 'react'
import { Btn, Chip, Dot, Empty, Glyph, Icon, Pill, Skeleton } from '../../ui/kit.tsx'
import { repoVar } from './repo.ts'
import { PIPES, Pipe, PipeHead, fmtMs, pipeNodes, type LandState, type Step } from './charts.tsx'
import { api, relTime, stamp, useApi, useStored } from '../../lib/api.ts'
import { useNav } from '../../shell/nav.tsx'
import { DrawerHead, KvCards, Sec } from '../drawers/index.tsx'

// BUILD BRANCHES + THE LAND QUEUE. A build conversation in app or platform works in its own
// worktree on b/<agent>/<slug>; Land runs rebase -> verify -> fast-forward -> push -> cleanup,
// and a red land goes back to the conversation. Execution never lands from here.
// One card, two groups on one grid: the live branches (actionable) over the last lands, the
// pipeline column aligned under its step names.

/** `gone`: the branch has no worktree any more, so this land can never run again */
type LandItem = { id: string; repo: string; branch: string; worktree: string; conversation: string | null; agent: string | null; state: LandState; steps: Step[]; note: string; sha: string | null; commits: number; queuedAt: number; doneAt: number | null; told?: string | null; gone?: boolean }
type Branch = { path: string; conversation: string; branch: string | null; head: string | null; ahead: number | null; behind: number | null; dirty: number | null; headTs?: number | null; error?: string; repo: string; agent: string | null; title: string | null; live: string | null; land: LandItem | null }
type Data = { repos: string[]; agents: { id: string; name: string; repo: string }[]; branches: Branch[]; queue: LandItem[]; lands?: number }

/** behind main by more than this: the land's rebase has a lot to cross, so the row says stale */
export const STALE_BEHIND = 20
/** land-queue rows drawn before "All" */
const LANDS_SHOWN = 8

/** the land queue's filter: open = still to be dealt with (queued, running, red, blocked, branch still there) */
export type LandFilter = 'open' | 'landed' | 'red' | 'blocked' | 'gone' | 'all'
export function landIn(f: LandFilter, it: Pick<LandItem, 'state' | 'gone'>): boolean {
  if (f === 'all') return true
  if (f === 'gone') return !!it.gone && it.state !== 'landed'
  if (f === 'open') return it.state !== 'landed' && !it.gone
  return it.state === f && (f === 'landed' || !it.gone)
}
const FILTERS: { id: LandFilter; label: string; tip: string }[] = [
  { id: 'all', label: 'All', tip: 'every land on record' },
  { id: 'open', label: 'Open', tip: 'queued, landing, red or blocked, and the branch is still there' },
  { id: 'landed', label: 'Landed', tip: 'on main' },
  { id: 'red', label: 'Red', tip: 'the branch failed a step: it went back to its conversation' },
  { id: 'blocked', label: 'Blocked', tip: 'main was in the way, not the branch' },
  { id: 'gone', label: 'Gone', tip: 'red or blocked, and the branch was dropped since: nothing to land' },
]

/** queue this branch again (the same route as the Land button): a red or blocked land whose worktree is still there */
async function landAgain(it: Pick<LandItem, 'repo' | 'conversation' | 'branch'>, toast: (t: string, fail?: boolean) => void) {
  if (!it.conversation) { toast('no conversation recorded for this land', true); return }
  try { await api('/api/git/land', { body: { repo: it.repo, conversation: it.conversation } }); toast(`${it.branch} queued again`) }
  catch (e: any) { toast(e.message, true) }
}
const canRetry = (it: LandItem) => (it.state === 'red' || it.state === 'blocked') && !it.gone && !!it.conversation

const cv = repoVar
const STATE_DOT: Record<LandState, string> = { queued: 'off', running: 'run', landed: 'ok', red: 'fail', blocked: 'ask' }
const STATE_TIP: Record<LandState, string> = {
  queued: 'waiting its turn', running: 'landing now', landed: 'on main', red: 'the branch failed a step: sent back to its conversation', blocked: 'main is in the way (not the branch): clear it and land again',
}
const STATE_PILL: Record<LandState, 'ok' | 'fail' | 'ask' | 'accent' | 'faint'> = { queued: 'faint', running: 'accent', landed: 'ok', red: 'fail', blocked: 'ask' }

/** "b/platform/w40-refdata-close" -> "w40-refdata-close" (the agent wears its glyph beside it) */
export const slugOf = (branch: string | null) => (branch ?? '').replace(/^b\/[^/]+\//, '') || '(detached)'

/** a land's outcome as one pill: landed = the commits it brought, otherwise its state word */
function Result({ it }: { it: LandItem }) {
  return <Pill tone={STATE_PILL[it.state]} title={`${STATE_TIP[it.state]}${it.note ? `\n${it.note}` : ''}`}>{it.state === 'landed' ? `+${it.commits}` : it.state === 'running' ? 'landing' : it.state}</Pill>
}

function StepsBody({ it }: { it: LandItem }) {
  const { go, openDrawer, toast } = useNav()
  const [busy, setBusy] = useState(false)
  const nodes = pipeNodes(it.steps, it.state)
  const total = it.steps.reduce((t, s) => t + (s.ms ?? 0), 0)
  const slow = Math.max(1, ...it.steps.map(s => s.ms ?? 0))
  return <div className="git-detail">
    <DrawerHead agent={it.agent ?? null} title={<span className="mono" title={it.branch}>{slugOf(it.branch)}</span>}
      sub={`${it.repo} · ${relTime(it.doneAt ?? it.queuedAt)}`}
      chips={[
        { k: 'STATE', v: it.state, tone: STATE_PILL[it.state] === 'accent' || STATE_PILL[it.state] === 'faint' ? '' : STATE_PILL[it.state] as 'ok' | 'fail' | 'ask', title: STATE_TIP[it.state] },
        { k: 'COMMITS', v: it.state === 'landed' ? it.commits : null, title: it.state === 'landed' ? `${it.commits} commit${it.commits === 1 ? '' : 's'} landed` : 'not landed' },
        { k: 'TIME', v: total ? fmtMs(total) : null, title: 'the timed steps, summed' },
      ]} />
    {it.note && <div className={`git-note ${it.state}`}>{it.note}</div>}
    {(canRetry(it) || it.gone) && <div className="git-retry">
      {it.gone ? <span className="faint" title="its worktree and branch were dropped after this land">branch gone: nothing to land</span>
        : <Btn sm kind="primary" disabled={busy} title="queue this branch again: rebase, verify, fast-forward, push" onClick={async () => { setBusy(true); await landAgain(it, toast); setBusy(false) }}>{busy ? 'Queueing' : 'Land again'}</Btn>}
    </div>}
    <Sec>Steps</Sec>
    <div className="git-steps">{PIPES.map((p, i) => {
      const n = nodes[i]
      const t = n.steps.reduce((a, s) => a + (s.ms ?? 0), 0)
      const detail = n.steps.map(s => s.detail).filter(Boolean).join('\n')
      return <div key={p.id} className={`git-step ${n.tone || 'none'}`}>
        <span className={`git-node ${n.tone}`}><i /></span>
        <b title={p.label}>{p.id === 'land' ? 'fast-forward' : p.id === 'cleanup' ? 'remove' : p.id}</b>
        <span className="git-step-bar" title={t ? fmtMs(t) : 'not timed'}>{t > 0 && <i style={{ width: `${(t / slow) * 100}%` }} />}</span>
        <span className="mono faint git-step-ms">{t ? fmtMs(t) : ''}</span>
        {detail && (detail.includes('\n') ? <pre className="pre git-step-pre">{detail}</pre> : <span className="git-step-d">{detail}</span>)}
      </div>
    })}</div>
    <KvCards cards={[
      { title: 'Branch', rows: [
        ['branch', <span className="mono">{it.branch}</span>],
        ['repo', <span className="mono">{it.repo}</span>],
        it.sha ? ['main at', <span className="mono">{it.sha.slice(0, 7)}</span>] : null,
        it.conversation ? ['conversation', <button className="lnk mono" onClick={() => { openDrawer(null); go('chats', it.conversation!) }}>{it.conversation}</button>] : null,
        it.told ? ['agent told', it.told === 'sent' ? 'the failure was sent back' : it.told] : null,
      ] },
      { title: 'Window', rows: [
        ['queued', <span className="mono">{stamp(it.queuedAt)}</span>],
        it.doneAt ? ['done', <span className="mono">{stamp(it.doneAt)}</span>] : null,
      ] },
    ]} />
  </div>
}

const openLand = (openDrawer: ReturnType<typeof useNav>['openDrawer'], it: LandItem) =>
  openDrawer({ title: <span>Land {it.branch}</span>, body: <StepsBody it={it} /> })

function NewBranch({ d, done }: { d: Data; done: () => void }) {
  const { toast, go } = useNav()
  const [agent, setAgent] = useState(d.agents[0]?.id ?? '')
  const [title, setTitle] = useState('')
  const [prompt, setPrompt] = useState('')
  const [busy, setBusy] = useState(false)
  if (!d.agents.length) return <div className="git-new"><Empty inline title="NO AGENT">{`no armed agent works in ${d.repos.join(' or ') || 'a build repo'}`}</Empty></div>
  const a = d.agents.find(x => x.id === agent)
  const start = async () => {
    setBusy(true)
    try {
      const r = await api<{ id: string; branch: string }>('/api/git/branches', { body: { agent, title, prompt } })
      toast(`${r.branch} cut`)
      done()
      go('chats', r.id)
    } catch (e: any) { toast(e.message, true) } finally { setBusy(false) }
  }
  return <form className="git-new" style={cv(a?.repo ?? '')} onSubmit={e => { e.preventDefault(); if (title.trim() && !busy) void start() }}>
    <select className="input git-sel" value={agent} onChange={e => setAgent(e.target.value)} title="the agent that builds on the branch">
      {d.agents.map(x => <option key={x.id} value={x.id}>{x.name} - {x.repo}</option>)}
    </select>
    <input className="input git-new-t" placeholder="What it builds" title="names the branch" value={title} onChange={e => setTitle(e.target.value)} autoFocus />
    <textarea className="input git-new-p" placeholder="first message (optional)" rows={2} value={prompt} onChange={e => setPrompt(e.target.value)} />
    <span className="git-new-a">
      <Btn sm kind="primary" type="submit" disabled={!title.trim() || busy} title={`cut b/${agent}/... from main in its own worktree and open the conversation`}>{busy ? 'cutting' : 'Start'}</Btn>
      <Btn sm kind="ghost" onClick={done}>Cancel</Btn>
    </span>
  </form>
}

/** ahead / behind / dirty as small count pills; a count git could not read shows "?" */
function Counts({ b }: { b: Branch }) {
  return <span className="git-counts" title={`${b.ahead ?? '?'} commit${b.ahead === 1 ? '' : 's'} main does not have\nmain has ${b.behind ?? '?'} the branch does not\n${b.dirty ?? '?'} uncommitted file${b.dirty === 1 ? '' : 's'}`}>
    <Pill tone={(b.ahead ?? 0) > 0 ? 'ok' : 'faint'}>↑{b.ahead ?? '?'}</Pill>
    {(b.behind ?? 0) > 0 && <Pill tone="faint">↓{b.behind}</Pill>}
    {(b.dirty ?? 0) > 0 && <Pill tone="warn">~{b.dirty}</Pill>}
  </span>
}

function BranchRow({ b }: { b: Branch }) {
  const { toast, go, openDrawer } = useNav()
  const [arm, setArm] = useState(false)
  const [busy, setBusy] = useState(false)
  const pending = b.land && (b.land.state === 'queued' || b.land.state === 'running')
  const why = b.live === 'live' ? 'the agent is mid-turn: land when it is idle'
    : (b.dirty ?? 0) > 0 ? `${b.dirty} uncommitted file${b.dirty === 1 ? '' : 's'} in the worktree`
    : (b.ahead ?? 0) === 0 ? 'no commits to land yet'
    : pending ? 'already in the queue' : ''
  const land = async () => {
    setBusy(true)
    try { await api('/api/git/land', { body: { repo: b.repo, conversation: b.conversation } }); toast(`${b.branch} queued`) }
    catch (e: any) { toast(e.message, true) } finally { setBusy(false) }
  }
  const drop = async () => {
    if (!arm) { setArm(true); setTimeout(() => setArm(false), 4000); return }
    setBusy(true)
    try { await api('/api/git/branches/drop', { body: { repo: b.repo, conversation: b.conversation } }); toast(`${b.branch} dropped`) }
    catch (e: any) { toast(e.message, true) } finally { setBusy(false); setArm(false) }
  }
  const slug = slugOf(b.branch)
  const title = b.title && b.title !== slug ? b.title : null
  const stale = (b.behind ?? 0) > STALE_BEHIND
  return <div className="git-lrow" style={cv(b.repo)} title={`${b.repo}  ${b.branch ?? '(detached)'}\n${b.path}${b.head ? `\nhead ${b.head}` : ''}${b.error ? `\n${b.error}` : ''}`}>
    <span className="git-rule" />
    {b.agent ? <Glyph id={b.agent} /> : <Dot s="unknown" title="no agent on this worktree" />}
    <span className="git-lname">
      <span className="mono git-lb">{slug}</span>
      {b.live === 'live' && <Dot s="run" title="the agent is working in this worktree" />}
      {b.error && <Dot s="unknown" title={b.error} />}
      <button className="lnk git-lt" title={`open ${b.conversation} in Chats`} onClick={() => go('chats', b.conversation)}>{title ?? 'Chat'}</button>
      {stale && <Pill tone="warn" title={`main is ${b.behind} commits ahead of this branch: the land rebases over all of them, so a conflict is likelier. Land or rebase it soon`}>stale</Pill>}
      {b.headTs ? <span className="faint mono git-lage" title={`last commit on the branch ${stamp(b.headTs)}`}>{relTime(b.headTs)}</span> : null}
    </span>
    <Counts b={b} />
    <button className="git-lpipe" title={b.land ? 'the last land: open its steps' : 'not landed yet'} disabled={!b.land} onClick={() => b.land && openLand(openDrawer, b.land)}>
      <Pipe steps={b.land?.steps ?? []} state={b.land?.state ?? null} /></button>
    <span className="git-lres">{b.land && <Result it={b.land} />}</span>
    <span className="git-lact">
      <Btn sm kind="primary" disabled={!!why || busy} title={why || `rebase onto main, run the ${b.repo} verify, fast-forward main, push, then remove the worktree and branch`} onClick={land}>{pending ? b.land!.state : 'Land'}</Btn>
      <Btn sm kind={arm ? 'danger' : 'ghost'} disabled={busy || !!pending || b.live === 'live'} title={arm ? `click again: delete the worktree and ${b.branch}${(b.ahead ?? 0) > 0 ? `, losing ${b.ahead} unlanded commit${b.ahead === 1 ? '' : 's'}` : ''}` : 'discard this branch (asks once more)'} onClick={drop}>
        {arm ? `Drop${(b.ahead ?? 0) > 0 ? ` ${b.ahead}` : ''}?` : <Icon name="x" />}</Btn>
    </span>
  </div>
}

/** the queue, one row per branch (its newest land); earlier attempts are the small dots, oldest left */
export function groupLands(items: LandItem[]): { last: LandItem; tries: LandItem[] }[] {
  const by = new Map<string, LandItem[]>()
  for (const it of items) { const k = `${it.repo}|${it.branch}`; (by.get(k) ?? by.set(k, []).get(k)!).push(it) }
  return [...by.values()].map(xs => ({ last: xs[0], tries: [...xs].reverse() }))
}

function LandRow({ last, tries }: { last: LandItem; tries: LandItem[] }) {
  const { openDrawer, toast } = useNav()
  const [busy, setBusy] = useState(false)
  const at = last.doneAt ?? last.queuedAt
  const gone = !!last.gone && last.state !== 'landed'
  return <div className={`git-lrow click ${last.state} ${gone ? 'gone' : ''}`} style={cv(last.repo)} role="button" tabIndex={0}
    title={`${last.repo}  ${last.branch}\n${STATE_TIP[last.state]}${gone ? '\nthe branch was dropped since: nothing to land' : ''}${last.note ? `\n${last.note}` : ''}`}
    onClick={() => openLand(openDrawer, last)} onKeyDown={k => {
      if (k.target !== k.currentTarget) return
      const step = k.key === 'j' || k.key === 'ArrowDown' ? 1 : k.key === 'k' || k.key === 'ArrowUp' ? -1 : 0
      if (k.key === 'Enter') openLand(openDrawer, last)
      else if (step) { k.preventDefault(); ((step > 0 ? k.currentTarget.nextElementSibling : k.currentTarget.previousElementSibling) as HTMLElement | null)?.focus() }
    }}>
    <span className="git-rule" />
    {last.agent ? <Glyph id={last.agent} /> : <Dot s="unknown" title="no agent recorded" />}
    <span className="git-lname"><span className="mono git-lb dim">{slugOf(last.branch)}</span>
      {gone && <Pill tone="faint" title="the branch was dropped after this land: nothing to land again">gone</Pill>}
      {tries.length > 1 && <span className="git-tries" title={`${tries.length} lands of this branch, oldest left: click one for its steps`}>{tries.map(t =>
        <button key={t.id} className={`git-try ${STATE_DOT[t.state]} ${t === last ? 'last' : ''}`} title={`${t.state}  ${stamp(t.doneAt ?? t.queuedAt)}${t.note ? `\n${t.note}` : ''}`}
          onClick={e => { e.stopPropagation(); openLand(openDrawer, t) }} />)}</span>}
    </span>
    <span className="git-counts" />
    <span className="git-lpipe"><Pipe steps={last.steps} state={last.state} /></span>
    <span className="git-lres"><Result it={last} /></span>
    <span className="git-lact mono faint" title={stamp(at)}>
      {canRetry(last) && <span onClick={e => e.stopPropagation()}><Btn sm disabled={busy} title="queue this branch again: rebase, verify, fast-forward, push"
        onClick={async () => { setBusy(true); await landAgain(last, toast); setBusy(false) }}>{busy ? '...' : 'Retry'}</Btn></span>}
      {relTime(at)}</span>
  </div>
}

/** the "+ New branch" form's open state, shared by the section and the room head (the head carries
 *  the button when the branch list loaded and is empty, so the section can vanish) */
let formOpen = false
const formSubs = new Set<() => void>()
const setFormOpen = (v: boolean) => { formOpen = v; formSubs.forEach(f => f()) }
const useFormOpen = () => useSyncExternalStore(f => { formSubs.add(f); return () => { formSubs.delete(f) } }, () => formOpen)

const useBranches = () => useApi<Data>('/api/git/branches?limit=500', ['git'])
/** loaded, and no build branch, no land and no form open: the section draws nothing */
const bare = (d: Data | null, open: boolean) => !!d && d.branches.length === 0 && d.queue.length === 0 && !open

/** the room head's ghost button, only while there is no branch (the card's own head carries it otherwise) */
export function NewBranchHead() {
  const q = useBranches()
  const open = useFormOpen()
  if (!q.data || q.data.branches.length > 0 || open) return null
  return <Btn sm kind="ghost" title="no build branches: start a build conversation on its own branch" onClick={() => setFormOpen(true)}>+ New branch</Btn>
}

/** the one card: Branches (live worktrees) then Land queue (the last lands, newest first) */
export function Lands() {
  const q = useBranches()
  const open = useFormOpen()
  const [filter, setFilter] = useStored<LandFilter>('git.lands', 'all')
  const [repoF, setRepoF] = useStored<string>('git.landsRepo', '')
  const [showAll, setShowAll] = useState(false)
  const d = q.data
  // loaded and empty: no card at all; the head carries "+ New branch". Failed or still unknown keeps
  // the card with its honest line
  if (bare(d, open)) return null
  if (q.error && !d) return <section className="card git-land"><Empty inline state="failed">{`branches: ${q.error}`}</Empty></section>
  if (!d) return <section className="card git-land"><Skeleton kind="lines" n={3} /></section>
  const all = groupLands(d.queue)
  const repos = [...new Set(all.map(g => g.last.repo))].sort()
  const inRepo = all.filter(g => !repoF || g.last.repo === repoF)
  const matched = inRepo.filter(g => landIn(filter, g.last))
  const groups = showAll ? matched : matched.slice(0, LANDS_SHOWN)
  const count = (f: LandFilter) => inRepo.filter(g => landIn(f, g.last)).length
  return <section className="card git-land">
    {(d.branches.length > 0 || open) && <>
      <div className="git-lrow git-lhead">
        <span /><span />
        <span className="git-lname"><span className="cap" title="build conversations in app or platform, each in its own worktree on b/<agent>/<slug>">Branches</span><span className="faint mono">{d.branches.length}</span></span>
        <span className="git-counts" /><PipeHead /><span />
        <span className="git-lact">{!open && <Btn sm kind="ghost" title="start a build conversation on its own branch" onClick={() => setFormOpen(true)}>+ New</Btn>}</span>
      </div>
      {open && <NewBranch d={d} done={() => setFormOpen(false)} />}
      {d.branches.map(b => <BranchRow key={b.path} b={b} />)}
    </>}
    {all.length > 0 && <>
      <div className={`git-lrow git-lhead ${d.branches.length || open ? 'sep' : ''}`}>
        <span /><span />
        <span className="git-lname"><span className="cap" title="the lands on record, newest first, one row per branch: click one for its steps. j / k move, Enter opens">Land queue</span><span className="faint mono" title={`${matched.length} of ${all.length} branches; ${d.lands ?? d.queue.length} lands`}>{matched.length === all.length ? all.length : `${matched.length} of ${all.length}`}</span></span>
        <span className="git-counts" />{d.branches.length || open ? <span /> : <PipeHead />}<span /><span />
      </div>
      <div className="git-lfilter">
        {FILTERS.map(f => { const n = count(f.id); return <Chip key={f.id} sm on={filter === f.id} disabled={!n && filter !== f.id} title={`${f.tip}: ${n}`} onClick={() => { setFilter(f.id); setShowAll(false) }}>{f.label} <b>{n}</b></Chip> })}
        {repos.length > 1 && <><span className="git-lfilter-sep" />{repos.map(r => <Chip key={r} sm on={repoF === r} title={repoF === r ? 'every repo' : `only ${r}`} onClick={() => setRepoF(repoF === r ? '' : r)}><i className="git-sw" style={{ ...cv(r), background: 'var(--c)' }} />{r}</Chip>)}</>}
      </div>
      {groups.map(g => <LandRow key={g.last.id} last={g.last} tries={g.tries} />)}
      {!groups.length && <div className="git-lempty"><Empty inline title="NONE">{`no ${filter === 'all' ? '' : `${filter} `}land${repoF ? ` in ${repoF}` : ''}`}</Empty></div>}
      {matched.length > LANDS_SHOWN && <div className="git-lmore"><Btn sm kind="ghost" onClick={() => setShowAll(!showAll)} title={showAll ? `back to the newest ${LANDS_SHOWN}` : `every one of the ${matched.length}`}>{showAll ? 'Less' : `All ${matched.length}`}</Btn></div>}
    </>}
  </section>
}
