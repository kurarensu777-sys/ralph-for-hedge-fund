import { join } from 'node:path'
import type { Queryable } from '../db.ts'
import { ops } from '../db.ts'
import type { Agent, Repo } from '../../shared/types.ts'
import { BOARD_REL } from '../paths.ts'
import { git } from '../git/run.ts'
import { type Item, listItems, readItem, splitBody, withNote, writeItem, cleanOptions } from '../board/store.ts'
import { ownerRail } from './config.ts'
import { MAX_TRIES, STALE_MS, type StartAgent } from './dispatch.ts'
import { type Scope, type CommitVerdict, commitFiles, filesIn, sameFile } from './commitcheck.ts'

/**
 * THE BOARD REVIEWER. An item in `review` (an agent ran `board move <id> review`, or fundd moved an
 * item whose conversation ended while it was still doing) is not a parking lane: a loop pass sends
 * it, in a FRESH conversation, to the agent that owns it. That agent reads the work against the item,
 * and reports `done` (a commit that is pushed; its own files clean and their tests green, commitcheck.ts)
 * or `ready` (one line on what is missing). The same send rules as a proposal (dispatch.ts: MAX_SENDS a pass, STALE_MS, MAX_TRIES).
 *
 * The item's own file is the record: every step is a note by `loop`, whose text starts `review:`.
 *
 *   review: sent to <agent> (try N), conversation <id>      a send
 *   review: <agent> says done, commit <sha>; checking <area>  a done claim that passed the cheap gates
 *   review: area <area> ... (second signal)                  the full-area run, recorded, never the verdict
 *   review: done by <agent>: ...                             the close (status done)
 *   review: returned by <agent>: ...                         back to ready, what is missing
 *   review: owner needed: ...                                needs-you, the reason and the options
 *
 * A done or returned or owner-needed note ENDS a cycle; the sends after the last one are the current
 * review. Owner-only work (execution, a settings file, anything config.ts ownerRail
 * names) is never closed by the loop: it goes to needs-you with options.
 */

export const WHO = 'loop'
/** an item returned this many times is not sent a third time: the owner decides */
export const MAX_RETURNS = 2
/** unanswered, non-stale board sends allowed at once: a crowd of open reviews is a crowd of live conversations */
export const MAX_OPEN = 6

export class BoardReviewError extends Error { constructor(public status: number, msg: string) { super(msg) } }

/** the pieces of the loop's Ctx this file needs (a structural subset: engine.ts passes its own) */
export type BoardCtx = {
  db: Queryable
  fundRoot: string
  agents: Agent[]
  repos: Repo[]
  now?: () => number
  startAgent?: StartAgent
  port?: number
  /** the verdict: the commit's own files and the tests that cover them, on the committed tree (commitcheck.ts); absent = no done verdict can be checked, so none is accepted */
  checkCommit?: (scope: Scope) => Promise<CommitVerdict>
  /** the second signal: check.py for the whole area in the shared checkout; recorded on the item, never the verdict. `text` is its whole output */
  runCheck?: (area: string) => Promise<{ ok: boolean; tail: string; text?: string }>
  publish?: (topic: string, data?: unknown) => void
}

const clock = (c: Pick<BoardCtx, 'now'>) => (c.now ?? Date.now)()
const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z')
export const boardDirOf = (fundRoot: string) => join(fundRoot, ...BOARD_REL.split('/'))

// ---- the record on the item ----

export type Send = { agent: string; conversation: string; at: string; tries: number }
export type Cycle = { sends: Send[]; last: Send | null; returns: number }

const SENT = /^review: sent to (\S+) \(try (\d+)\), conversation (\S+)/
const ENDS = /^review: (?:done by|returned by|owner needed)\b/
const RETURNED = /^review: returned by\b/

/** what the item's notes say about its review: the sends of the current cycle, and how often it has been returned */
export function cycleOf(item: Pick<Item, 'body'>): Cycle {
  let sends: Send[] = []
  let returns = 0
  for (const n of splitBody(item.body).notes) {
    if (n.who !== WHO) continue
    const m = SENT.exec(n.text)
    if (m) sends.push({ agent: m[1], tries: Number(m[2]), conversation: m[3], at: n.ts })
    else if (ENDS.test(n.text)) { sends = []; if (RETURNED.test(n.text)) returns++ }
  }
  return { sends, last: sends.at(-1) ?? null, returns }
}

/** the reviewer a done item's close note names, if its close happened at `doneMs` (metrics: a reopened done counts against it) */
export function closedBy(item: Pick<Item, 'body'>, doneMs: number): string | null {
  for (const n of splitBody(item.body).notes) {
    if (n.who !== WHO) continue
    const m = /^review: done by (\S+?):/.exec(n.text)
    if (m && Math.abs(Date.parse(n.ts) - doneMs) <= 5_000) return m[1]
  }
  return null
}

// ---- who, and what stays with the owner ----

const SETTINGS = /(^|\/)(settings(\.local)?\.json|claude\.md)$/i

/** why a path is the owner's alone, or null: the loop's ownerRail, execution, a settings file */
export function ownerOnlyPath(path: string): string | null {
  const p = path.replace(/\\/g, '/').replace(/^\.\//, '')
  const r = ownerRail(p)
  if (r) return r
  if (/(^|\/)execution\//i.test(p)) return `${p}: execution is guarded`
  if (SETTINGS.test(p)) return `${p}: settings and the constitution chain are owner only`
  return null
}

/** the first owner-only path an item's own words name (title and the thinking, not the notes thread) */
export function railsIn(item: Pick<Item, 'title' | 'body'>): string | null {
  const text = `${item.title}\n${splitBody(item.body).text}`
  for (const tok of text.match(/[\w.@-]+(?:\/[\w.@-]+)+|\b(?:settings(?:\.local)?\.json|CLAUDE\.md)\b/g) ?? []) {
    const path = tok.replace(/[.,;:)]+$/, '')
    const why = ownerOnlyPath(path)
    if (why) return why.includes(path) ? why : `${path}: ${why}`
  }
  return null
}

/** who reviews this item, or why nobody may (it then waits for the owner) */
export function boardReviewer(item: Pick<Item, 'owner' | 'title' | 'body'>, agents: Pick<Agent, 'id' | 'mode' | 'writes'>[]): { agent: string | null; why: string | null } {
  if (!item.owner || item.owner === 'you') return { agent: null, why: 'the item has no agent owner' }
  const a = agents.find(x => x.id === item.owner)
  if (!a) return { agent: null, why: `${item.owner} is not on the roster` }
  if (a.mode === 'dormant') return { agent: null, why: `${a.id} is dormant` }
  if ((a.writes ?? []).some(w => /^execution\//.test(w.replace(/\\/g, '/')))) return { agent: null, why: `${a.id} owns execution, which is guarded` }
  const rail = railsIn(item)
  if (rail) return { agent: null, why: `its text names owner-only work: ${rail}` }
  return { agent: a.id, why: null }
}

// ---- the state of one item ----

export type ReviewState =
  | { kind: 'send'; agent: string; tries: number }
  | { kind: 'with'; agent: string; conversation: string; at: string; tries: number }
  | { kind: 'park'; why: string }

/** what a pass does with an item in review (pure: the clock and the in-flight checks are arguments) */
export function stateOf(item: Item, agents: Pick<Agent, 'id' | 'mode' | 'writes'>[], now: number, checking: ReadonlySet<string> = new Set()): ReviewState {
  const cy = cycleOf(item)
  const who = boardReviewer(item, agents)
  if (!who.agent) return { kind: 'park', why: who.why ?? 'nobody may review it' }
  if (cy.returns >= MAX_RETURNS && !cy.last) return { kind: 'park', why: `returned ${cy.returns} times and back in review: the owner decides` }
  if (cy.last) {
    const at = Date.parse(cy.last.at)
    const old = Number.isFinite(at) && now - at >= STALE_MS
    if (checking.has(item.id) || !old) return { kind: 'with', agent: cy.last.agent, conversation: cy.last.conversation, at: cy.last.at, tries: cy.last.tries }
    if (cy.last.tries >= MAX_TRIES) return { kind: 'park', why: `${cy.last.agent} did not answer after ${cy.last.tries} sends` }
    return { kind: 'send', agent: who.agent, tries: cy.last.tries + 1 }
  }
  return { kind: 'send', agent: who.agent, tries: 1 }
}

/** the board's items in review, oldest update first (the owner's order: what has waited longest goes first) */
export function inReview(fundRoot: string): Item[] {
  return listItems(boardDirOf(fundRoot)).filter(i => i.status === 'review')
    .sort((a, b) => (Date.parse(a.updated) || 0) - (Date.parse(b.updated) || 0) || a.id.localeCompare(b.id, 'en', { numeric: true }))
}

/** the Loop room's rows: who has each item in review, from its notes */
export function reviewRows(fundRoot: string, agents: Agent[], now: number, checking: ReadonlySet<string> = new Set()) {
  return inReview(fundRoot).map(i => {
    const s = stateOf(i, agents, now, checking)
    const cy = cycleOf(i)
    return {
      id: i.id, title: i.title, owner: i.owner, priority: i.priority, updated: i.updated, returns: cy.returns,
      state: s.kind === 'with' ? (checking.has(i.id) ? 'checking' : 'with') : s.kind === 'send' ? 'unsent' : 'owner',
      agent: s.kind === 'park' ? null : s.agent,
      conversation: s.kind === 'with' ? s.conversation : null,
      at: s.kind === 'with' ? s.at : null,
      tries: s.kind === 'park' ? 0 : s.tries,
      why: s.kind === 'park' ? s.why : null,
    }
  })
}

// ---- writes ----

/** change the item and add one note by the loop, in one write; the board's own event row says the status moved */
async function put(c: BoardCtx, id: string, patch: Partial<Item>, text: string, t: number): Promise<Item> {
  const dir = boardDirOf(c.fundRoot)
  const cur = readItem(dir, id)
  const ts = iso(t)
  const next: Item = { ...cur, ...patch, updated: ts, body: withNote(cur.body, WHO, text, ts).trim() }
  writeItem(dir, next)
  if (next.status !== cur.status) {
    try { await ops.logEvent('board', `${id} status=${next.status}`, { ts: t }, c.db) } catch { /* the log is a record, not a gate */ }
  }
  c.publish?.('board', { id })
  c.publish?.('loop', { boardReview: id })
  return next
}

/** the item waits for the owner: needs-you, with the reason on the item and answers to click */
export async function park(c: BoardCtx, id: string, why: string, t: number, recommend: 'close' | 'redo' = 'redo'): Promise<Item> {
  const item = readItem(boardDirOf(c.fundRoot), id)
  const options = cleanOptions([
    { id: 'close', label: 'Close it as done', done: true, ...(recommend === 'close' ? { rec: true } : {}) },
    { id: 'redo', label: `Send it back to ${item.owner && item.owner !== 'you' ? item.owner : 'its filer'} to finish`, ...(recommend === 'redo' ? { rec: true } : {}) },
  ])
  return put(c, id, { status: 'needs-you', options }, `review: owner needed: ${why}`.slice(0, 600), t)
}

// ---- the send ----

const AREAS: Record<string, string> = { fund: 'tools', database: 'database', app: 'app', platform: 'platform', execution: 'execution', research: 'research' }

export function promptFor(i: Item, agent: string, port: number, tries: number): string {
  const url = `http://127.0.0.1:${port}/api/loop/board/${i.id}/review`
  const report = (body: string) => `curl -s -X POST ${url} -H "Content-Type: application/json" -d "${body}"`
  const conv = '\\"conversation\\":\\"$FUND_CONVERSATION\\"'
  const { text } = splitBody(i.body)
  return [
    `The loop sends you board item ${i.id} to review. It is yours (owner ${agent}) and sits in the Review lane${tries > 1 ? ` (second send: the first was not answered)` : ''}. This is a FRESH conversation: you did not do the work, so read it as a reviewer.`,
    '',
    `Item: ${i.title}`,
    `Kind ${i.kind}, priority ${i.priority}, filed by ${i.from || 'you'}.`,
    text ? `\n${text.length > 3000 ? text.slice(0, 3000) + `\n[cut; read the whole item with: node app/scripts/board.mjs show ${i.id}]` : text}\n` : '',
    `Read it whole with its notes: node app/scripts/board.mjs show ${i.id}`,
    '',
    'Decide on the tree as it stands now:',
    `1. The work matches what the item asked (its Done line, if it has one). Read the code or the chapter, not only the note.`,
    `2. A commit for it is pushed: git log --all --grep=${i.id}, or the sha in its notes; git branch -r --contains <sha> names a remote branch.`,
    `3. The commit's own files are clean and the tests that cover them pass. fundd lints those files and runs those tests on the committed tree before it closes the item: a red file inside the commit returns it, a red file outside it does not (the whole area's run is only noted).`,
    '',
    'Then report exactly once (the loop reads nothing else):',
    `- All three hold: ${report(`{\\"agent\\":\\"${agent}\\",${conv},\\"verdict\\":\\"done\\",\\"commit\\":\\"<the full sha>\\",\\"note\\":\\"<one line: what you checked>\\"}`)}`,
    `- Something is missing (a half-done item fundd moved from doing is the usual case): ${report(`{\\"agent\\":\\"${agent}\\",${conv},\\"verdict\\":\\"ready\\",\\"note\\":\\"<one line: what is missing>\\"}`)}`,
    'Keep the note free of double quotes and dollar signs (it sits inside the shell string). Do not move or edit the item yourself, and change no code: the endpoint moves it. Done needs a pushed commit that is clean; without one it is refused, and you report ready instead. Then stand down.',
  ].join('\n')
}

/** send item `id` (in review) to its reviewer; or leave it for the owner when nobody may review it */
export async function sendBoard(c: BoardCtx, id: string, checking: ReadonlySet<string> = new Set()): Promise<{ sent: boolean; parked: string | null; item: Item }> {
  const dir = boardDirOf(c.fundRoot)
  const item = readItem(dir, id)
  if (item.status !== 'review') throw new BoardReviewError(409, `${id} is ${item.status}, not review`)
  const t = clock(c)
  const s = stateOf(item, c.agents, t, checking)
  if (s.kind === 'park') return { sent: false, parked: s.why, item: await park(c, id, s.why, t) }
  if (s.kind === 'with') throw new BoardReviewError(409, `${id} is already with ${s.agent}`)
  if (!c.startAgent) throw new BoardReviewError(503, 'no agent runner in this process')
  const prompt = promptFor(item, s.agent, c.port ?? 4689, s.tries)
  let conv: string
  try { conv = await c.startAgent(s.agent, prompt, `${id} review (loop)`) } catch (e) {
    throw new BoardReviewError(409, `could not start ${s.agent}: ${(e as Error).message}`)
  }
  return { sent: true, parked: null, item: await put(c, id, {}, `review: sent to ${s.agent} (try ${s.tries}), conversation ${conv}`, t) }
}

// ---- the report ----

export type BoardReport = { agent?: unknown; conversation?: unknown; verdict?: unknown; commit?: unknown; note?: unknown }

/** the repo (and area) that holds `sha`, or null */
async function repoHolding(c: BoardCtx, sha: string): Promise<{ repo: Repo; full: string } | null> {
  for (const r of c.repos) {
    const out = await git(join(c.fundRoot, r.path), ['rev-parse', '--verify', '--end-of-options', `${sha}^{commit}`])
    if (out.code === 0) return { repo: r, full: out.stdout.trim() }
  }
  return null
}

/**
 * The evidence for a done verdict, cheap gates first: the sha is a commit in one of the fund's repos,
 * it is on a remote branch (pushed), it belongs to THIS item (its message names the id, or the item's
 * notes name the sha), and it touches no owner-only path. Throws BoardReviewError with the piece that is missing.
 */
export async function proveDone(c: BoardCtx, item: Item, sha: unknown): Promise<{ full: string; repo: Repo; ownerOnly: string | null }> {
  const s = String(sha ?? '').trim()
  if (!/^[0-9a-f]{7,40}$/i.test(s)) throw new BoardReviewError(400, 'done needs "commit": the hex sha of the pushed commit that did the work')
  const found = await repoHolding(c, s)
  if (!found) throw new BoardReviewError(409, `no commit ${s} in any of the fund's repos`)
  const where = join(c.fundRoot, found.repo.path)
  const remote = await git(where, ['for-each-ref', '--contains', found.full, '--format=%(refname)', 'refs/remotes'])
  if (remote.code !== 0 || !remote.stdout.split('\n').some(l => l.trim() && !/\/HEAD$/.test(l.trim()))) {
    throw new BoardReviewError(409, `${s.slice(0, 10)} is not pushed (no remote branch holds it): push it, then report done`)
  }
  const msg = await git(where, ['show', '-s', '--format=%B', '--end-of-options', found.full])
  const named = new RegExp(`\\b${item.id}\\b`).test(msg.stdout) || item.body.toLowerCase().includes(found.full.slice(0, 7).toLowerCase())
  if (!named) throw new BoardReviewError(409, `${s.slice(0, 10)} does not name ${item.id} in its message and the item's notes do not name it: it is not shown to be this item's work`)
  const files = await git(where, ['show', '--no-renames', '--name-only', '--format=', '--end-of-options', found.full])
  const prefix = found.repo.path === '.' ? '' : found.repo.path.replace(/\\/g, '/').replace(/\/?$/, '/')
  let ownerOnly: string | null = null
  for (const f of files.stdout.split('\n').map(x => x.trim()).filter(Boolean)) { ownerOnly = ownerOnlyPath(prefix + f); if (ownerOnly) break }
  return { full: found.full, repo: found.repo, ownerOnly }
}

/** items whose done claim is being checked now, and the one queue the checks share (the machine is short of memory: one at a time) */
const checking = new Set<string>()
export const checkingNow = (): ReadonlySet<string> => checking
let queue: Promise<unknown> = Promise.resolve()
/**
 * The second signal is the whole area, in the shared checkout: 20 minutes for app under load, and the
 * same answer for every item that finishes inside it. It runs OUTSIDE the queue (the next commit check
 * must not wait on it, B-0639 measured 5 closes in 2 hours of passes) and once at a time per area:
 * an item that finishes while a run is in flight takes that run's result as its note.
 */
type AreaRun = { ok: boolean; tail: string; text?: string }
const areaRuns = new Map<string, Promise<AreaRun>>()
const signals = new Set<Promise<void>>()

/**
 * The agent a board item was sent to reports. `ready` returns the item at once. `done` passes the
 * cheap gates (proveDone) and answers {state:'checking'}: the commit's own files are then linted and
 * their tests run on the committed tree (checkCommit) in the background; clean closes the item, red in
 * the commit's files returns it to ready naming them. The full-area run follows as a note. An item whose
 * commit touches an owner-only path goes to needs-you instead (recommend: close).
 */
export async function reportBoard(c: BoardCtx, id: string, b: BoardReport): Promise<{ id: string; state: string; area?: string }> {
  const dir = boardDirOf(c.fundRoot)
  let item: Item
  try { item = readItem(dir, id) } catch (e) { throw new BoardReviewError((e as any).status ?? 404, (e as Error).message) }
  if (item.status !== 'review') throw new BoardReviewError(409, `${id} is ${item.status}, not review`)
  const last = cycleOf(item).last
  if (!last) throw new BoardReviewError(409, `${id} was never sent to a reviewer`)
  if (b.agent !== last.agent) throw new BoardReviewError(403, `${id} was sent to ${last.agent}, not ${String(b.agent ?? 'nobody')}`)
  if (b.conversation !== last.conversation) throw new BoardReviewError(403, `${id} was sent to conversation ${last.conversation}: only the reviewer's fresh conversation reports (FUND_CONVERSATION)`)
  if (item.conversation && b.conversation === item.conversation) throw new BoardReviewError(403, `${id}: the conversation that did the work cannot review it`)
  if (checking.has(id)) throw new BoardReviewError(409, `${id}: a done claim is being checked`)
  const note = typeof b.note === 'string' ? b.note.replace(/\s+/g, ' ').trim().slice(0, 400) : ''
  const verdict = String(b.verdict ?? '')
  if (verdict !== 'done' && verdict !== 'ready') throw new BoardReviewError(400, 'verdict is done or ready')
  if (!note) throw new BoardReviewError(400, verdict === 'ready' ? 'ready needs "note": one line on what is missing' : 'done needs "note": one line on what you checked')
  const t = clock(c)
  if (verdict === 'ready') {
    await put(c, id, { status: 'ready' }, `review: returned by ${last.agent}: ${note}`, t)
    return { id, state: 'ready' }
  }
  const proof = await proveDone(c, item, b.commit)
  const sha = proof.full.slice(0, 10)
  if (proof.ownerOnly) {
    await park(c, id, `${last.agent} says done (commit ${sha}) but the work touches owner-only ground: ${proof.ownerOnly}. ${note}`, t, 'close')
    return { id, state: 'needs-you' }
  }
  const area = AREAS[proof.repo.id]
  if (!area) throw new BoardReviewError(409, `no check.py area for the repo ${proof.repo.id}`)
  if (!c.checkCommit) throw new BoardReviewError(503, 'no check runner in this process: a done verdict cannot be proven')
  checking.add(id)
  await put(c, id, {}, `review: ${last.agent} says done, commit ${sha}; checking ${proof.repo.id}`, t)
  const verdictOf = c.checkCommit
  const scope: Scope = { repo: proof.repo, area, sha: proof.full, files: [] }
  const job = queue.catch(() => undefined).then(async () => {
    let r: CommitVerdict
    let files: string[] = []
    try {
      files = await commitFiles(join(c.fundRoot, proof.repo.path), proof.full)
      r = await verdictOf({ ...scope, files })
    } catch (e) { r = { ok: false, ran: [], failing: [], elsewhere: [], tail: `the check could not run: ${(e as Error).message}` } }
    const at = clock(c)
    try {
      const ran = r.ran.length ? r.ran.join(', ') : 'no lint or test covers these files'
      const els = r.elsewhere.length ? ` Area red elsewhere: ${r.elsewhere.slice(0, 8).join(', ')}.` : ''
      if (r.ok) await put(c, id, { status: 'done' }, `review: done by ${last.agent}: commit ${sha} is pushed and its own files are clean (${ran}; the committed tree, not the shared checkout).${els} ${note}`, at)
      else {
        const named = r.failing.length ? `red in ${r.failing.slice(0, 8).join(', ')}` : 'red'
        await put(c, id, { status: 'ready' }, `review: returned by ${last.agent}: the done claim (commit ${sha}) failed: ${named} (${ran}). ${r.tail.replace(/\s+/g, ' ').trim().slice(-300)}`, at)
      }
    } finally { checking.delete(id) }
    // the second signal: the whole area, in the shared checkout. It is written down and decides nothing,
    // and the queue does not wait for it.
    if (c.runCheck) {
      const sig: Promise<void> = secondSignal(c, id, area, files, r).finally(() => signals.delete(sig))
      signals.add(sig)
    }
  }).catch(e => { checking.delete(id); console.error('[loop] board review', id, (e as Error).message) })
  queue = job
  return { id, state: 'checking', area }
}

/** the full-area run, as a note: green, red elsewhere (the files that are not the commit's), or red in the commit's files too */
async function secondSignal(c: BoardCtx, id: string, area: string, files: string[], v: CommitVerdict): Promise<void> {
  let note: string
  try {
    let run = areaRuns.get(area)
    if (!run) {
      run = c.runCheck!(area)
      areaRuns.set(area, run)
      const mine = run
      const clear = () => { if (areaRuns.get(area) === mine) areaRuns.delete(area) }
      mine.then(clear, clear)
    }
    const r = await run
    if (r.ok) note = `review: area ${area} full run (second signal, shared checkout, --fast): green`
    else {
      const red = filesIn(r.text ?? r.tail)
      const mine = red.filter(f => files.some(x => sameFile(x, f)))
      const other = red.filter(f => !files.some(x => sameFile(x, f)))
      note = `review: area ${area} full run (second signal, shared checkout, --fast): red.`
      if (other.length) note += ` Area red elsewhere: ${other.slice(0, 8).join(', ')}.`
      if (mine.length) note += ` Also red in this commit's files in the shared copy: ${mine.slice(0, 8).join(', ')}${v.ok ? ' (the committed tree is clean: a dirty edit by another session)' : ''}.`
      if (!red.length) note += ` ${r.tail.replace(/\s+/g, ' ').trim().slice(-240)}`
    }
  } catch (e) { note = `review: area ${area} full run (second signal) could not run: ${(e as Error).message}` }
  try { await put(c, id, {}, note.slice(0, 600), clock(c)) } catch (e) { console.error('[loop] board review note', id, (e as Error).message) }
}

/** test seam: wait for the queued checks */
export const settledChecks = async (): Promise<void> => {
  await queue
  while (signals.size) await Promise.all([...signals])
}

// ---- the pass ----

export type BoardPassResult = { sent: string[]; parked: string[]; notes: string[]; errors: string[] }

/**
 * Step 4c of a pass: items in review go out, oldest first, under the pass's one cap (`room` = what
 * is left of MAX_SENDS after the proposals). A park counts against it too, so the owner's lane fills
 * as slowly as the reviewers' do. Stops at the first failed start (a spend cap or a stop applies to all).
 */
export async function boardPass(c: BoardCtx, room: number): Promise<BoardPassResult> {
  const out: BoardPassResult = { sent: [], parked: [], notes: [], errors: [] }
  const t = clock(c)
  const items = inReview(c.fundRoot)
  let open = items.filter(i => stateOf(i, c.agents, t, checking).kind === 'with').length
  let left = room
  for (const i of items) {
    const s = stateOf(i, c.agents, t, checking)
    if (s.kind === 'with') continue
    if (left <= 0) { out.notes.push('board review: the pass cap is reached, the rest of the Review lane goes next pass'); break }
    if (s.kind === 'send' && open >= MAX_OPEN) { out.notes.push(`board review: ${open} reviews are out, the rest wait for answers`); break }
    try {
      const r = await sendBoard(c, i.id, checking)
      left--
      if (r.sent) { out.sent.push(i.id); open++ } else { out.parked.push(i.id); out.notes.push(`${i.id} left for the owner: ${r.parked}`) }
    } catch (e) {
      out.errors.push(`${i.id}: ${(e as Error).message}`)
      if (/could not start/.test((e as Error).message)) { out.notes.push('board review: a start failed, no more sends this pass'); break }
    }
  }
  return out
}
