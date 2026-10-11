import { Fragment, useState, useSyncExternalStore, type CSSProperties, type MouseEvent, type ReactNode } from 'react'
import type { RoomDef } from '../types.ts'
import { Btn, Dot, Empty, FailLine, Glyph, Group, Icon, Load, Markdown, Meter, Seg, Skeleton, Tag } from '../../ui/kit.tsx'
import { api, relTime, stamp, useApi } from '../../lib/api.ts'
import { useNav, useSel } from '../../shell/nav.tsx'
import { shared } from './store.ts'
import { AgentMark, ReviewCards, useQueue, type Queue } from './Review.tsx'
import { lessonDays } from './days.ts'
import { funnel, heat, lessonGrid, retroChip, type Funnel } from './shape.ts'
import { catVar, categoryOf } from '../../ui/categories.ts'
import { DrawerHead, KvCards, Sec, type Chip } from '../drawers/index.tsx'
import './loop.css'

// ROOM: loop - the fund improving itself. A funnel strip on top (Review | Learned > Proposed >
// Watching > Kept / Reverted / Vetoed), Review on the left, Learned (an agent x day grid) over the
// flow lanes: Proposals (what a pass wants to change), Watching (applied, on probation), Decided.

type Book = { path: string; status: 'A' | 'M' | 'D' | 'R'; index: boolean }
type Commit = { repo: string; sha: string; ts: number; author: string; subject: string; books: Book[]; desk: string; agent: string | null }
type Captured = { key: string; source: 'inbox' | 'git'; ts: number; agent: string | null; title: string; text: string; readWhen: string | null; ref: string; state: string }
type NoLesson = { ts: number | null; desk: string; hand: string | null; operator: string | null; subject: string; reason: string; touched: string[] }
type Retro = { desk: string; stamp: { found: boolean; date: string | null; raw: string | null; run: string | null; bet: string | null }; graded: number; imported: number; since: number; ageDays: number | null; due: boolean; dueAt: number | null; reasons: string[]; digest?: Digest | null }
type Digest = { path: string; date: string; through: string | null; source: string | null; lines: string[]; fills: number; count: number }
type Gate = { name: string; ok: boolean; note: string }
type Win = { counts: Record<string, number>; score: number | null; days: number }
type Watch = { agents: string[]; from: number | null; until: number | null; events: number; before: Win | null; after: Win | null; verdict: 'better' | 'same' | 'worse' | 'no-signal' | null; extended?: number }
type State = 'proposed' | 'applied' | 'watching' | 'kept' | 'reverted' | 'vetoed'
/** what the card draws, derived by the server from the file (server/loop/watchread.ts) */
type WatchRead = { n: { before: number | null; after: number | null; min: number }; signal: 'read' | 'thin' | 'unmeasured' | null; verdict: Watch['verdict']; delta: number | null; days: { elapsed: number; span: number } | null }
/** the agent a pass sent it to (server/loop/dispatch.ts): it lands the change or declines it */
type Review = { agent: string; conversation: string | null; at: string; ask: 'apply' | 'revert'; tries: number; verdict: 'applied' | 'declined' | 'reverted' | null; note: string; commit: string | null }
type Proposal = { id: string; kind: 'promote' | 'boot-compress' | 'unread'; title: string; target: string[]; source: string[]; why: string; gates: Gate[]; state: State; auto: boolean; commit: string | null; revert: string | null; watch: Watch; pinned: boolean; review: Review | null; reviewer?: { agent: string | null; why: string | null } | null; created: string; updated: string; body?: string; read?: WatchRead }
type Config = { autoApply: boolean; watchDays: number; watchEvents: number; tolerance: number; minEvents?: number; noSignalExtends?: number; unreadLedgerDays: number; source: string | null }
type Pass = { ts: number; trigger: string; ok: boolean; summary: string; detail: { errors: string[]; notes: string[] } | null }
/** a board item in review and who has it (server/loop/boardreview.ts reviewRows); absent on an older fundd = not drawn */
type BoardRev = { id: string; title: string; owner: string; priority: string; updated: string; returns: number; state: 'unsent' | 'with' | 'checking' | 'owner'; agent: string | null; conversation: string | null; at: string | null; tries: number; why: string | null }
type Lanes = { now: number; range: string; commits: Commit[]; commitErrors: string[]; lessons: Captured[]; noLesson: NoLesson[] | null; noLessonBad: number; retros: Retro[]; retroProbe: { status: string; reading: string; probedTs: number | null } | null; proposals: Proposal[]; proposalsBad: { file: string; error: string }[]; boardReview?: BoardRev[]; config: Config; pass: Pass | null }
type Point = { day: string; score: number | null; turns: number; cost: number }
type Detail = { proposal: Proposal; chart: { from: number | null; until: number | null; agents: string[]; points: Point[]; before: Win | null; after: Win | null } | null; config: Config }

const RANGES = [{ id: '7d', label: '7d' }, { id: '30d', label: '30d' }, { id: 'all', label: 'All' }] as const
type Range = typeof RANGES[number]['id']

function useRange(): [Range, (r: Range) => void] {
  const [sel, set] = useSel('loop')
  const r = (RANGES.some(x => x.id === sel) ? sel : '30d') as Range
  return [r, set]
}
function useLanes() {
  const [range] = useRange()
  return useApi<Lanes>(`/api/loop/lanes?range=${range}`, ['loop', 'git'])
}

const agentF = shared<string>('loop.agent', '')
/** an empty lane the owner opened from the fold strip (an empty lane is otherwise only a count chip in that strip) */
const laneOpen = shared<string>('loop.lane', '')

const deskName = (d: string) => (d === '.' ? 'fund' : d.replace(/^(lab|desks)\//, ''))
const day = (ms: number | null) => (ms ? new Date(ms).toISOString().slice(0, 10) : '-')
const fmt = (s: number | null | undefined) => (s === null || s === undefined ? '-' : s.toFixed(2))
const KIND: Record<Proposal['kind'], string> = { promote: 'promote', 'boot-compress': 'boot', unread: 'unread' }
const STATE_TONE: Record<State, string> = { proposed: 'accent', applied: 'accent', watching: 'accent', kept: 'ok', reverted: 'warn', vetoed: '' }
const VERDICT_TONE: Record<string, string> = { better: 'ok', same: '', worse: 'fail', 'no-signal': 'warn' }
/** kept because the watch could not tell (too few scored events even after its extension): not a verdict, and never shown as one */
const unjudged = (p: Proposal) => p.state === 'kept' && p.watch.verdict === 'no-signal' && !p.pinned
const UNJUDGED_T = 'kept without a verdict: the cohort had too few scored events to judge, even after the watch was extended. Revert it if it looks wrong'
/** out with an agent, not answered yet */
const withAgent = (p: Proposal) => !!p.review && p.review.verdict === null
/** the loop cannot write it itself: it goes to an agent (or waits for the owner) */
const advisory = (p: Proposal) => p.kind !== 'promote' || p.gates.some(g => !g.ok)
const REVIEW_WORD: Record<NonNullable<Review['verdict']>, string> = { applied: 'landed', declined: 'declined', reverted: 'reverted' }

// ---- the metric chart: the cohort's daily pooled score, the apply day marked ----

function Chart({ points, from, before, after, h = 64 }: { points: Point[]; from: number | null; before: Win | null; after: Win | null; h?: number }) {
  const w = 280
  const pad = 4
  if (!points.length) return <Empty inline center title="NO DAYS" />
  const measured = points.filter(p => p.score !== null)
  if (!measured.length) return <div title="no turns, graded runs, verifies or board items for this cohort in the window"><Empty inline center state="unknown" title="UNMEASURED" /></div>
  const x = (i: number) => pad + (points.length === 1 ? (w - 2 * pad) / 2 : (i * (w - 2 * pad)) / (points.length - 1))
  // the y range hugs the data (and both window means), never outside 0..1, at least 0.1 tall
  const vals = [...measured.map(p => p.score as number), ...[before?.score, after?.score].filter((v): v is number => typeof v === 'number')]
  let lo = Math.max(0, Math.min(...vals) - 0.03), hi = Math.min(1, Math.max(...vals) + 0.03)
  if (hi - lo < 0.1) { const mid = (hi + lo) / 2; lo = Math.max(0, mid - 0.05); hi = Math.min(1, lo + 0.1); lo = Math.max(0, hi - 0.1) }
  const y = (s: number) => pad + (1 - (s - lo) / (hi - lo)) * (h - 2 * pad)
  const applyDay = from === null ? null : new Date(from).toISOString().slice(0, 10)
  const ai = applyDay === null ? -1 : points.findIndex(p => p.day >= applyDay)
  const segs: string[] = []
  let cur = ''
  points.forEach((p, i) => {
    if (p.score === null) { if (cur) segs.push(cur); cur = ''; return }
    cur += `${cur ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.score).toFixed(1)}`
  })
  if (cur) segs.push(cur)
  const bx = ai >= 0 ? x(ai) : null
  return <svg className="loop-chart" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" role="img">
    <title>{`cohort score by day${applyDay ? `, applied ${applyDay}` : ''}\nbefore ${fmt(before?.score)} · after ${fmt(after?.score)}\naxis ${lo.toFixed(2)} to ${hi.toFixed(2)}`}</title>
    <line x1={pad} x2={w - pad} y1={y(hi)} y2={y(hi)} className="loop-ch-grid" />
    <line x1={pad} x2={w - pad} y1={y(lo)} y2={y(lo)} className="loop-ch-grid" />
    {bx !== null && before?.score != null && <line x1={pad} x2={bx} y1={y(before.score)} y2={y(before.score)} className="loop-ch-mean" />}
    {bx !== null && after?.score != null && <line x1={bx} x2={w - pad} y1={y(after.score)} y2={y(after.score)} className="loop-ch-mean after" />}
    {bx !== null && <line x1={bx} x2={bx} y1={0} y2={h} className="loop-ch-apply" />}
    {segs.map((d, i) => <path key={i} d={d} className="loop-ch-line" />)}
    {points.map((p, i) => p.score === null ? null : <circle key={p.day} cx={x(i)} cy={y(p.score)} r={1.6} className="loop-ch-pt"><title>{`${p.day}  ${p.score.toFixed(3)}  ${p.turns} turns`}</title></circle>)}
  </svg>
}

function useDetail(id: string) { return useApi<Detail>(`/api/loop/proposals/${id}`, ['loop']) }

/** who has it: out with an agent (pulsing, opens its conversation), or what that agent did */
function ReviewChip({ r }: { r: Review }) {
  const { go, openDrawer } = useNav()
  const open = (e: MouseEvent) => { e.stopPropagation(); if (r.conversation) { openDrawer(null); go('chats', r.conversation) } }
  const out = r.verdict === null
  const what = out ? (r.ask === 'apply' ? 'checking' : 'reverting') : REVIEW_WORD[r.verdict!]
  const t = [`${r.agent} ${out ? `has it: ${r.ask === 'apply' ? 'checks it, then lands or declines it' : 'reverting its own commit'}` : REVIEW_WORD[r.verdict!]}`,
    `sent ${r.at.slice(0, 16).replace('T', ' ')}${r.tries > 1 ? ` · try ${r.tries}` : ''}`, r.note, r.conversation ? 'click: open the conversation' : ''].filter(Boolean).join('\n')
  return <button className={`loop-who ${out ? 'out' : `v-${r.verdict}`}`} style={catVar(categoryOf(r.agent))} title={t} onClick={open} disabled={!r.conversation}>
    <Glyph id={r.agent} />{out && <Dot s="run" />}<span>{what}</span>
  </button>
}

// ---- drawers ----

function Actions({ p }: { p: Proposal }) {
  const { toast, openDrawer } = useNav()
  const [busy, setBusy] = useState('')
  const act = async (a: string) => {
    setBusy(a)
    try {
      const r = await api<Proposal>(`/api/loop/proposals/${p.id}/${a}`, { body: {} })
      toast(r.review && r.review.verdict === null && (a === 'send' || a === 'revert') ? `${p.id} sent to ${r.review.agent}` : `${p.id} ${r.state}${a === 'pin' ? ' (pinned)' : a === 'unpin' ? ' (unpinned)' : ''}`)
      if (a === 'veto' || (a === 'revert' && r.state === 'reverted')) openDrawer(null)
    }
    catch (e) { toast(`${p.id} ${a}: ${(e as Error).message}`, true) }
    finally { setBusy('') }
  }
  const blocked = p.gates.filter(g => !g.ok)
  const to = p.reviewer?.agent ?? null
  const out = withAgent(p)
  const byAgent = !!p.review && (p.review.verdict === 'applied' || p.review.ask === 'revert')
  return <div className="loop-actions">
    {p.state === 'proposed' && !advisory(p) && <Btn kind="primary" sm disabled={!!busy} title="write the book + series row and commit (Agent: loop)" onClick={() => act('apply')}>{busy === 'apply' ? 'Applying' : 'Apply'}</Btn>}
    {p.state === 'proposed' && advisory(p) && !out && <Btn kind="primary" sm disabled={!!busy || !to}
      title={to ? `send to ${to}: it checks the change against the tree, then lands it or declines it` : `nobody can land it: ${p.reviewer?.why ?? (blocked.map(g => `${g.name}: ${g.note}`).join('\n') || 'no owner')}. Yours to do by hand, or veto`}
      onClick={() => act('send')}>{busy === 'send' ? 'Sending' : 'Send'}</Btn>}
    {p.state === 'proposed' && <Btn sm disabled={!!busy} title="close it: the loop will not propose these sources again" onClick={() => act('veto')}>Veto</Btn>}
    {(p.state === 'applied' || p.state === 'watching' || p.state === 'kept') && <>
      <Btn kind="danger" sm disabled={!!busy || (out && p.review!.ask === 'revert')} title={out && p.review!.ask === 'revert' ? `with ${p.review!.agent} to revert` : byAgent ? `send back to ${p.review!.agent}: it reverts its own commit` : 'a new commit that restores the target files'} onClick={() => act('revert')}>{busy === 'revert' ? 'Reverting' : 'Revert'}</Btn>
      <Btn sm disabled={!!busy} title={p.pinned ? 'let the watch decide again' : 'keep it whatever the watch says (no auto-revert)'} onClick={() => act(p.pinned ? 'unpin' : 'pin')}>{p.pinned ? 'Unpin' : 'Pin'}</Btn>
    </>}
  </div>
}

function ProposalBody({ id }: { id: string }) {
  const q = useDetail(id)
  const { go, openDrawer } = useNav()
  return <Load q={q} skel="cards">{d => {
    const p = d.proposal
    const c = d.chart
    const held = p.gates.filter(g => g.ok).length
    const thin = !!p.read && p.read.signal !== null && p.read.signal !== 'read'
    const verdict = unjudged(p) ? 'unjudged' : p.watch.verdict ?? (p.read?.verdict && p.read.verdict !== 'no-signal' ? p.read.verdict : null)
    return <div className="loop-detail">
      <DrawerHead agent={c?.agents.length === 1 ? c.agents[0] : 'fund'} title={p.title.replace(/^(promote|boot|unread): /, '')} sub={`${p.id} · ${KIND[p.kind]}${p.pinned ? ' · pinned' : ''}`}
        chips={[
          { k: 'STATE', v: p.state, tone: (['ok', 'warn', 'fail'].includes(STATE_TONE[p.state]) ? STATE_TONE[p.state] : '') as Chip['tone'], title: `state ${p.state}` },
          { k: 'GATES', v: p.gates.length ? `${held}/${p.gates.length}` : null, tone: p.gates.length ? (held === p.gates.length ? 'ok' : 'warn') : '', title: p.gates.map(g => `${g.ok ? 'ok' : 'no'}  ${g.name}${g.note ? `: ${g.note}` : ''}`).join('\n') || 'no gates' },
          // a thin window is NO SIGNAL here too, never a flat before -> after that reads like a verdict
          { k: 'SCORE', v: thin ? 'no signal' : c?.before || c?.after ? `${fmt(c.before?.score)} -> ${fmt(c.after?.score)}` : null, title: thin ? `too few scored events to read: ${p.read?.n.before ?? '-'} before, ${p.read?.n.after ?? '-'} after, ${p.read?.n.min} needed a side
before ${fmt(c?.before?.score)} -> after ${fmt(c?.after?.score)} (not a result)` : 'watch score before -> after' },
          { k: 'VERDICT', v: verdict, tone: verdict === 'unjudged' ? 'warn' : verdict ? (VERDICT_TONE[verdict] as Chip['tone']) ?? '' : '', title: verdict === 'unjudged' ? UNJUDGED_T : `watch verdict ${verdict ?? 'not read yet'}${p.watch.verdict === null && verdict ? ' (so far)' : ''}` },
        ]} />
      <div className="loop-row"><span className="loop-why">{p.why}</span><Actions p={p} /></div>
      <KvCards cards={[
        { title: 'Identity', rows: [
          ['id', <span className="mono">{p.id}</span>],
          ['kind', <Tag>{KIND[p.kind]}</Tag>],
          ['file', <span className="mono">app/loop/records/proposals/{p.id}.md</span>],
          ['sources', <span className="mono loop-wrap">{p.source.join(', ')}</span>],
          p.review ? ['agent', <ReviewChip r={p.review} />] : p.state === 'proposed' && p.reviewer ? ['goes to', p.reviewer.agent ? <span className="mono">{p.reviewer.agent}</span> : <span className="faint" title={p.reviewer.why ?? ''}>the owner</span>] : null,
        ] },
        { title: 'Window', rows: [
          ['opened', <span className="mono" title={p.created}>{p.created.slice(0, 10)}</span>],
          ['updated', <span className="mono" title={p.updated}>{relTime(p.updated)}</span>],
          c && c.from !== null ? ['watch', <span className="mono">{day(c.from)} to {day(c.until)}</span>] : null,
          c && c.from !== null ? ['or', <span className="mono">{p.watch.events} turns{p.watch.extended ? <span className="t-warn" title="a due watch that read no-signal was extended by another window"> · ext {p.watch.extended}x</span> : null}</span>] : null,
        ] },
        { title: 'Result', rows: [
          c && c.from !== null ? ['before', <span className="mono">{fmt(c.before?.score)} <span className="faint">{c.before ? `${c.before.counts.turns ?? 0} turns · ${c.before.days}d` : ''}</span></span>] : null,
          c && c.from !== null ? ['after', c.after ? <span className="mono">{fmt(c.after.score)} <span className="faint">{`${c.after.counts.turns ?? 0} turns · ${c.after.days}d`}</span></span> : null] : null,
          p.commit ? ['commit', <span className="mono">{p.commit.slice(0, 10)}</span>] : null,
          p.revert ? ['revert', <span className="mono">{p.revert.slice(0, 10)}</span>] : null,
        ] },
      ]} />
      {c && <>
        <Sec>Score {c.agents.length ? <span className="faint">{c.agents.join(', ')}</span> : null}</Sec>
        <Chart points={c.points} from={c.from} before={c.before} after={c.after} h={110} />
      </>}
      <Sec>Gates</Sec>
      <table className="kv loop-kv"><tbody>{p.gates.map(g => <tr key={g.name}><td><Dot s={g.ok ? 'ok' : 'warn'} /> {g.name}</td><td className="faint">{g.note || (g.ok ? 'holds' : '')}</td></tr>)}</tbody></table>
      <Sec>Targets</Sec>
      {p.target.map(t => <div key={t} className="loop-book">{t.startsWith('library/') && (p.state === 'watching' || p.state === 'kept' || p.state === 'applied')
        ? <button className="lnk mono loop-link" onClick={() => { openDrawer(null); go('library', t) }}>{t}</button> : <span className="mono faint">{t}</span>}</div>)}
      {p.body && <Markdown text={p.body} />}
    </div>
  }}</Load>
}

/** a book excerpt as plain text, two lines; the full book is the source link above. An inbox
 *  lesson has no book to link, so its excerpt opens in place */
function Excerpt({ text, cut }: { text: string; cut?: boolean }) {
  const [open, setOpen] = useState(false)
  const plain = text.replace(/\*\*|__|`/g, '').replace(/^#+\s*/gm, '').replace(/^[ \t]*(?:[-*+]|\d+[.)])[ \t]+/gm, '').replace(/\s*\n\s*/g, ' ').trim()
  if (!plain) return null
  return <div className={`loop-clamp ${open ? 'open' : ''}`} title={open ? undefined : 'click to expand'} onClick={() => setOpen(!open)}>{plain}{cut ? ' ...' : ''}</div>
}

function LessonBody({ l }: { l: Captured }) {
  const { go, openDrawer, toast } = useNav()
  const id = l.source === 'inbox' ? l.key.slice(6) : null
  const act = async (a: 'dismiss' | 'reopen') => {
    try { await api(`/api/loop/lessons/${id}/${a}`, { body: {} }); toast(a === 'dismiss' ? 'dismissed' : 'reopened'); openDrawer(null) } catch (e) { toast((e as Error).message, true) }
  }
  const src = l.source === 'git' ? <button className="lnk mono loop-link" onClick={() => { openDrawer(null); go('library', l.ref) }}>{l.ref}</button> : <span className="mono">inbox{l.ref ? ` · ${l.ref}` : ''}</span>
  return <div className="loop-detail">
    <DrawerHead agent={l.agent} title={l.title} sub={`${l.source} · ${relTime(l.ts)}`}
      chips={[
        { k: 'LANE', v: l.state === 'open' ? 'learned' : l.state, tone: l.state === 'open' ? 'ok' : '', title: `lane ${l.state}` },
        { k: 'SOURCE', v: l.source, title: l.ref || l.source },
        { k: 'AGENT', v: l.agent, title: l.agent ? `filed by ${l.agent}` : 'unattributed' },
      ]} />
    <KvCards cards={[
      { title: 'Identity', rows: [['agent', l.agent ? <span className="mono">{l.agent}</span> : null], ['source', src]] },
      { title: 'Window', rows: [['when', <span className="mono">{stamp(l.ts)}</span>], ['age', <span className="mono">{relTime(l.ts)}</span>]] },
      { title: 'Result', wide: true, rows: [['lane', <Tag tone={l.state === 'open' ? 'ok' : undefined}>{l.state === 'open' ? 'learned' : l.state}</Tag>], l.readWhen ? ['read when', l.readWhen] : null] },
    ]} />
    <div className="loop-lh">{l.title}</div>
    {/* a git lesson carries the book's opening only: the rest is behind the source link */}
    <Excerpt text={l.text} cut={l.source === 'git'} />
    {id && <div className="loop-actions">{l.state === 'dismissed' ? <Btn sm onClick={() => act('reopen')}>Reopen</Btn> : l.state === 'open' ? <Btn sm onClick={() => act('dismiss')}>Dismiss</Btn> : null}</div>}
  </div>
}

function CommitsBody({ cs }: { cs: Commit[] }) {
  const { go, openDrawer } = useNav()
  return <div className="loop-detail">{cs.map(c => <div key={c.repo + c.sha} className="loop-commit">
    <div className="loop-row"><span className="loop-subj1">{c.subject}</span><span className="faint mono loop-small">{relTime(c.ts)}</span></div>
    {c.books.filter(b => !b.index).map(b => <div key={b.path} className="loop-book"><span className={`loop-st st-${b.status}`}>{b.status}</span>
      {b.status === 'D' ? <span className="faint mono">{b.path}</span> : <button className="lnk mono loop-link" onClick={() => { openDrawer(null); go('library', b.path) }}>{b.path}</button>}</div>)}
  </div>)}</div>
}

function NoLessonBody({ rows }: { rows: NoLesson[] }) {
  return <table className="kv loop-kv"><tbody>{rows.map((n, i) => <tr key={i}><td className="mono">{deskName(n.desk)}</td><td>{n.reason}<div className="faint mono loop-small">{n.subject} · {n.ts ? stamp(n.ts) : '-'}</div></td></tr>)}</tbody></table>
}

function RetroBody({ r }: { r: Retro }) {
  const { go, openDrawer } = useNav()
  const file = `${r.desk}/beliefs.md`
  return <div className="loop-detail">
    <table className="kv loop-kv"><tbody>
      <tr><td>state</td><td>{r.due ? <Tag tone="warn">due</Tag> : <Tag>not due</Tag>}</td></tr>
      <tr><td>last retro</td><td className="mono">{r.stamp.raw ?? 'no stamp line'}</td></tr>
      <tr><td>next bet</td><td>{r.stamp.bet ?? '-'}</td></tr>
      <tr><td>graded</td><td className="mono">{r.graded} ({r.since} since the stamp)</td></tr>
      <tr><td>clock</td><td className="mono">{r.dueAt ? `7-day clock ends ${day(r.dueAt)}` : '-'}</td></tr>
      <tr><td>why</td><td>{r.reasons.join('; ')}</td></tr>
    </tbody></table>
    <div className="cap dsec"><button className="lnk mono loop-link" onClick={() => { openDrawer(null); go('library', file) }}>{file}</button></div>
    <DigestView d={r.digest} />
  </div>
}

/** the newest retro digest (lab/<desk>/retros/<date>.md); an open <FILL> slot is judgment still owed */
function DigestView({ d }: { d: Digest | null | undefined }) {
  const { go, openDrawer } = useNav()
  if (d === undefined) return null
  return <>
    <div className="cap dsec loop-dg-h">
      <span>Digest</span>
      {d && <span className="loop-dg-meta" title={[d.source ?? '', `${d.count} retro file${d.count === 1 ? '' : 's'} on record`].filter(Boolean).join('\n')}>
        <span className="mono">{d.date}</span>{d.through && <span className="mono">through {d.through}</span>}
        {d.fills > 0 && <span className="t-warn" title="<FILL> slots the retro has not replaced yet">{d.fills} fill</span>}
      </span>}
    </div>
    {!d ? <Empty inline title="NONE">no digest on record</Empty> : <>
      <ul className="loop-dg">{d.lines.map((l, i) => <li key={i} className={/<FILL:/.test(l) ? 'fill' : ''}>{l}</li>)}</ul>
      <div><button className="lnk mono loop-link" onClick={() => { openDrawer(null); go('library', d.path) }}>{d.path}</button></div>
    </>}
  </>
}

// ---- lanes ----

/** a card that opens its drawer; a div (never a button) so it can carry its own one-click actions */
function Card({ onClick, children, tone }: { onClick: () => void; children: ReactNode; tone?: string }) {
  return <div role="button" tabIndex={0} className={`card hov loop-card ${tone === 'bad' ? 'l-fail' : tone === 'warn' ? 'l-warn' : tone === 'done' ? 'done' : ''}`}
    onClick={onClick} onKeyDown={e => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onClick() } }}>{children}</div>
}

/** a lane; an empty one is not drawn at all (its funnel tile reads 0) unless opened from that tile */
function Lane({ id, title, n, children, hint, tone, fold, top, tools }: { id: string; title: string; n: number | string; children?: ReactNode; hint?: string; tone?: string; fold?: boolean; top?: ReactNode; tools?: ReactNode }) {
  return <section className={`lane loop-lane l-${id}`} id={`loop-${id}`}>
    <div className="lane-h cap loop-lane-h" title={hint}><span className="t">{title}</span><span className="loop-lane-hr">{tools}<span className={`lane-n ${tone ? `t-${tone}` : ''}`}>{n}</span>
      {fold && <button className="iconbtn loop-lane-x" title="hide: back into its tile" aria-label="hide" onClick={() => laneOpen.set('')}><Icon name="x" /></button>}</span></div>
    {top}
    <div className="lane-b loop-lane-b">{children}</div>
  </section>
}

type LaneId = 'review' | 'proposals' | 'watching' | 'decided'
/** which foldable lanes hold nothing under the agent filter; review is unknown (null) until its queue loads */
function emptyLanes(d: Lanes, who: string, rq: Queue | null | undefined): Record<LaneId, boolean | null> {
  const ps = d.proposals.filter(p => !who || p.watch.agents.includes(who) || p.source.includes(`agent:${who}`))
  return {
    review: rq ? !rq.open && !rq.items.length : null,
    proposals: !ps.some(p => p.state === 'proposed') && !d.proposalsBad.length,
    watching: !ps.some(p => p.state === 'applied' || p.state === 'watching'),
    decided: !ps.some(p => ['kept', 'reverted', 'vetoed'].includes(p.state)),
  }
}

/** bring a lane into view (opening it first when it is empty and so not drawn) and flash it */
function jumpLane(id: string) {
  const go = () => {
    const el = document.getElementById(`loop-${id}`)
    if (!el) return
    el.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash')
  }
  if (!document.getElementById(`loop-${id}`)) { laneOpen.set(id); requestAnimationFrame(() => requestAnimationFrame(go)) } else go()
}

/** book commits against stand-downs that filed no lesson: one slim heat bar under Learned's header,
 *  the two counts at its ends; each half (and each count) opens its list */
function LessonRatio({ books, none, onBooks, onNone }: { books: number; none: number | null; onBooks: () => void; onNone: () => void }) {
  const miss = 'the ops store did not answer: no-lesson count unknown'
  if (!books && !none && none !== null) return null
  const n = none ?? 0
  return <div className="loop-ratio">
    <button className="loop-ratio-e b" title={`${books} book commit${books === 1 ? '' : 's'} in this range`} onClick={onBooks} disabled={!books}>{books}</button>
    <div className="loop-ratio-bar">
      {books > 0 && <button className="b" style={{ flexGrow: books }} onClick={onBooks} title={`${books} book commit${books === 1 ? '' : 's'} in this range`} />}
      {n > 0 && <button className="n" style={{ flexGrow: n }} onClick={onNone} title={`${n} stand-down${n === 1 ? '' : 's'} with no lesson`} />}
      {none === null && <span className="u" style={{ flexGrow: Math.max(1, books) }} title={miss} />}
    </div>
    {none === null ? <span className="loop-ratio-e faint" title={miss}>-</span>
      : <button className="loop-ratio-e n" title={`${n} stand-down${n === 1 ? '' : 's'} that filed no lesson, with the reason given`} onClick={onNone} disabled={!n}>{n}</button>}
  </div>
}

/** is a pass running right now (this tab started it)? not persisted: a reload mid-pass must not show a live dot forever */
const passing = (() => {
  let v = false
  const subs = new Set<() => void>()
  return {
    set: (x: boolean) => { v = x; subs.forEach(f => f()) },
    use: () => useSyncExternalStore(f => { subs.add(f); return () => { subs.delete(f) } }, () => v),
  }
})()

/** the pass's three counts, from its recorded result, else read back off its summary line; null = unknown */
function passStats(p: Pass): { read: number | null; books: number | null; ideas: number | null } {
  const d = p.detail as (Pass['detail'] & { metrics?: { rows?: number }; captured?: { inbox?: number; git?: number }; created?: unknown[] }) | null
  const num = (re: RegExp) => { const m = re.exec(p.summary); return m ? Number(m[1]) : null }
  const cap = d?.captured
  return {
    read: typeof d?.metrics?.rows === 'number' ? d.metrics.rows : num(/(\d+)\s+(?:metric\s+)?rows?\b/),
    books: cap && typeof cap.inbox === 'number' && typeof cap.git === 'number' ? cap.inbox + cap.git : num(/(\d+)\s+lessons?\b/),
    ideas: Array.isArray(d?.created) ? d.created.length : num(/(\d+)\s+(?:proposed|proposals?)\b/),
  }
}

/** the explorer's PASS card: three micro stats (number over caption), a live dot while a pass runs, when the last one ran */
function PassCard({ p }: { p: Pass }) {
  const running = passing.use()
  const s = passStats(p)
  const cell = (n: number | null, cap: string, t: string) => <div className="ms" title={n === null ? `${t}: unknown` : `${n} ${t}`}>
    <b className={n === null ? 'u' : ''}>{n === null ? '-' : n}</b><i>{cap}</i>
  </div>
  const errs = p.detail?.errors ?? []
  return <div className={`card loop-ps ${p.ok ? '' : 'l-fail'}`} title={[`${p.trigger} · ${stamp(p.ts)}`, p.summary, ...(p.detail?.notes ?? []), ...errs].join('\n')}>
    <div className="loop-ps-row">
      {cell(s.read, 'read', 'metric rows read')}
      {cell(s.books, 'books', 'lessons captured')}
      {cell(s.ideas, 'ideas', 'proposed')}
      <div className="loop-ps-r">
        {running && <Dot s="run" title="a pass is running" />}
        {!p.ok && <span className="t-fail">failed</span>}
        <span className="loop-ps-ago" title={stamp(p.ts)}>{relTime(p.ts)}</span>
      </div>
    </div>
    {errs.map(e => <FailLine key={e} what="pass" detail={e} />)}
  </div>
}

// ---- THE FUNNEL: the flow as tiles, one click opens its lane ----

function FunnelStrip({ review, learned, f, shown }: { review: number | null; learned: { open: number; all: number }; f: Funnel; shown: (id: LaneId) => boolean }) {
  const tile = (id: string, n: number | null, label: string, hint: string, lane: string, extra?: ReactNode) =>
    <button key={id} className={`loop-fn f-${id} ${n === 0 ? 'zero' : ''} ${lane !== 'learned' && !shown(lane as LaneId) ? 'shut' : ''}`} title={hint}
      onClick={() => jumpLane(lane)}>
      <b>{n === null ? '-' : n}</b><i>{label}</i>{extra}
    </button>
  const done = f.kept + f.reverted + f.vetoed
  const arrow = <svg className="loop-fn-ar" viewBox="0 0 10 16" aria-hidden><path d="M2 3l5 5-5 5" /></svg>
  return <div className="loop-funnel" role="group" aria-label="the loop's flow">
    {tile('review', review, 'Review', review === null ? 'review queue: not read yet' : `${review} flagged turn${review === 1 ? '' : 's'} ungraded; grading is optional, nothing waits on it`, 'review')}
    <span className="loop-fn-gap" />
    {tile('learned', learned.all, 'Learned', `${learned.all} lesson${learned.all === 1 ? '' : 's'} captured in this range, ${learned.open} open`, 'learned')}
    {arrow}
    {tile('proposed', f.proposed, 'Proposed', `${f.proposed} proposal${f.proposed === 1 ? '' : 's'} waiting to be applied or vetoed`, 'proposals')}
    {arrow}
    {tile('watching', f.watching, 'Watching', `${f.watching} applied change${f.watching === 1 ? '' : 's'} on probation`, 'watching')}
    {arrow}
    <div className="loop-fn-out">
      <div className="loop-fn-outs">
        {tile('kept', f.kept, 'Kept', `${f.kept} kept${f.unjudged ? `, ${f.unjudged} of them unjudged (too few scored events to tell)` : ''}`, 'decided',
          f.unjudged ? <span className="pill warn loop-fn-u" title={`${f.unjudged} kept unjudged`}>{f.unjudged}?</span> : null)}
        {tile('reverted', f.reverted, 'Reverted', `${f.reverted} reverted`, 'decided')}
        {tile('vetoed', f.vetoed, 'Vetoed', `${f.vetoed} vetoed`, 'decided')}
      </div>
      {/* the decided split as one bar; an empty record is a hollow track, never a green one */}
      <span className={`loop-fn-bar ${done ? '' : 'hollow'}`} title={done ? `kept ${f.kept} · reverted ${f.reverted} · vetoed ${f.vetoed}` : 'nothing decided yet'}>
        {f.kept - f.unjudged > 0 && <i className="k" style={{ flexGrow: f.kept - f.unjudged }} />}
        {f.unjudged > 0 && <i className="u" style={{ flexGrow: f.unjudged }} />}
        {f.reverted > 0 && <i className="r" style={{ flexGrow: f.reverted }} />}
        {f.vetoed > 0 && <i className="v" style={{ flexGrow: f.vetoed }} />}
      </span>
    </div>
  </div>
}

// ---- LEARNED: an agent x day grid (click a cell for its lessons), or the timeline ----

const learnedView = shared<'grid' | 'list'>('loop.learned', 'grid')
const GRID_ICON = 'M2.5 2.5h4v4h-4zM9.5 2.5h4v4h-4zM2.5 9.5h4v4h-4zM9.5 9.5h4v4h-4z'

function LessonList({ lessons }: { lessons: Captured[] }) {
  const { openDrawer } = useNav()
  return <>{lessonDays(lessons, l => l.ts, Date.now()).map(g => <section key={g.label} className="tl-day">
    <div className="cap tl-dh">{g.label}</div>
    <div className="tl">{g.items.map(l => <button key={l.key} className={`tl-r edge loop-lr ${l.state !== 'open' ? 'done' : ''}`} style={l.agent ? catVar(categoryOf(l.agent)) : undefined}
      title={`${l.title}\n${l.agent ?? 'unattributed'} · ${l.source === 'git' ? l.ref : 'inbox'}${l.state !== 'open' ? ` · ${l.state}` : ''}\n${stamp(l.ts)}`}
      onClick={() => openDrawer({ title: l.title, body: <LessonBody l={l} /> })}>
      <AgentMark id={l.agent} />
      <span className="nm">{l.title}</span>
      <span className={`pill lbl loop-srcc s-${l.source}`}>{l.source}</span>
      <span className="r">{relTime(l.ts)}</span>
    </button>)}</div>
  </section>)}</>
}

function LessonGrid({ lessons, days }: { lessons: Captured[]; days: number | null }) {
  const { openDrawer } = useNav()
  const [who, setWho] = agentF.use()
  const g = lessonGrid(lessons, l => l.ts, l => l.agent, days, Date.now())
  const tot = g.cols.map((_, i) => g.rows.reduce((s, r) => s + r.cells[i].length, 0))
  const peak = Math.max(1, ...tot)
  const list = (title: string, ls: Captured[]) => openDrawer({ title, body: <div className="loop-detail"><LessonList lessons={ls} /></div> })
  const when = (i: number) => g.cols[i].label
  return <div className="loop-lg" style={{ '--n': g.cols.length } as CSSProperties}>
    {/* the day totals as bars over the grid */}
    <span />
    {tot.map((n, i) => <button key={`t${i}`} className="loop-lg-h" disabled={!n} title={`${when(i)}: ${n} lesson${n === 1 ? '' : 's'}`}
      onClick={() => list(`Learned ${when(i)}`, g.rows.flatMap(r => r.cells[i]))}><i style={{ height: `${n ? Math.max(12, (n / peak) * 100) : 0}%` }} /></button>)}
    <span className="loop-lg-t faint" title={`${lessons.length} in all`}>{lessons.length}</span>
    {g.rows.map(r => <Fragment key={r.agent ?? '?'}>
      <button className={`loop-lg-a ${who && r.agent === who ? 'on' : ''}`} title={r.agent ? `${r.agent}: ${r.total} lesson${r.total === 1 ? '' : 's'} (click to show only this agent)` : `unattributed: ${r.total}`}
        onClick={() => r.agent && setWho(who === r.agent ? '' : r.agent)}><AgentMark id={r.agent} /></button>
      {r.cells.map((c, i) => <button key={i} className={`loop-lg-c ${heat(c.length, g.max) > 0.6 ? 'hi' : ''}`} disabled={!c.length}
        style={{ ...(r.agent ? catVar(categoryOf(r.agent)) : { '--c': 'var(--dim)' }), '--h': `${Math.round(heat(c.length, g.max) * 100)}%` } as unknown as CSSProperties}
        title={`${r.agent ?? 'unattributed'} · ${when(i)}: ${c.length} lesson${c.length === 1 ? '' : 's'}${c.length ? `\n${c.slice(0, 6).map(l => `- ${l.title}`).join('\n')}${c.length > 6 ? `\n+${c.length - 6} more` : ''}` : ''}`}
        onClick={() => list(`${r.agent ?? 'unattributed'} ${when(i)}`, c)}>{c.length || ''}</button>)}
      <span className="loop-lg-t">{r.total}</span>
    </Fragment>)}
    <span />
    <span className="loop-lg-x" style={{ gridColumn: `2 / span ${g.cols.length}` }}>
      <span title={g.cols[0].label}>{g.cols[0].label.slice(0, 5)}</span><span>today</span>
    </span>
    <span />
  </div>
}

function LearnedLane({ d, lessons }: { d: Lanes; lessons: Captured[] }) {
  const { openDrawer } = useNav()
  const [view, setView] = learnedView.use()
  const openL = lessons.filter(l => l.state === 'open')
  const days = d.range === '7d' ? 7 : d.range === '30d' ? 30 : null
  const tools = <span className="loop-vw" role="group" aria-label="view">
    <button className={`iconbtn ${view === 'grid' ? 'on' : ''}`} title="grid: agent by day" aria-pressed={view === 'grid'} onClick={() => setView('grid')}><svg className="ico" viewBox="0 0 16 16"><path d={GRID_ICON} /></svg></button>
    <button className={`iconbtn ${view === 'list' ? 'on' : ''}`} title="list: every lesson" aria-pressed={view === 'list'} onClick={() => setView('list')}><Icon name="row" /></button>
  </span>
  return <Lane id="learned" title="Learned" tools={tools} top={<LessonRatio books={d.commits.length} none={d.noLesson?.length ?? null}
      onBooks={() => openDrawer({ title: 'Book commits', body: <CommitsBody cs={d.commits} /> })}
      onNone={() => openDrawer({ title: 'No lesson', body: <NoLessonBody rows={d.noLesson ?? []} /> })} />}
    n={openL.length === lessons.length ? lessons.length : `${openL.length} / ${lessons.length}`} tone={openL.length ? 'ok' : ''}
    hint="lessons captured: POST /api/loop/lesson (inbox) and books added under library/ (git). open / all. The bar: book commits against stand-downs with no lesson">
    {d.commitErrors.map(e => <FailLine key={e} what="commits" detail={e} />)}
    {lessons.length === 0 ? <Empty inline center title="NONE" /> : view === 'grid' ? <LessonGrid lessons={lessons} days={days} /> : <LessonList lessons={lessons} />}
  </Lane>
}

// ---- PROPOSALS / WATCHING / DECIDED: one card each, the watch drawn, never worded ----

const gateLine = (gs: Gate[]) => gs.map(g => `${g.ok ? 'ok' : 'no'}  ${g.name}${g.note ? `: ${g.note}` : ''}`).join('\n')

/** the score's move as a chip: a signed delta only when both sides were measured on enough events;
 *  otherwise NO SIGNAL (a thin 1.00 -> 1.00 is not a verdict and never drawn as one) */
function ScoreChip({ p, tol }: { p: Proposal; tol: number }) {
  const r = p.read
  if (!r || r.signal === null) return null
  const ba = `before ${fmt(p.watch.before?.score)} -> after ${fmt(p.watch.after?.score)}`
  if (r.signal !== 'read' || r.delta === null) {
    const why = r.signal === 'unmeasured' ? 'a side has no scored events at all' : `scored events: ${r.n.before ?? '-'} before, ${r.n.after ?? '-'} after; ${r.n.min} needed a side`
    return <span className="pill lbl loop-nosig" title={`no signal yet: ${why}\n${ba} (not a result)`}>no signal</span>
  }
  const tone = r.delta < -tol ? 'fail' : r.delta > tol ? 'ok' : ''
  const txt = `${r.delta >= 0 ? '+' : '-'}${Math.abs(r.delta).toFixed(2)}`
  return <span className={`pill lbl loop-delta ${tone}`} title={`${ba} · ${r.verdict ?? ''} (tolerance ${tol})\n${r.n.before} / ${r.n.after} scored events`}>{txt}</span>
}

/** the watch window as two meters: days elapsed of its span, and the thinner side's scored events against minEvents */
function WatchBars({ p }: { p: Proposal }) {
  const r = p.read
  if (!r || !r.days) return null
  const nMin = r.n.before === null || r.n.after === null ? null : Math.min(r.n.before, r.n.after)
  const enough = nMin !== null && nMin >= r.n.min
  // the day in progress counts: 14 hours in is day 1 of 7, never day 0
  const sp = Math.round(r.days.span), el = Math.min(sp, Math.max(r.days.elapsed > 0 ? 1 : 0, Math.ceil(r.days.elapsed)))
  return <div className="loop-wb">
    <span className="loop-wb-r" title={`day ${el} of ${sp}: window ${day(p.watch.from)} to ${day(p.watch.until)}${p.watch.extended ? `, extended ${p.watch.extended}x for no signal` : ''}`}>
      <Icon name="clock" /><Meter v={sp ? r.days.elapsed / r.days.span : null} tone="accent" grow sm /><b>{el}/{sp}d</b>
    </span>
    <span className="loop-wb-r" title={`scored events (turns, graded runs, board outcomes, your grades): ${r.n.before ?? '-'} before, ${r.n.after ?? '-'} after; ${r.n.min} needed a side to judge`}>
      <Icon name="scan" /><Meter v={nMin === null ? null : Math.min(1, nMin / r.n.min)} tone={enough ? 'ok' : 'warn'} grow sm /><b>{nMin ?? '-'}/{r.n.min}</b>
    </span>
  </div>
}

const OUTCOME_TONE: Record<string, 'ok' | 'warn' | 'faint'> = { kept: 'ok', reverted: 'warn', vetoed: 'faint' }

/** a cohort as glyphs (up to four), the names in the tooltip */
function AgentStack({ ids }: { ids: string[] }) {
  if (!ids.length) return null
  return <span className="loop-stack" title={`cohort: ${ids.join(', ')}`}>{ids.slice(0, 4).map(a => <Glyph key={a} id={a} />)}{ids.length > 4 && <span className="faint mono loop-small">+{ids.length - 4}</span>}</span>
}

function PCard({ p, tol }: { p: Proposal; tol: number }) {
  const { openDrawer } = useNav()
  const blocked = p.gates.filter(g => !g.ok).length
  const r = p.read
  const worse = (p.state === 'watching' || p.state === 'applied') && r?.signal === 'read' && r.verdict === 'worse'
  const name = p.title.replace(/^(promote|boot|unread): /, '')
  const stop = (e: MouseEvent) => e.stopPropagation()
  return <Card tone={worse ? 'bad' : unjudged(p) ? 'warn' : ''} onClick={() => openDrawer({ title: `${p.id} ${p.title}`, body: <ProposalBody id={p.id} /> })}>
    <div className="loop-row"><span className="loop-subj1" title={p.title}>{name}</span><span className="loop-id">{p.id}</span></div>
    {p.state === 'proposed' && <div className="loop-pc-l2">
      <span title={p.kind === 'promote' ? 'promote a lesson filed by 2+ agents into a shared book' : 'the loop may not write it: the agent whose writes cover it checks and lands it'}><Tag>{KIND[p.kind]}</Tag></span>
      {p.gates.length > 0 && <span className="loop-gates" title={gateLine(p.gates)}>{p.gates.map(g => <i key={g.name} className={g.ok ? 'ok' : 'no'} />)}</span>}
      {p.auto && p.kind === 'promote' && !blocked && <span className="pill accent" title="the loop may apply it by itself">auto</span>}
      {p.review && <ReviewChip r={p.review} />}
      {!p.review && advisory(p) && p.reviewer && !p.reviewer.agent && <span className="pill lbl ask" title={`waits for you: ${p.reviewer.why ?? ''}`}>yours</span>}
      <span className="loop-pc-r" onClick={stop}>{withAgent(p) ? null : <Actions p={p} />}</span>
    </div>}
    {(p.state === 'watching' || p.state === 'applied') && <>
      <WatchBars p={p} />
      <div className="loop-pc-l2">
        <ScoreChip p={p} tol={tol} />
        {p.pinned && <span className="pill accent" title="pinned: kept whatever the watch reads">pinned</span>}
        {p.review && <ReviewChip r={p.review} />}
        <AgentStack ids={p.watch.agents} />
        {worse && <span className="loop-pc-r" onClick={stop}><Actions p={p} /></span>}
      </div>
    </>}
    {['kept', 'reverted', 'vetoed'].includes(p.state) && <div className="loop-pc-l2">
      {unjudged(p) ? <span className="pill lbl warn loop-nosig" title={UNJUDGED_T}>unjudged</span> : <span className={`pill lbl ${OUTCOME_TONE[p.state]}`} title={`state ${p.state}`}>{p.state}</span>}
      {!unjudged(p) && <ScoreChip p={p} tol={tol} />}
      {p.pinned && <span className="pill accent" title="pinned">pinned</span>}
      {p.review && <ReviewChip r={p.review} />}
      <span className="loop-pc-r faint mono loop-small" title={p.updated}>{relTime(p.updated)}</span>
    </div>}
  </Card>
}

/** the board's Review lane as the loop sees it: each item, and who has it (or why it waits for the owner) */
function BoardReviewLane({ rows }: { rows: BoardRev[] }) {
  const { go } = useNav()
  const out = rows.filter(r => r.state === 'with' || r.state === 'checking').length
  return <Lane id="boardreview" title="Board review" n={rows.length} tone={rows.some(r => r.state === 'owner') ? 'warn' : ''}
    hint="items in the Board's Review lane. A pass sends each to its owner agent in a fresh conversation: it closes the item (a pushed commit, a green area) or returns it to ready. Nobody to review it = it moves to Needs you with the reason">
    {rows.map(r => <Card key={r.id} tone={r.state === 'owner' ? 'warn' : ''} onClick={() => go('board', r.id)}>
      <div className="loop-row"><span className="loop-subj1" title={r.title}>{r.title}</span><span className="loop-id">{r.id}</span></div>
      <div className="loop-pc-l2">
        {r.state === 'unsent' && <span className="pill lbl" title={`not sent yet: a pass sends a few at a time, oldest first (${out} out now)`}>waiting</span>}
        {(r.state === 'with' || r.state === 'checking') && <span className="pill accent" title={`${r.agent} has it since ${r.at ?? '?'} (try ${r.tries}), conversation ${r.conversation ?? '?'}${r.state === 'checking' ? '; its done claim is being checked' : ''}`}>{r.state === 'checking' ? 'checking' : r.agent}</span>}
        {r.state === 'owner' && <span className="pill lbl ask" title={`waits for you: ${r.why ?? ''}`}>yours</span>}
        {r.returns > 0 && <span className="pill lbl warn" title={`returned to ready ${r.returns} time${r.returns === 1 ? '' : 's'} already`}>{r.returns}x back</span>}
        <span className="loop-pc-r faint mono loop-small" title={r.updated}>{relTime(r.updated)}</span>
      </div>
    </Card>)}
  </Lane>
}

function ReviewLane({ fold }: { fold?: boolean }) {
  const q = useQueue()
  if (!q.data) return <section className="lane loop-lane l-review" id="loop-review">
    <div className="lane-h cap loop-lane-h"><span className="t">Review</span><span className="lane-n">{q.error ? <span className="t-fail" title={q.error}>failed</span> : ''}</span></div>
    <div className="lane-b loop-lane-b">{q.error ? <Empty inline state="failed">{q.error}</Empty> : <Skeleton kind="cards" n={3} />}</div>
  </section>
  const n = q.data.open
  return <Lane id="review" title="Review" fold={fold} n={n} tone="" hint="flagged turns: a check failed, a ledger was written, or the 5% sample. Grading is optional and nothing waits on it; a grade feeds the taste score. The buttons grade in one click; or click a card, then j / k move, g good, b bad, l label, u undo">
    <ReviewCards q={q.data} />
  </Lane>
}

function Main() {
  const q = useLanes()
  const rq = useQueue()
  const [who] = agentF.use()
  const [opened] = laneOpen.use()
  return <Load q={q} skel="cards">{d => {
    const empty = emptyLanes(d, who, rq.data)
    const show = (id: LaneId) => empty[id] !== true || opened === id
    const fold = (id: LaneId) => empty[id] === true && opened === id
    const mine = (a: string | null) => !who || a === who
    const mineP = (p: Proposal) => !who || p.watch.agents.includes(who) || p.source.includes(`agent:${who}`)
    const lessons = d.lessons.filter(l => mine(l.agent))
    const ps = d.proposals.filter(mineP)
    const proposed = ps.filter(p => p.state === 'proposed').sort((a, b) => Number(b.auto) - Number(a.auto) || b.id.localeCompare(a.id))
    const watching = ps.filter(p => p.state === 'applied' || p.state === 'watching')
    const decided = ps.filter(p => ['kept', 'reverted', 'vetoed'].includes(p.state)).sort((a, b) => b.updated.localeCompare(a.updated))
    const worse = watching.filter(p => p.read?.signal === 'read' && p.read.verdict === 'worse').length
    const thin = watching.filter(p => p.read && p.read.signal !== null && p.read.signal !== 'read').length
    const unj = decided.filter(unjudged).length
    const f = funnel(ps.map(p => ({ state: p.state, unjudged: unjudged(p) })))
    const tol = d.config.tolerance
    const boardRev = d.boardReview ?? []
    const flow = show('proposals') || show('watching') || show('decided') || boardRev.length > 0
    return <div className="loop-main">
      <FunnelStrip review={rq.data ? rq.data.open : null} learned={{ open: lessons.filter(l => l.state === 'open').length, all: lessons.length }} f={f} shown={show} />
      <div className={`loop-body ${show('review') ? '' : 'solo'}`}>
        {show('review') && <ReviewLane fold={fold('review')} />}
        <div className="loop-right">
          <LearnedLane d={d} lessons={lessons} />
          {flow && <div className="loop-flow">
            {boardRev.length > 0 && <BoardReviewLane rows={boardRev} />}
            {show('proposals') && <Lane id="proposals" title="Proposals" fold={fold('proposals')} n={proposed.length} tone={proposed.length ? 'warn' : ''} hint={`what the last pass wants to change. ${d.config.autoApply ? 'Auto: the loop applies what it may and sends the rest to the agent whose writes cover it' : 'Manual: nothing moves until you Apply, Send or Veto'}`}>
              {d.proposalsBad.map(b => <FailLine key={b.file} what={b.file} detail={`${b.file}: ${b.error}`} />)}
              {proposed.map(p => <PCard key={p.id} p={p} tol={tol} />)}
              {!proposed.length && !d.proposalsBad.length && <Empty inline center title="NONE" />}
            </Lane>}
            {show('watching') && <Lane id="watching" title="Watching" fold={fold('watching')} n={watching.length} tone={worse ? 'fail' : ''}
              tools={<>{worse > 0 && <span className="pill fail" title={`${worse} reading worse`}>{worse}</span>}{thin > 0 && <span className="pill lbl loop-nosig" title={`${thin} with no signal yet: too few scored events to judge`}>{thin}?</span>}</>}
              hint={`applied changes on probation: ${d.config.watchDays} days or ${d.config.watchEvents} turns, worse = score down more than ${d.config.tolerance}${d.config.minEvents ? `, judged only on ${d.config.minEvents}+ events a side${d.config.noSignalExtends ? `, a thin watch extended ${d.config.noSignalExtends}x` : ''}` : ''}`}>
              {watching.map(p => <PCard key={p.id} p={p} tol={tol} />)}
              {!watching.length && <Empty inline center title="NONE" />}
            </Lane>}
            {show('decided') && <Lane id="decided" title="Decided" fold={fold('decided')} n={decided.length} tone={unj ? 'warn' : ''}
              tools={unj > 0 ? <span className="pill lbl warn loop-nosig" title={`${unj} kept unjudged: too few scored events to tell`}>{unj}?</span> : null}
              hint={`kept, reverted, vetoed${unj ? `; ${unj} kept unjudged: too few scored events to tell` : ''}`}>
              {decided.map(p => <PCard key={p.id} p={p} tol={tol} />)}
              {!decided.length && <Empty inline center title="NONE" />}
            </Lane>}
          </div>}
        </div>
      </div>
    </div>
  }}</Load>
}

function Explorer() {
  const q = useLanes()
  const [who, setWho] = agentF.use()
  const { openDrawer } = useNav()
  return <Load q={q} skel="cards">{d => {
    const agents = new Map<string, number>()
    for (const l of d.lessons) if (l.agent) agents.set(l.agent, (agents.get(l.agent) ?? 0) + 1)
    for (const p of d.proposals) for (const a of p.watch.agents) agents.set(a, agents.get(a) ?? 0)
    const top = Math.max(1, ...agents.values())
    const due = d.retros.filter(r => r.due)
    const live = d.retros.filter(r => r.due || r.stamp.date || r.graded > 0 || r.digest)
    const idle = d.retros.length - live.length
    // one chip per desk, grouped by family (platform/..., research/...); a family of one sits with the loose desks
    const chips = live.map(r => ({ r, c: retroChip(r) }))
    const size = (g: string) => chips.filter(y => y.c.group === g).length
    const fam = new Map<string, typeof chips>()
    for (const x of chips) { const k = x.c.group && size(x.c.group) > 1 ? x.c.group : ''; fam.set(k, [...(fam.get(k) ?? []), x]) }
    const fams = [...fam.entries()].sort((a, b) => Number(a[0] !== '') - Number(b[0] !== '') || a[0].localeCompare(b[0]))
    return <>
      <Group label="Agents" right={<span title="agents with a lesson or a watched change; each row counts its lessons">{agents.size || ''}</span>}>
        {agents.size === 0 && <div className="loop-quiet"><Empty inline title="NONE YET" /></div>}
        {[...agents.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([k, n]) => <button key={k} className={`row loop-ag ${who === k ? 'on' : ''}`} title={`${k}: ${n} lesson${n === 1 ? '' : 's'} (click to show only this agent)`} onClick={() => setWho(who === k ? '' : k)}>
          <Glyph id={k} /><span className="nm">{k}</span>
          <span className="loop-ag-bar" style={catVar(categoryOf(k))}><i style={{ width: `${(n / top) * 100}%` }} /></span>
          <span className="r">{n || ''}</span>
        </button>)}
      </Group>
      <Group label="Retros" right={<span className="loop-retro-n" title={`${due.length} due${idle ? `\n${idle} idle desk${idle === 1 ? '' : 's'} (no runs, no retro) not drawn` : ''}${d.retroProbe ? `\nprobe ${d.retroProbe.status}: ${d.retroProbe.reading}` : ''}`}>
        {due.length > 0 && <span className="pill warn">{due.length}</span>}{d.retroProbe && d.retroProbe.status !== 'ok' && <Dot s={d.retroProbe.status} title={`probe ${d.retroProbe.status}: ${d.retroProbe.reading}`} />}</span>}>
        {live.length === 0 ? <div className="loop-quiet"><Empty inline title="NONE" /></div> : <div className="loop-rt">
          {fams.map(([k, xs]) => <div key={k || '.'} className="loop-rt-g">
            {k && <span className="cap loop-rt-gl">{k}</span>}
            <div className="loop-rt-cs">{[...xs].sort((a, b) => a.c.name.localeCompare(b.c.name)).map(({ r, c }) =>
              <button key={r.desk} className={`loop-rt-c ${c.tone}`} title={`${deskName(r.desk)}: ${c.tone === 'due' ? 'retro due' : c.tone === 'fresh' ? `last retro ${r.stamp.date}` : 'nothing to grade'}\n${r.reasons.join('; ')}`}
                onClick={() => openDrawer({ title: deskName(r.desk), body: <RetroBody r={r} /> })}>
                <span>{c.name}</span>{c.mark && <i>{c.mark}</i>}
              </button>)}</div>
          </div>)}
        </div>}
      </Group>
      <Group label="Pass">
        {d.pass === null ? <div className="loop-quiet"><Empty inline title="NEVER RAN">no pass has run</Empty></div> : <PassCard p={d.pass} />}
      </Group>
    </>
  }}</Load>
}

function Head() {
  const [range, setRange] = useRange()
  const [who, setWho] = agentF.use()
  const q = useLanes()
  const { toast } = useNav()
  const [busy, setBusy] = useState(false)
  const [flip, setFlip] = useState(false)
  const setMode = async (m: 'auto' | 'manual') => {
    setFlip(true)
    try { await api('/api/loop/config', { body: { autoApply: m === 'auto' } }); toast(m === 'auto' ? 'loop: auto' : 'loop: manual') }
    catch (e) { toast(`mode: ${(e as Error).message}`, true) }
    finally { setFlip(false) }
  }
  const run = async () => {
    setBusy(true); passing.set(true)
    try { const r = await api<{ ok: boolean; summary: string; errors: string[] }>('/api/loop/pass', { body: { trigger: 'owner' } }); toast(`pass: ${r.summary}`, !r.ok) }
    catch (e) { toast(`pass: ${(e as Error).message}`, true) }
    finally { setBusy(false); passing.set(false) }
  }
  const cfg = q.data?.config
  // the review count and the empty lanes are not repeated here: the Review lane header carries its
  // count, and the fold strip at the grid's right edge carries every empty lane
  return <>
    {who && <Btn sm kind="ghost" title="show every agent" onClick={() => setWho('')}>{who} x</Btn>}
    {cfg && <span className={`loop-mode ${flip ? 'busy' : ''}`} title={`Auto: every pass applies what the loop may write, sends the rest to the agent whose writes cover it (it lands or declines), and reverts a change that reads worse.\nManual: the loop proposes and watches; nothing moves until you click.\nwatch ${cfg.watchDays}d or ${cfg.watchEvents} turns, tolerance ${cfg.tolerance}${cfg.minEvents ? `, ${cfg.minEvents}+ events a side` : ''}${cfg.noSignalExtends !== undefined ? `, no signal extends ${cfg.noSignalExtends}x then closes unjudged` : ''}\n${cfg.source ? `from ${cfg.source}` : 'no "loop" key in app/loop/config.json, app/schedule.json or repos.json: defaults'}`}>
      <Seg value={cfg.autoApply ? 'auto' : 'manual'} onChange={m => { if (!flip && (m === 'auto') !== cfg.autoApply) void setMode(m) }} options={[{ id: 'auto', label: 'Auto' }, { id: 'manual', label: 'Manual' }]} />
    </span>}
    <Btn disabled={busy} title="measure, capture, propose, watch - now" onClick={run}>{busy ? 'Passing' : 'Pass'}</Btn>
    <Seg value={range} onChange={setRange} options={RANGES.map(r => ({ id: r.id, label: r.label }))} />
  </>
}

export const room: RoomDef = {
  id: 'loop',
  label: 'Loop',
  title: 'Loop',
  icon: <><path d="M20 12a8 8 0 1 1-3-6.2"/><path d="M20 4v5h-5"/></>,
  Explorer,
  Main,
  Head,
  useBadge: () => {
    // what needs the owner: manual-mode proposals and a worse watch the loop could not revert (never the optional review queue)
    const q = useApi<{ proposed: number; worse: number }>('/api/loop/badge', ['loop'])
    const n = (q.data?.proposed ?? 0) + (q.data?.worse ?? 0)
    return n ? { n, tone: 'ask' } : null
  },
}

