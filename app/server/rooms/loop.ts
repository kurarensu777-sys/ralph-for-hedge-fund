import { execFile } from 'node:child_process'
import { join } from 'node:path'
import type { Router } from '../http.ts'
import { HttpError } from '../http.ts'
import type { ServiceGroup } from '../../shared/types.ts'
import { ago, stamp } from '../../shared/time.ts'
import { db, ops } from '../db.ts'
import { publish } from '../events.ts'
import { onTurn } from '../hooks.ts'
import { CONFIG_FILES, FUND_ROOT, LOOP_CONFIG_FILE, PORT, PYTHON, deskDir } from '../paths.ts'
import { latestReading } from '../system/probes.ts'
import { config } from '../config.ts'
import { git } from '../git/run.ts'
import { allDesks, parseJsonl } from '../lab/runs.ts'
import { LessonError, addLesson, setLessonState } from '../loop/capture.ts'
import { readConfig, setAutoApply } from '../loop/config.ts'
import { type Ctx, LoopError, apply, capture, lastPass, pass, pin, report, revert, send, serial, veto } from '../loop/engine.ts'
import { pending, reviewerOf } from '../loop/dispatch.ts'
import { BoardReviewError, checkingNow, reportBoard, reviewRows } from '../loop/boardreview.ts'
import { checkCommit } from '../loop/commitcheck.ts'
import { commitPaths, repoOf } from '../loop/gitops.ts'
import { start as chatStart } from '../chat/runner.ts'
import * as M from '../loop/metrics.ts'
import { list, read } from '../loop/proposals.ts'
import { registerReview } from '../loop/review.ts'
import { sweep } from '../loop/turns.ts'
import { watchRead } from '../loop/watchread.ts'
import { dirtyLedgers } from '../loop/worktree.ts'
import { changes } from '../chat/changes.ts'
import { bookRoots, latestDigest, lessons, noLessonRows, readOr, retroStatus, type NoLesson } from '../loop/sources.ts'

// ROOM: loop - the fund improving itself. Four lanes: Learned (lessons captured: the inbox + books
// added in git), Proposals (what a pass wants to change), Watching (applied changes on probation,
// the cohort's score before/after), Decided (kept, reverted, vetoed). Plus the old record: book
// commits, stand-downs with no lesson, retros. Everything here is read from files, git or the db.
// Plus REVIEW: every finished turn is checked (server/loop/grades.ts) and the flagged ones are
// listed for an optional good / bad (feeding the score's taste component); nothing waits on a grade.

const RANGES: Record<string, number | null> = { '7d': 7, '30d': 30, all: null }
const DAY = 86_400_000

/** check.py for one whole area, --fast (the live network suites skip: a network's bad hour is not a reviewed item's red). The board review's SECOND signal: written on the item, never its verdict. A run is cut at 40 min. */
function runCheck(area: string): Promise<{ ok: boolean; tail: string; text?: string }> {
  return new Promise(resolve => {
    execFile(PYTHON, [join(FUND_ROOT, 'app', 'tools', 'check.py'), '--only', area, '--fast'], { cwd: FUND_ROOT, timeout: 40 * 60_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      const all = `${stdout ?? ''}${stderr ?? ''}`.trim()
      const text = all.split(String.fromCharCode(10)).slice(-8).join(' | ')
      resolve({ ok: !err, tail: text || (err ? String(err.message) : ''), text: all })
    })
  })
}

function ctx(): Ctx {
  return {
    db, fundRoot: FUND_ROOT, agents: config.agents(), shelves: config.shelves(), repos: config.repos(), config: readConfig(CONFIG_FILES),
    startAgent: async (agent, prompt, title) => (await chatStart(agent, prompt, title)).id, port: PORT, runCheck, publish,
    checkCommit: scope => checkCommit(scope, { fundRoot: FUND_ROOT, python: PYTHON }),
  }
}

function retros(now: number) {
  return allDesks(FUND_ROOT).map(desk => {
    const beliefs = readOr(join(deskDir(desk), 'beliefs.md'))
    const runs = readOr(join(deskDir(desk), 'data', 'runs.jsonl'))
    return { ...retroStatus(desk, beliefs, runs === null ? [] : parseJsonl(runs).rows, now), digest: latestDigest(FUND_ROOT, desk) }
  })
}

/** the scheduler's reading of the retro-due job (ops.health_readings system:retro-due), or null */
async function retroProbe() {
  let j: Record<string, any> | null
  try { j = await latestReading('retro-due') } catch (e: any) { return { status: 'unknown', reading: `the ops store: ${String(e?.message ?? e).slice(0, 160)}`, probedTs: null } }
  if (j === null) return null
  return { status: String(j.status ?? 'unknown'), reading: String(j.reading ?? ''), probedTs: Number(j.probed_ts) * 1000 || null }
}

/** a thrown LoopError / LessonError becomes its status; anything else stays a 500 */
async function guarded<T>(fn: () => Promise<T> | T): Promise<T> {
  try { return await fn() } catch (e) {
    if (e instanceof LoopError || e instanceof LessonError || e instanceof BoardReviewError) throw new HttpError(e.status, e.message)
    throw e
  }
}

// ---- turn grades: a sweep checks every new turn (runner.ts logs 'turn'); one at a time

const convCwd = async (conv: string) => (await ops.getConversation(conv, { includeForgotten: true }))?.cwd ?? FUND_ROOT
let sweeping: Promise<unknown> | null = null
export function sweepTurns() {
  if (sweeping) return sweeping
  sweeping = sweep(db, { changesFor: async conv => (await changes(conv, await convCwd(conv))).commits.map(c => ({ ts: c.ts, files: c.files })), dirty: () => dirtyLedgers(FUND_ROOT), scopes: config.agents() })
    .then(r => { if (r.checked) publish('loop', { review: r.queued }); if (r.errors.length) console.error('[loop] sweep', r.errors.slice(0, 3).join('; ')) })
    .catch(e => console.error('[loop] sweep', (e as Error).message))
    .finally(() => { sweeping = null })
  return sweeping
}

/** a proposal without its body, plus what its card draws: the watch's evidence, window and delta (watchread.ts) */
const slim = (p: ReturnType<typeof list>['proposals'][number], cfg: { minEvents: number; tolerance: number }, now: number, agents = config.agents()) =>
  ({ ...p, body: undefined, read: watchRead(p, cfg, now), reviewer: p.state === 'proposed' ? reviewerOf(p, agents) : null })

/** waiting on the owner: only in manual mode (a proposed change not with an agent). Auto mode parks
 *  nothing on the owner: it applies, sends to the agent whose writes cover it, or closes what nobody may land */
const ownerWaits = (p: ReturnType<typeof list>['proposals'][number], auto: boolean) =>
  !auto && p.state === 'proposed' && !pending(p)

export function register(r: Router) {
  setTimeout(() => { void sweepTurns() }, 3_000).unref()
  setInterval(() => { void sweepTurns() }, 20_000).unref()
  onTurn(() => { void sweepTurns() })

  registerReview(r, { db, sweep: sweepTurns, publish })

  r.get('/api/loop/lanes', async ({ query }) => {
    const range = query.get('range') ?? '30d'
    if (!(range in RANGES)) throw new HttpError(400, 'range is 7d, 30d or all')
    const now = Date.now()
    const days = RANGES[range]
    const since = days === null ? null : now - days * DAY
    const c = ctx()
    const roots = bookRoots(c.repos, c.shelves.flatMap(s => s.roots))
    const [{ lessons: commits, errors }, got] = await Promise.all([lessons(FUND_ROOT, roots, since), capture(c, since ?? 0)])
    // the store's stand-downs; a store that cannot answer is null (unknown), never an empty list
    let noLesson: { rows: NoLesson[]; bad: number } | null = null
    try { noLesson = { rows: noLessonRows(await ops.listNoLesson({ limit: 5000 })), bad: 0 } } catch { noLesson = null }
    const inRange = (ts: number | null) => since === null || (ts !== null && ts >= since)
    const { proposals, bad } = list(FUND_ROOT)
    return {
      now, range,
      roots,
      commits,
      commitErrors: [...errors, ...got.errors.filter(e => !errors.includes(e))],
      lessons: got.captured,
      noLesson: noLesson === null ? null : noLesson.rows.filter(x => inRange(x.ts)),
      noLessonBad: noLesson?.bad ?? 0,
      retros: retros(now),
      retroProbe: await retroProbe(),
      proposals: proposals.map(p => slim(p, c.config, now)),
      proposalsBad: bad,
      boardReview: reviewRows(FUND_ROOT, c.agents, now, checkingNow()),
      config: c.config,
      pass: await lastPass(db),
    }
  })

  /** the activity-bar badge: proposals waiting on the owner + watches that read worse (files only).
   *  The review queue is not counted: grading a turn is optional and nothing waits on it (the owner, 2026-09-28) */
  r.get('/api/loop/badge', async () => {
    const { proposals } = list(FUND_ROOT)
    const auto = readConfig(CONFIG_FILES).autoApply
    return { proposed: proposals.filter(p => ownerWaits(p, auto)).length, worse: proposals.filter(p => p.state === 'watching' && p.watch.verdict === 'worse').length }
  })

  // CAPTURE: an agent (curl from its shell, FUND_AGENT / FUND_CONVERSATION in its env) or the chats room
  r.post('/api/loop/lesson', async ({ body }) => guarded(async () => {
    const l = await addLesson(db, config.agents(), await body())
    publish('loop', { lesson: l.id })
    return l
  }))

  r.post('/api/loop/lessons/:id/:action', async ({ params }) => guarded(async () => {
    const id = Number(params.id)
    if (!Number.isInteger(id)) throw new HttpError(400, 'id is a number')
    if (params.action !== 'dismiss' && params.action !== 'reopen') throw new HttpError(404, 'action is dismiss or reopen')
    await setLessonState(db, id, params.action === 'dismiss' ? 'dismissed' : 'open')
    publish('loop', { lesson: id })
    return { ok: true }
  }))

  r.post('/api/loop/pass', async ({ query, body }) => guarded(async () => {
    const b = await body().catch(() => ({}))
    const trigger = String(query.get('trigger') ?? b?.trigger ?? 'owner')
    if (!['owner', 'schedule', 'manual'].includes(trigger)) throw new HttpError(400, 'trigger is owner, schedule or manual')
    const res = await serial(FUND_ROOT, () => pass(ctx(), trigger))
    publish('loop', { pass: res.ts })
    return res
  }))

  r.get('/api/loop/proposals/:id', ({ params, query }) => guarded(async () => {
    const p = read(FUND_ROOT, params.id)
    if (!p) throw new HttpError(404, `no proposal ${params.id}`)
    const now = Date.now()
    const c = ctx()
    const w = p.watch
    let chart = null
    if (w.from !== null) {
      const span = (w.until ?? w.from + c.config.watchDays * DAY) - w.from
      const until = Math.min(now, w.until ?? now)
      chart = { from: w.from, until: w.until, agents: w.agents, points: await M.series(db, w.agents, w.from - span, until), before: w.before, after: w.after }
    } else if (p.state === 'proposed' && w.agents.length) {
      const days = Number(query.get('days') ?? 14)
      chart = { from: null, until: null, agents: w.agents, points: await M.series(db, w.agents, now - days * DAY, now), before: null, after: null }
    }
    return { proposal: { ...p, read: watchRead(p, c.config, now) }, chart, config: c.config }
  }))

  // THE REPORT: the agent a proposal was sent to answers here (curl from its shell; the prompt names it)
  r.post('/api/loop/proposals/:id/review', async ({ params, body }) => guarded(async () => {
    const b = await body().catch(() => ({}))
    const p = await serial(FUND_ROOT, () => report(ctx(), params.id, b ?? {}))
    publish('loop', { proposal: p.id, state: p.state })
    publish('git')
    return { id: p.id, state: p.state, review: p.review }
  }))

  // THE BOARD REPORT: the agent an item in review was sent to answers here (boardreview.ts): done {commit} or ready
  r.post('/api/loop/board/:id/review', async ({ params, body }) => guarded(async () => {
    const b = await body().catch(() => ({}))
    const out = await serial(FUND_ROOT, () => reportBoard(ctx(), params.id, b ?? {}))
    publish('loop', { boardReview: params.id, state: out.state })
    return out
  }))

  // the owner's Auto / Manual switch: loop.autoApply in app/loop/config.json, committed as the owner's edit
  r.post('/api/loop/config', async ({ body }) => guarded(async () => {
    const b = await body().catch(() => ({}))
    if (typeof b?.autoApply !== 'boolean') throw new HttpError(400, 'autoApply is true or false')
    const cfg = await serial(FUND_ROOT, async () => {
      setAutoApply(LOOP_CONFIG_FILE, b.autoApply)
      const rel = 'app/loop/config.json'
      const { repo, prefix } = repoOf(FUND_ROOT, rel)
      try { await commitPaths(repo, [rel.slice(prefix.length)], `loop (owner): ${b.autoApply ? 'auto' : 'manual'} mode`, 'Agent: owner\nLoop-Config: autoApply') }
      catch (e) { console.error('[loop] config commit', (e as Error).message) }
      return readConfig(CONFIG_FILES)
    })
    publish('loop', { config: cfg.autoApply })
    return cfg
  }))

  r.post('/api/loop/proposals/:id/:action', async ({ params, body }) => guarded(async () => {
    const b = await body().catch(() => ({}))
    const note = typeof b?.note === 'string' ? b.note.slice(0, 300) : ''
    const run = async () => {
      const c = ctx()
      switch (params.action) {
        case 'apply': return apply(c, params.id, 'owner')
        case 'send': return send(c, params.id, 'apply', 'owner', note)
        case 'veto': return veto(c, params.id, note)
        case 'revert': return revert(c, params.id, note || 'the owner reverted it', 'owner')
        case 'pin': return pin(c, params.id, true)
        case 'unpin': return pin(c, params.id, false)
        default: throw new HttpError(404, 'action is apply, send, veto, revert, pin or unpin')
      }
    }
    const p = await serial(FUND_ROOT, run)
    publish('loop', { proposal: p.id, state: p.state })
    publish('git')
    return { ...p, body: undefined }
  }))

  /** the daily score series per agent (or pooled for ?agents=a,b), from loop_metrics as stored */
  r.get('/api/loop/metrics', async ({ query }) => {
    const days = Math.min(120, Math.max(1, Number(query.get('days') ?? 30)))
    const now = Date.now()
    const want = (query.get('agents') ?? '').split(',').map(s => s.trim()).filter(Boolean)
    const agents = want.length ? want : config.agents().map(a => a.id)
    const rows = await M.stored(db, M.dayOf(now - (days - 1) * DAY), M.dayOf(now), agents)
    return { days, agents, pooled: await M.series(db, agents, now - (days - 1) * DAY, now), rows: rows.map(r => ({ ...r, components: M.components(r.counts) })) }
  })

  r.get('/api/loop/commit', async ({ query }) => {
    const repo = config.repos().find(x => x.id === query.get('repo'))
    if (!repo) throw new HttpError(404, 'no such repo')
    const sha = query.get('sha') ?? ''
    if (!/^[0-9a-f]{7,40}$/i.test(sha)) throw new HttpError(400, 'sha must be hex')
    const out = await git(join(FUND_ROOT, repo.path), ['show', '--stat', '--no-color', '--format=%H%n%aI%n%n%B', sha])
    if (out.code !== 0) throw new HttpError(404, out.stderr.trim() || 'not found')
    return { repo: repo.id, sha, text: out.stdout }
  })
}

export async function services(): Promise<ServiceGroup | null> {
  const due = retros(Date.now()).filter(x => x.due)
  const rows: ServiceGroup['rows'] = [{ id: 'loop:retros', label: 'retros', room: 'loop', status: due.length ? 'warn' : 'ok', reading: due.length ? `${due.length} due` : 'none due' }]
  try {
    const { proposals } = list(FUND_ROOT)
    const open = proposals.filter(p => ownerWaits(p, readConfig(CONFIG_FILES).autoApply)).length
    const watching = proposals.filter(p => p.state === 'watching')
    const worse = watching.filter(p => p.watch.verdict === 'worse').length
    rows.push({ id: 'loop:watch', label: 'watching', room: 'loop', status: worse ? 'warn' : watching.length ? 'ok' : 'off', reading: watching.length ? `${watching.length}${worse ? `, ${worse} worse` : ''}` : 'none' })
    const lp = await lastPass(db)
    rows.push({ id: 'loop:pass', label: 'last pass', room: 'loop', status: lp === null ? 'off' : lp.ok ? 'ok' : 'fail', reading: lp === null ? 'never ran' : `${open ? `${open} proposed · ` : ''}${ago(Date.now() - lp.ts)} ago`, hint: lp === null ? undefined : `last pass ${stamp(lp.ts)}, ${open} proposal${open === 1 ? '' : 's'} open` })
  } catch { /* the lanes route reports it */ }
  return { id: 'loop', label: 'Loop', rows }
}
