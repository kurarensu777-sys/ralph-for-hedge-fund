import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { ops, type Queryable } from '../db.ts'
import { chaptersOf, splitRef } from '../../shared/bookmeta.ts'
import type { Agent, Repo, Shelf } from '../../shared/types.ts'
import { git } from '../git/run.ts'
import { scanBooks } from '../library/scan.ts'
import { type Captured, fromGit, fromInbox, listInbox, setLessonState } from './capture.ts'
import { MAX_SENDS, type StartAgent, pending, promptFor, provenCommit, reviewerOf, stale } from './dispatch.ts'
import { boardPass } from './boardreview.ts'
import type { Scope, CommitVerdict } from './commitcheck.ts'
import { type LoopConfig, railFor } from './config.ts'
import { GitOpError, commitPaths, repoOf, revertChange, trailers } from './gitops.ts'
import * as M from './metrics.ts'
import { type TodoReport, todoLine, todoReport } from './todos.ts'
import { type Proposal, type Review, type State, type Window, changeOf, list, logLine, nextId, read, LOOP_REL, relOf, write } from './proposals.ts'
import { type Draft, bookInfoFrom, bootDrafts, promoteDrafts, unreadDrafts, withSeriesRow } from './rules.ts'
import { bookRoots, lessons } from './sources.ts'

/**
 * THE LOOP ENGINE. A pass = measure -> capture -> propose -> (apply) -> watch. Every write lands
 * under the rails (config.railFor): books inside a registered shelf root (ctx.shelves, the Library
 * room's derivation; app/library included since B-0069, their change
 * committed inside that sub-repo, gitops.repoOf) and the loop's own app/loop/records/ folder. The proposal FILE is the state; the database holds counts, the inbox and the pass log.
 *
 *   proposed --apply--> applied --(watch opens)--> watching --window closes--> kept
 *       |--send (auto: what the loop may not write)--> the owning agent lands it (applied, watched)
 *       |                                                 or declines it (vetoed)
 *       |                                              |--no signal: extend (noSignalExtends), then kept, unjudged
 *       |                                              |--worse + autoApply, not pinned--> reverted
 *       '--veto--> vetoed                              '--owner revert--> reverted
 *
 * Git: the change is one commit of its target paths only (so a revert is exactly those paths), then
 * the loop's records (the proposal file, watch.jsonl, metrics.jsonl) ride in a second commit. Every
 * commit stages explicit paths and carries `Agent: loop` + `Loop-Change: L-NNN`.
 */

export type Ctx = {
  db: Queryable
  fundRoot: string          // the fund repo root (a temp repo in tests)
  agents: Agent[]
  shelves: Shelf[]
  repos: Repo[]
  config: LoopConfig
  now?: () => number
  /** boots the agent a proposal is sent to (dispatch.ts); absent = nothing is sent */
  startAgent?: StartAgent
  /** fundd's port, for the report line in a send's prompt */
  port?: number
  /** lints the commit's own files and runs the tests that cover them on the committed tree (commitcheck.ts); boardreview.ts proves a board item's done verdict with it; absent = none is accepted */
  checkCommit?: (scope: Scope) => Promise<CommitVerdict>
  /** runs check.py for one whole area: the second signal boardreview.ts records on the item, never its verdict */
  runCheck?: (area: string) => Promise<{ ok: boolean; tail: string; text?: string }>
  /** the cockpit's event stream, so the Board and Loop rooms redraw when a pass moves an item */
  publish?: (topic: string, data?: unknown) => void
}

/** the registered shelf roots (the Library room's derivation, server/shelves.ts): the loop's rails */
export const shelfRootsOf = (c: Pick<Ctx, 'shelves'>) => c.shelves.flatMap(s => s.roots)

export class LoopError extends Error { constructor(public status: number, msg: string) { super(msg) } }

const DAY = 86_400_000
const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z')
const clock = (c: Ctx) => (c.now ?? Date.now)()
const OPEN: State[] = ['proposed', 'applied', 'watching']

// one loop operation at a time per fund root (a pass and an owner click never interleave)
const locks = new Map<string, Promise<unknown>>()
export function serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve()
  const next = prev.catch(() => undefined).then(fn)
  locks.set(key, next.catch(() => undefined))
  return next
}

// ---- records: app/loop/records/watch.jsonl, app/loop/records/metrics.jsonl ----

const WATCH_LOG = `${LOOP_REL}/watch.jsonl`
const METRICS_LOG = `${LOOP_REL}/metrics.jsonl`

function append(fundRoot: string, rel: string, lines: string[]) {
  if (!lines.length) return
  const f = join(fundRoot, rel)
  mkdirSync(dirname(f), { recursive: true })
  appendFileSync(f, lines.map(l => l + '\n').join(''))
}

const readOr = (f: string) => { try { return readFileSync(f, 'utf8') } catch { return '' } }

function records(c: Ctx, id: string): string[] {
  return [relOf(id), WATCH_LOG, METRICS_LOG].filter(p => existsSync(join(c.fundRoot, p)))
}

/** the records commit in the repo that holds them (app/loop/records sits in the app repo since
 *  2026-09-25; repoOf finds it), with repo-relative paths, as the sync law says */
async function commitRecords(c: Ctx, id: string, what: string) {
  const { repo, prefix } = repoOf(c.fundRoot, `${LOOP_REL}/x`)
  return commitPaths(repo, records(c, id).map(p => (p.startsWith(prefix) ? p.slice(prefix.length) : p)), `loop: ${id} ${what}`, trailers(id))
}

// ---- the watch: the cohort's pooled score before and after ----

const win = (x: { counts: M.Counts; score: number | null; days: number }): Window => ({ counts: { ...x.counts }, score: x.score, days: x.days })

export function cohortOf(p: Proposal, agents: Agent[]): string[] {
  const books = p.target.map(t => splitRef(t).path)   // a chapter target (`book.md#slug`) reaches whoever boots the book or any of its chapters
  const booting = agents.filter(a => (a.boot ?? []).some(b => p.target.includes(b) || books.includes(splitRef(b).path))).map(a => a.id)
  return [...new Set([...p.watch.agents, ...booting])].sort()
}

export type Verdict = 'better' | 'same' | 'worse' | 'no-signal'

/**
 * worse = the pooled score fell by more than `tolerance`; either side unmeasured = no-signal, and
 * so is either side measured on fewer than `n.min` scored events (M.evidence): on 2026-09-24 the
 * Build cohort held 3 turns in its whole baseline week, and one error after an apply would have
 * read as "worse by 0.33" and auto-reverted a change on noise. Too thin to judge is not a verdict.
 */
export function verdictOf(before: number | null, after: number | null, tolerance: number, n?: { before: number; after: number; min: number }): Verdict {
  if (before === null || after === null) return 'no-signal'
  if (n && (n.before < n.min || n.after < n.min)) return 'no-signal'
  if (after < before - tolerance) return 'worse'
  if (after > before + tolerance) return 'better'
  return 'same'
}

// ---- transitions ----

function mustBe(p: Proposal, states: State[], verb: string) {
  if (!states.includes(p.state)) throw new LoopError(409, `${p.id} is ${p.state}; ${verb} needs ${states.join(' or ')}`)
}

function load(c: Ctx, id: string): Proposal {
  let p: Proposal | null
  try { p = read(c.fundRoot, id) } catch (e) { throw new LoopError(500, `${id}: ${(e as Error).message}`) }
  if (!p) throw new LoopError(404, `no proposal ${id}`)
  return p
}

/** the gates that must hold at the moment of apply, recomputed from the tree as it is now */
export function applyGates(c: Ctx, p: Proposal): string[] {
  const why: string[] = []
  if (p.kind !== 'promote') why.push(`${p.kind} is advisory: the loop never applies it, the owner acts on it`)
  const roots = shelfRootsOf(c)
  for (const t of p.target) { const r = railFor(splitRef(t).path, roots); if (r) why.push(`${t}: ${r}`) }
  const ch = changeOf(p)
  const chapter = chapterTarget(p)
  if (chapter) {
    // a chapter append (B-0347): the book is there, the slug is not, and the text is a chapter of that slug
    if (!ch.book) why.push('the proposal carries no chapter text')
    else if (chaptersOf(ch.book).length !== 1 || chaptersOf(ch.book)[0].slug !== chapter.slug) why.push(`the chapter text is not one \`## \` chapter with the slug ${chapter.slug}`)
    if (!existsSync(join(c.fundRoot, chapter.path))) why.push(`${chapter.path} is not there`)
    else if (chaptersOf(readOr(join(c.fundRoot, chapter.path))).some(x => x.slug === chapter.slug)) why.push(`${chapter.path}#${chapter.slug} already exists`)
    return why
  }
  if (!ch.book || !ch.row) why.push('the proposal carries no book text or series row')
  const [book] = p.target
  if (book && existsSync(join(c.fundRoot, book))) why.push(`${book} already exists`)
  if (p.target.length !== 2 || !/\/_series\.md$/.test(p.target[1] ?? '')) why.push('a promote targets exactly a book and its _series.md')
  else if (repoOf(c.fundRoot, p.target[0]).repo !== repoOf(c.fundRoot, p.target[1]).repo) why.push('the book and its _series.md sit in two repos')
  return why
}

/** a promote that appends one chapter: a single target `book.md#slug` (B-0347); null = the book-and-series kind */
export function chapterTarget(p: Pick<Proposal, 'target'>): { path: string; slug: string } | null {
  if (p.target.length !== 1) return null
  const { path, slug } = splitRef(p.target[0])
  return slug ? { path, slug } : null
}

/** append the chapter to its book, the text read now (the base is what is on disk at this moment) */
async function applyChapter(c: Ctx, p: Proposal, chapter: { path: string; slug: string }, by: 'owner' | 'loop'): Promise<Proposal> {
  const { book } = changeOf(p)
  const abs = join(c.fundRoot, chapter.path)
  const before = readFileSync(abs, 'utf8')
  const eol = before.includes('\r\n') ? '\r\n' : '\n'
  writeFileSync(abs, (before.replace(/\s+$/, '') + '\n\n' + book!.replace(/\s+$/, '') + '\n').replace(/\r?\n/g, eol))
  const t = clock(c)
  const { repo, prefix } = repoOf(c.fundRoot, chapter.path)
  const rel = chapter.path.replace(/\\/g, '/').slice(prefix.length)
  let sha: string
  try {
    sha = await commitPaths(repo, [rel], `loop: ${p.id} ${p.title}`, `${p.why}\n\n${trailers(p.id, { Why: p.why.slice(0, 200) })}`)
  } catch (e) {
    try {
      writeFileSync(abs, before)
      await git(repo, ['restore', '--staged', '--', rel])   // unstage only: never touches HEAD
    } catch { /* best effort */ }
    throw new LoopError(409, `apply failed, tree restored: ${(e as Error).message}`)
  }
  return landed(c, p, sha, by, t)
}

export async function apply(c: Ctx, id: string, by: 'owner' | 'loop'): Promise<Proposal> {
  let p = load(c, id)
  mustBe(p, ['proposed'], 'apply')
  const blocked = applyGates(c, p)
  if (blocked.length) throw new LoopError(409, blocked.join('; '))
  const chapter = chapterTarget(p)
  if (chapter) return applyChapter(c, p, chapter, by)
  const { book, row } = changeOf(p)
  const [bookRel, seriesRel] = p.target
  const role = c.agents.find(a => p.watch.agents.includes(a.id))?.dept ?? 'the fund'
  const bookAbs = join(c.fundRoot, bookRel), seriesAbs = join(c.fundRoot, seriesRel)
  mkdirSync(dirname(bookAbs), { recursive: true })
  const seriesBefore = existsSync(seriesAbs) ? readFileSync(seriesAbs, 'utf8') : null
  writeFileSync(bookAbs, book!.replace(/\s+$/, '') + '\n')
  writeFileSync(seriesAbs, withSeriesRow(seriesBefore, role, row!))
  const t = clock(c)
  // a sub-repo's shelf (app/library) commits in that repo, from inside it
  const { repo, prefix } = repoOf(c.fundRoot, bookRel)
  const inRepo = (f: string) => f.replace(/\\/g, '/').slice(prefix.length)
  let sha: string
  try {
    sha = await commitPaths(repo, [inRepo(bookRel), inRepo(seriesRel)], `loop: ${p.id} ${p.title}`, `${p.why}\n\n${trailers(p.id, { Why: p.why.slice(0, 200) })}`)
  } catch (e) {
    // put the tree back exactly: nothing half-applied is left for the next hand
    try {
      rmSync(bookAbs, { force: true })
      if (seriesBefore === null) rmSync(seriesAbs, { force: true }); else writeFileSync(seriesAbs, seriesBefore)
      await git(repo, ['restore', '--staged', '--', inRepo(bookRel), inRepo(seriesRel)])   // unstage only: never touches HEAD
    } catch { /* best effort */ }
    throw new LoopError(409, `apply failed, tree restored: ${(e as Error).message}`)
  }
  return landed(c, p, sha, by, t)
}

/** a change is in (the loop's own commit, or the agent's it was sent to): record it, open the watch */
async function landed(c: Ctx, p0: Proposal, sha: string, by: string, t: number): Promise<Proposal> {
  let p = logLine({ ...p0, state: 'applied', commit: sha }, `applied by ${by}: commit ${sha.slice(0, 10)}`, iso(t))
  for (const k of p.source) { const m = /^inbox:(\d+)$/.exec(k); if (m) try { await setLessonState(c.db, Number(m[1]), 'promoted', p.id) } catch { /* lesson gone */ } }
  // the watch opens at once
  const agents = cohortOf(p, c.agents)
  const before = win(await M.pooled(c.db, agents, t - c.config.watchDays * DAY, t))
  p = logLine({ ...p, state: 'watching', watch: { agents, from: t, until: t + c.config.watchDays * DAY, events: c.config.watchEvents, before, after: null, verdict: null } },
    `watching ${agents.join(', ')} for ${c.config.watchDays}d or ${c.config.watchEvents} turns; baseline score ${before.score === null ? 'unmeasured' : before.score.toFixed(3)}`, iso(t))
  write(c.fundRoot, p)
  append(c.fundRoot, WATCH_LOG, [JSON.stringify({ ts: t, id: p.id, event: 'start', commit: sha, agents, before })])
  await commitRecords(c, p.id, 'watching')
  return p
}

// ---- the send: what the loop may not write goes to the agent whose writes cover it ----

/**
 * Send proposal `id` to its owning agent: `apply` (check it, land it or decline it) or `revert`
 * (take a change that agent landed back out). Records who, which conversation and when on the
 * proposal; the agent answers through report(). Refused: an owner-only target, no single owner,
 * a send the loop already has out (not stale), and a process with no agent runner.
 */
export async function send(c: Ctx, id: string, ask: Review['ask'], by: 'owner' | 'loop', note = ''): Promise<Proposal> {
  let p = load(c, id)
  if (ask === 'apply') mustBe(p, ['proposed'], 'send')
  else {
    mustBe(p, ['applied', 'watching', 'kept'], 'send back')
    if (!agentLanded(p)) throw new LoopError(409, `${id} was not landed by an agent`)
  }
  if (!c.startAgent) throw new LoopError(503, 'no agent runner in this process')
  const who = reviewerOf(p, c.agents)
  if (!who.agent) throw new LoopError(409, `nobody to send ${id} to: ${who.why}`)
  const t = clock(c)
  if (by === 'loop' && pending(p) && !stale(p, t)) throw new LoopError(409, `${id} is already with ${p.review!.agent}`)
  const tries = p.review && p.review.ask === ask && p.review.verdict === null ? p.review.tries + 1 : 1
  const review: Review = { agent: who.agent, conversation: null, at: iso(t), ask, tries, verdict: null, note: note.slice(0, 300), commit: ask === 'revert' ? p.commit : null }
  const prompt = promptFor({ ...p, review }, who.agent, ask, c.port ?? 4689)
  let conv: string
  try { conv = await c.startAgent(who.agent, prompt, `${p.id} ${ask === 'apply' ? 'review' : 'revert'} (loop)`) } catch (e) {
    throw new LoopError(409, `could not start ${who.agent}: ${(e as Error).message}`)
  }
  p = logLine({ ...p, review: { ...review, conversation: conv } }, `sent to ${who.agent} by ${by} to ${ask === 'apply' ? 'check and land' : 'revert'}${tries > 1 ? ` (try ${tries})` : ''}: conversation ${conv}${note ? ` (${note})` : ''}`, iso(t))
  write(c.fundRoot, p)
  await commitRecords(c, p.id, `sent to ${who.agent}`)
  return p
}

export type Report = { agent?: unknown; verdict?: unknown; commit?: unknown; note?: unknown }

/**
 * The agent a proposal was sent to reports back: applied (its commit, proven to touch a target,
 * opens the watch), reverted (its revert commit closes the change), or declined (nothing changed:
 * a declined apply is vetoed, a declined revert leaves the change where it is and says so).
 */
export async function report(c: Ctx, id: string, b: Report): Promise<Proposal> {
  let p = load(c, id)
  const r = p.review
  if (!r) throw new LoopError(409, `${id} was never sent to an agent`)
  if (b.agent !== r.agent) throw new LoopError(403, `${id} was sent to ${r.agent}, not ${String(b.agent ?? 'nobody')}`)
  if (r.verdict !== null) throw new LoopError(409, `${id}: ${r.agent} already reported ${r.verdict}`)
  const note = typeof b.note === 'string' ? b.note.replace(/\s+/g, ' ').trim().slice(0, 300) : ''
  const verdict = String(b.verdict ?? '')
  const t = clock(c)
  const want = r.ask === 'apply' ? ['applied', 'declined'] : ['reverted', 'declined']
  if (!want.includes(verdict)) throw new LoopError(400, `verdict is ${want.join(' or ')}`)
  if (verdict === 'declined') {
    const done: Review = { ...r, verdict: 'declined', note: note || r.note }
    if (r.ask === 'apply') {
      mustBe(p, ['proposed'], 'decline')
      p = logLine({ ...p, state: 'vetoed', review: done }, `declined by ${r.agent}${note ? `: ${note}` : ''}`, iso(t))
    } else p = logLine({ ...p, review: done }, `${r.agent} did not revert${note ? `: ${note}` : ''}; the change stays, the owner decides`, iso(t))
    write(c.fundRoot, p)
    await commitRecords(c, p.id, `declined by ${r.agent}`)
    return p
  }
  let sha: string
  try { sha = await provenCommit(c.fundRoot, p, b.commit) } catch (e) { throw new LoopError(409, (e as Error).message) }
  if (verdict === 'applied') {
    mustBe(p, ['proposed'], 'apply')
    return landed(c, { ...p, review: { ...r, verdict: 'applied', commit: sha, note } }, sha, r.agent, t)
  }
  mustBe(p, ['applied', 'watching', 'kept'], 'revert')
  p = logLine({ ...p, state: 'reverted', revert: sha, review: { ...r, verdict: 'reverted', commit: sha, note: note || r.note } }, `reverted by ${r.agent}: commit ${sha.slice(0, 10)}${note ? ` (${note})` : ''}`, iso(t))
  write(c.fundRoot, p)
  append(c.fundRoot, WATCH_LOG, [JSON.stringify({ ts: t, id: p.id, event: 'revert', by: r.agent, commit: sha, reason: note, before: p.watch.before, after: p.watch.after, verdict: p.watch.verdict })])
  await commitRecords(c, p.id, `reverted by ${r.agent}`)
  return p
}

/** a change an agent landed (its review carries it past 'applied'): the loop's rails cannot take it
 *  back out, that agent can */
const agentLanded = (p: Proposal) => !!p.review && (p.review.verdict === 'applied' || p.review.ask === 'revert')

export async function revert(c: Ctx, id: string, reason: string, by: 'owner' | 'loop'): Promise<Proposal> {
  let p = load(c, id)
  mustBe(p, ['applied', 'watching', 'kept'], 'revert')
  if (agentLanded(p)) {
    if (pending(p) && p.review!.ask === 'revert') throw new LoopError(409, `${id} is already with ${p.review!.agent} to revert`)
    return send(c, id, 'revert', by, reason)
  }
  if (!p.commit) throw new LoopError(409, `${id} has no apply commit to revert`)
  const t = clock(c)
  let sha: string
  const { repo, prefix } = repoOf(c.fundRoot, splitRef(p.target[0] ?? '').path)
  const roots = shelfRootsOf(c)
  try { sha = await revertChange(repo, p.commit, p.id, `${by === 'loop' ? 'Auto-revert' : 'Owner revert'}: ${reason}`, f => railFor(prefix + f, roots)) } catch (e) {
    if (e instanceof GitOpError) {
      write(c.fundRoot, logLine(p, `revert refused: ${e.message}`, iso(t)))
      throw new LoopError(409, e.message)
    }
    throw e
  }
  p = logLine({ ...p, state: 'reverted', revert: sha }, `reverted by ${by}: commit ${sha.slice(0, 10)} (${reason})`, iso(t))
  write(c.fundRoot, p)
  append(c.fundRoot, WATCH_LOG, [JSON.stringify({ ts: t, id: p.id, event: 'revert', by, commit: sha, reason, before: p.watch.before, after: p.watch.after, verdict: p.watch.verdict })])
  await commitRecords(c, p.id, 'reverted')
  return p
}

/** auto mode: a proposal no agent may land (an owner-only rail, targets across agents, a dormant owner)
 *  is closed by the loop rather than left waiting; vetoed, so the 30-day block keeps it from re-proposing */
async function closeUnlandable(c: Ctx, id: string, why: string): Promise<Proposal> {
  let p = load(c, id)
  mustBe(p, ['proposed'], 'close')
  p = logLine({ ...p, state: 'vetoed' }, `closed by the loop: nobody may land it (${why})`, iso(clock(c)))
  write(c.fundRoot, p)
  await commitRecords(c, p.id, 'closed: nobody may land it')
  return p
}

export async function veto(c: Ctx, id: string, note = ''): Promise<Proposal> {
  let p = load(c, id)
  mustBe(p, ['proposed'], 'veto')
  p = logLine({ ...p, state: 'vetoed' }, `vetoed by owner${note ? `: ${note}` : ''}`, iso(clock(c)))
  write(c.fundRoot, p)
  await commitRecords(c, p.id, 'vetoed')
  return p
}

export async function pin(c: Ctx, id: string, on: boolean): Promise<Proposal> {
  let p = load(c, id)
  mustBe(p, ['applied', 'watching', 'kept'], on ? 'pin' : 'unpin')
  if (p.pinned === on) return p
  p = logLine({ ...p, pinned: on }, on ? 'pinned by owner: kept whatever the watch says' : 'unpinned by owner', iso(clock(c)))
  write(c.fundRoot, p)
  await commitRecords(c, p.id, on ? 'pinned' : 'unpinned')
  return p
}

/**
 * re-read the watch; close it when the window or the turn count is reached.
 *
 * A due watch that reads NO-SIGNAL (either window unmeasured, or thinner than minEvents) is not a
 * verdict, so it never falls through to "kept" silently (B-0058: a 3-turns-a-week cohort could
 * never be auto-reverted). It is EXTENDED by another watchDays, up to noSignalExtends times, with
 * the baseline widened to the same span so both sides stay comparable; if it is still thin after
 * that it closes as kept with verdict no-signal and `unjudged` in its log line, which the Loop room
 * shows as its own mark and count. The owner can still revert it.
 */
export async function evaluate(c: Ctx, p0: Proposal): Promise<{ p: Proposal; closed: boolean; note: string }> {
  let p = p0
  if (p.state !== 'watching' || p.watch.from === null) return { p, closed: false, note: '' }
  const t = clock(c)
  const from = p.watch.from
  const until = p.watch.until ?? from + c.config.watchDays * DAY
  const span = Math.max(DAY, until - from)
  const agents = p.watch.agents.length ? p.watch.agents : cohortOf(p, c.agents)
  // the baseline is recomputed from the database, never read back from the file (the file is
  // writable by more than the loop, and a forged high `before` would force a "worse" verdict).
  // It spans what the after window spans, so an extended watch compares like with like.
  const before = win(await M.pooled(c.db, agents, from - span, from))
  const after = win(await M.pooled(c.db, agents, from, Math.min(t, until) + 1))
  const nBefore = M.evidence(before.counts as M.Counts), nAfter = M.evidence(after.counts as M.Counts)
  const verdict = verdictOf(before.score, after.score, c.config.tolerance, { before: nBefore, after: nAfter, min: c.config.minEvents })
  const due = t >= until || (after.counts.turns ?? 0) >= (p.watch.events || Infinity)
  p = { ...p, watch: { ...p.watch, agents, before, after, verdict: due ? verdict : null } }
  if (!due) { write(c.fundRoot, p); return { p, closed: false, note: `${p.id} watching: ${verdict} so far` } }
  const score = (w: Window) => (w.score === null ? 'unmeasured' : w.score.toFixed(3))
  const thin = `${nBefore} before / ${nAfter} after scored events, ${c.config.minEvents} needed a side`
  const extended = p.watch.extended ?? 0
  if (verdict === 'no-signal' && !p.pinned && extended < c.config.noSignalExtends) {
    const add = c.config.watchDays * DAY
    const q = logLine({ ...p, watch: { ...p.watch, until: until + add, events: (p.watch.events || c.config.watchEvents) + c.config.watchEvents, verdict: null, extended: extended + 1 } },
      `watch extended ${extended + 1}/${c.config.noSignalExtends}: no signal (${thin}); now until ${iso(until + add).slice(0, 10)}`, iso(t))
    write(c.fundRoot, q)
    append(c.fundRoot, WATCH_LOG, [JSON.stringify({ ts: t, id: p.id, event: 'extend', agents, before, after, verdict, n: { before: nBefore, after: nAfter, min: c.config.minEvents }, until: until + add })])
    await commitRecords(c, p.id, 'extended: no signal')
    return { p: q, closed: false, note: `${p.id} extended: no signal` }
  }
  if (verdict === 'worse' && !p.pinned && c.config.autoApply && agentLanded(p) && c.startAgent) {
    if (pending(p) && p.review!.ask === 'revert') { write(c.fundRoot, p); return { p, closed: false, note: `${p.id} worse: with ${p.review!.agent} to revert` } }
    write(c.fundRoot, logLine(p, `watch closed: worse (${score(before)} -> ${score(after)})`, iso(t)))
    try {
      const r = await send(c, p.id, 'revert', 'loop', `cohort score ${score(before)} -> ${score(after)} over ${after.days} day(s)`)
      return { p: r, closed: false, note: `${p.id} worse: sent to ${r.review!.agent} to revert` }
    } catch (e) { return { p: load(c, p.id), closed: false, note: `${p.id} worse but not sent back: ${(e as Error).message}` } }
  }
  if (verdict === 'worse' && !p.pinned && c.config.autoApply) {
    write(c.fundRoot, logLine(p, `watch closed: worse (${score(before)} -> ${score(after)})`, iso(t)))
    try {
      const r = await revert(c, p.id, `cohort score ${score(before)} -> ${score(after)} over ${after.days} day(s)`, 'loop')
      return { p: r, closed: true, note: `${p.id} reverted: worse` }
    } catch (e) { return { p: load(c, p.id), closed: false, note: `${p.id} worse but revert refused: ${(e as Error).message}` } }
  }
  if (verdict === 'worse' && !p.pinned) {
    // manual mode: the loop does not revert by itself; the owner sees "worse" and decides
    const q = /watch closed: worse/.test(p.body) ? p : logLine(p, `watch closed: worse (${score(before)} -> ${score(after)}); auto-revert is off, the owner decides`, iso(t))
    write(c.fundRoot, q)
    return { p: q, closed: false, note: `${p.id} worse: waiting on the owner` }
  }
  const unjudged = verdict === 'no-signal' && !p.pinned
  const line = unjudged
    ? `kept: no signal, unjudged (${thin}${extended ? ` after ${extended} extension${extended === 1 ? '' : 's'}` : ''}); the watch cannot tell, the owner may revert`
    : `kept: ${verdict}${p.pinned ? ' (pinned)' : ''} (${score(before)} -> ${score(after)})`
  p = logLine({ ...p, state: 'kept' }, line, iso(t))
  write(c.fundRoot, p)
  append(c.fundRoot, WATCH_LOG, [JSON.stringify({ ts: t, id: p.id, event: 'close', agents, before, after, verdict, pinned: p.pinned, ...(unjudged ? { unjudged: true, n: { before: nBefore, after: nAfter, min: c.config.minEvents } } : {}) })])
  await commitRecords(c, p.id, unjudged ? 'kept: no signal' : 'kept')
  return { p, closed: true, note: `${p.id} kept: ${unjudged ? 'no signal, unjudged' : verdict}` }
}

// ---- the pass ----

export type PassResult = {
  ok: boolean
  ts: number
  trigger: string
  metrics: { rows: number; days: number; appended: number }
  /** turns of four or more tool steps with no todo list (todos.ts); null = could not be read */
  todos: TodoReport | null
  captured: { inbox: number; git: number }
  created: string[]
  applied: string[]
  sent: string[]
  /** board items in review the pass left for the owner (nobody may review them) */
  parked?: string[]
  closed: string[]
  notes: string[]
  errors: string[]
  summary: string
}

export async function capture(c: Ctx, sinceMs: number): Promise<{ captured: Captured[]; errors: string[] }> {
  const inbox = (await listInbox(c.db, sinceMs)).map(fromInbox)
  const roots = bookRoots(c.repos, c.shelves.flatMap(s => s.roots))
  const { lessons: commits, errors } = await lessons(c.fundRoot, roots, sinceMs)
  return { captured: [...inbox, ...fromGit(c.fundRoot, commits, c.agents)].sort((a, b) => b.ts - a.ts), errors }
}

export async function readLedger(db: Queryable): Promise<{ since: number | null; pulled: Set<string> }> {
  const r = await ops.pullLedgerSpan(db)
  return { since: r.first, pulled: new Set(await ops.pulledBooks(db)) }
}

export async function pass(c: Ctx, trigger: string): Promise<PassResult> {
  const t = clock(c)
  const res: PassResult = { ok: true, ts: t, trigger, metrics: { rows: 0, days: 35, appended: 0 }, todos: null, captured: { inbox: 0, git: 0 }, created: [], applied: [], sent: [], closed: [], notes: [], errors: [], summary: '' }
  const step = async (name: string, fn: () => Promise<void> | void) => {
    try { await fn() } catch (e) { res.ok = false; res.errors.push(`${name}: ${(e as Error).message}`) }
  }

  // 1. METRICS
  await step('metrics', async () => {
    const rows = await M.refresh({ db: c.db, fundRoot: c.fundRoot, agents: c.agents }, t, res.metrics.days)
    res.metrics.rows = rows.length
    const lines = M.jsonlLines(rows, t, readOr(join(c.fundRoot, METRICS_LOG)))
    append(c.fundRoot, METRICS_LOG, lines)
    res.metrics.appended = lines.length
  })
  // the appended days are the loop's own record: committed now, by the loop, so they never sit
  // dirty in the fund tree waiting to ride into some later L-NNN's records commit (2026-09-25:
  // six closed days sat uncommitted after a live pass that proposed nothing)
  if (res.metrics.appended) {
    try {
      const { repo, prefix } = repoOf(c.fundRoot, METRICS_LOG)   // the app repo on the live tree
      await commitPaths(repo, [METRICS_LOG.slice(prefix.length)], `loop: metrics, ${res.metrics.appended} closed day row${res.metrics.appended === 1 ? '' : 's'}`, `Agent: loop\nLoop-Pass: ${iso(t)}`)
    } catch (e) { res.notes.push(`metrics not committed: ${(e as Error).message}`) }
  }

  // 1b. TODO LISTS: counted, reported in the summary, never a per-turn flag
  await step('todos', async () => { res.todos = await todoReport(c.db, new Set(c.agents.map(a => a.id)), t) })

  // 2. CAPTURE
  let captured: Captured[] = []
  await step('capture', async () => {
    const got = await capture(c, t - 60 * DAY)
    captured = got.captured
    res.captured = { inbox: captured.filter(x => x.source === 'inbox').length, git: captured.filter(x => x.source === 'git').length }
    for (const e of got.errors) res.notes.push(`capture: ${e}`)
  })

  // 3. PROPOSE
  await step('propose', async () => {
    const { proposals: all, bad } = list(c.fundRoot)
    for (const b of bad) res.notes.push(`unreadable proposal ${b.file}: ${b.error}`)
    const blocking = all.filter(p => OPEN.includes(p.state) || (p.state === 'vetoed' && t - Date.parse(p.updated || p.created) < 30 * DAY))
    const books = scanBooks(c.fundRoot, c.shelves)
    const drafts: Draft[] = [
      ...promoteDrafts(captured, { fundRoot: c.fundRoot, agents: c.agents, shelves: c.shelves, open: all }),
      ...bootDrafts(c.agents, bookInfoFrom(c.fundRoot, books), blocking),
    ]
    const un = unreadDrafts(books, c.agents, await readLedger(c.db), t, c.config.unreadLedgerDays, blocking, c.shelves)
    if (un.note) res.notes.push(un.note)
    drafts.push(...un.drafts)
    const taken: string[] = []
    for (const d of drafts) {
      const id = nextId(c.fundRoot, taken)
      taken.push(id)
      const p: Proposal = { ...d, id, state: 'proposed', commit: null, revert: null, pinned: false, review: null, created: iso(t), updated: iso(t) }
      write(c.fundRoot, logLine(p, `proposed by the ${trigger} pass${d.auto ? ' (eligible to auto-apply)' : ''}`, iso(t)))
      res.created.push(id)
    }
  })

  // 4. APPLY (only with autoApply in app/loop/config.json)
  if (c.config.autoApply) {
    for (const p of list(c.fundRoot).proposals.filter(x => x.state === 'proposed' && x.auto)) {
      await step(`apply ${p.id}`, async () => {
        const blocked = applyGates(c, p)
        if (blocked.length) { res.notes.push(`${p.id} not applied: ${blocked[0]}`); return }
        await apply(c, p.id, 'loop')
        res.applied.push(p.id)
      })
    }
    // 4b. SEND what the loop may not write to the agent whose writes cover it (a few per pass)
    if (c.startAgent) {
      for (const p of list(c.fundRoot).proposals.filter(x => x.state === 'proposed' && (!x.review || stale(x, t)))) {
        if (p.auto && !applyGates(c, p).length) continue
        const who = reviewerOf(p, c.agents)
        if (!who.agent) {
          // auto mode parks nothing on the owner (the owner, 2026-09-28): nobody may land it, so it closes
          await step(`close ${p.id}`, async () => {
            await closeUnlandable(c, p.id, who.why ?? 'no one may land it')
            res.closed.push(p.id)
            res.notes.push(`${p.id} closed: nobody may land it (${who.why})`)
          })
          continue
        }
        if (res.sent.length >= MAX_SENDS) { res.notes.push(`send cap ${MAX_SENDS} reached: the rest go next pass`); break }
        await step(`send ${p.id}`, async () => { await send(c, p.id, 'apply', 'loop'); res.sent.push(p.id) })
      }
      // 4c. BOARD ITEMS in review go to their owner the same way, under what is left of the same cap
      await step('board review', async () => {
        const b = await boardPass(c, MAX_SENDS - res.sent.length)
        res.sent.push(...b.sent)
        res.parked = b.parked
        res.notes.push(...b.notes)
        for (const e of b.errors) res.errors.push(`board review ${e}`)
        if (b.errors.length) res.ok = false
      })
    }
  } else if (list(c.fundRoot).proposals.some(x => x.state === 'proposed' && x.auto)) {
    res.notes.push('auto-apply is off (app/loop/config.json "loop".autoApply): eligible proposals wait for the owner')
  }

  // 5. WATCH
  for (const p of list(c.fundRoot).proposals.filter(x => x.state === 'watching')) {
    await step(`watch ${p.id}`, async () => {
      const r = await evaluate(c, p)
      if (r.closed) res.closed.push(p.id)
      if (r.note) res.notes.push(r.note)
    })
  }

  res.summary = [
    `${res.metrics.rows} metric rows`,
    `${res.captured.inbox + res.captured.git} lessons`,
    `${res.created.length} proposed`,
    res.applied.length ? `${res.applied.length} applied` : '',
    res.sent.length ? `${res.sent.length} sent` : '',
    res.parked?.length ? `${res.parked.length} left for the owner` : '',
    res.closed.length ? `${res.closed.length} closed` : '',
    res.todos ? todoLine(res.todos) : '',
    res.errors.length ? `${res.errors.length} error(s)` : '',
  ].filter(Boolean).join(' · ')
  await ops.addLoopPass(trigger, res.ok, res.summary, { detail: res, ts: t }, c.db)
  return res
}

export async function lastPass(db: Queryable): Promise<{ ts: number; trigger: string; ok: boolean; summary: string; detail: PassResult | null } | null> {
  const r = (await ops.listLoopPasses({ limit: 1 }, db))[0]
  if (!r) return null
  // detail_json is jsonb: the pass result as written, or null
  const detail = r.detail_json && typeof r.detail_json === 'object' ? r.detail_json as PassResult : null
  return { ts: r.ts, trigger: r.trigger, ok: !!r.ok, summary: r.summary, detail }
}
