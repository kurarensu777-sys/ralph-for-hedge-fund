import { join } from 'node:path'
import type { Router } from '../http.ts'
import { HttpError } from '../http.ts'
import type { Repo, ServiceGroup } from '../../shared/types.ts'
import { logEvent, ops, transaction } from '../db.ts'
import { publish } from '../events.ts'
import { FUND_ROOT } from '../paths.ts'
import { latestReading } from '../system/probes.ts'
import { config } from '../config.ts'
import { git } from '../git/run.ts'
import { LOG_FORMAT, parseLog, type LogEntry } from '../git/parse.ts'
import { fetchIfStale, lastFetchedAt, readState, repoReading, repoTone, syncSummary, syncTree, type RepoState, type SyncResult } from '../git/repo.ts'
import { guardState, installGuard, type GuardState } from '../git/guard.ts'
import { gitProbeRepos, REPROBE_MS, reprobeFor } from '../git/probe.ts'
import { commitShrink, touchesLibrary } from '../git/shrink.ts'
import { runJob } from '../hooks.ts'
import { ANNALS, erasWithCounts, isDay } from '../git/eras.ts'
import { PAGE, agentOf, filterLog, pageOf } from '../git/logq.ts'
import { LandQueue } from '../git/land.ts'
import { LAND_FILE, branches, buildAgents, dropBranch, landWork, queueView, startBuild } from '../git/build.ts'
import { SAFE_CONV, buildRepos, neverLands } from '../git/wtpath.ts'
import { dayKey, dayRange, lastDays, repoActivity } from '../git/activity.ts'

// ROOM: git - every repo in repos.json: status, log (trailers indexed), sync.

const dirOf = (r: Repo) => join(FUND_ROOT, r.path)

type Card = Repo & { state: RepoState; tone: string; reading: string; fetchedAt: number | null; guard: GuardState }

/** every managed tree: the fund repo (always) plus repos.json */
function managed(): Repo[] {
  const rs = config.repos()
  return rs.some(r => r.path === '.' || r.path === '') ? rs : [{ id: 'fund', path: '.', holds: 'the control repo' }, ...rs]
}

/** install the guard hooks everywhere (idempotent); one event line when anything changed */
export async function installGuards(): Promise<{ id: string; state: string; detail: string; changed: boolean }[]> {
  const out = await Promise.all(managed().map(async r => ({ id: r.id, ...(await installGuard(dirOf(r))) })))
  const changed = out.filter(x => x.changed)
  if (changed.length) logEvent('system', `git guard installed: ${changed.map(x => x.id).join(', ')}`, { payload: out })
  cache = null
  guards.clear()
  publish('git', { guard: true })
  return out
}

let cache: { at: number; cards: Card[] } | null = null
let inflight: Promise<Card[]> | null = null

// a repo's guard (core.hooksPath) moves only when installGuards runs or a hand re-points it: read
// once a minute, not on every card refresh (each read is 2-3 git processes, ~6 ms of spawn apiece
// on the event loop on Windows)
const GUARD_MS = 60_000
const guards = new Map<string, { at: number; g: Promise<GuardState> }>()
function guardOf(dir: string): Promise<GuardState> {
  const hit = guards.get(dir)
  if (hit && Date.now() - hit.at < GUARD_MS) return hit.g
  const g = guardState(dir)
  guards.set(dir, { at: Date.now(), g })
  g.catch(() => guards.delete(dir))
  return g
}

async function cards(fresh = false): Promise<Card[]> {
  if (!fresh && cache && Date.now() - cache.at < 5_000) return cache.cards
  if (inflight) return inflight
  inflight = Promise.all(config.repos().map(async r => {
    const [state, guard] = await Promise.all([readState(dirOf(r)), guardOf(dirOf(r))])
    return { ...r, state, tone: repoTone(state), reading: repoReading(state), fetchedAt: lastFetchedAt(dirOf(r)), guard }
  })).then(c => { cache = { at: Date.now(), cards: c }; inflight = null; void reprobeIfStale(c); return c })
    .catch(e => { inflight = null; throw e })
  return inflight
}

// the git probe's snapshot vs these live cards: re-run it only when they disagree on behind (the one
// red rule), at most every 3 min (server/git/probe.ts reprobeFor; dirty/ahead churn never re-runs it, B-0056)
let lastReprobe = 0
async function reprobeIfStale(c: Card[]) {
  if (Date.now() - lastReprobe < REPROBE_MS) return
  let reading: Record<string, any> | null = null
  try { reading = await latestReading('git') } catch { return }     // the store not answering: no verdict to compare
  const off = reprobeFor(gitProbeRepos(reading), c.map(x => ({ id: x.id, behind: x.state.behind })), Date.now(), lastReprobe)
  if (!off.length) return
  lastReprobe = Date.now()
  void runJob('probe-git').then(ok => { if (ok) logEvent('system', `git probe re-run: its reading disagreed with the Git room on behind for ${off.join(', ')}`) })
}

/** fetch in the background (at most every 5 min per repo); announce when counts may have moved */
function backgroundFetch() {
  for (const r of config.repos()) {
    fetchIfStale(dirOf(r)).then(did => { if (did) { cache = null; publish('git', { fetched: r.id }) } }).catch(() => {})
  }
}

const logCache = new Map<string, { head: string; entries: LogEntry[] }>()

/** a date range for the log: an era's from..to (inclusive days) */
export type Range = { since: string; until: string | null }

/** a repo's history as the log reads it, newest LOG_CAP commits: every filter runs over all of it
 *  (the fund's repos hold ~1,200 commits together on 2026-09-27; a cap it hits is said in the reply) */
const LOG_CAP = 5000

async function repoLog(r: Repo): Promise<LogEntry[]> {
  const dir = dirOf(r)
  const head = (await git(dir, ['rev-parse', 'HEAD'])).stdout.trim()
  if (!head) return []
  const key = r.id
  const hit = logCache.get(key)
  if (hit && hit.head === head) return hit.entries
  const out = await git(dir, ['log', `-${LOG_CAP}`, `--format=${LOG_FORMAT}`, '--name-only'])
  const entries = out.code === 0 ? parseLog(out.stdout) : []
  await index(r.id, entries)
  await indexShrink(r.id, dir, entries)
  logCache.set(key, { head, entries })
  return entries
}

/** idempotent: a commit is immutable (its sha names its content), so only shas the store does not
 *  hold yet are written - a log of thousands re-read after one new commit writes one row. The
 *  (repo, sha) primary key still makes any re-index an update, never a duplicate. */
async function index(repo: string, entries: LogEntry[]) {
  if (!entries.length) return
  const have = await ops.knownCommits(repo, entries.map(e => e.sha))
  const fresh = entries.filter(e => !have.has(e.sha))
  if (!fresh.length) return
  // one transaction: one connection and one commit for the batch (shrink_json is not written here,
  // so an upsert keeps the one indexShrink stored)
  await transaction(async c => {
    for (const e of fresh) {
      await ops.upsertCommit({ repo, sha: e.sha, ts: e.ts, author: e.author, agent_id: e.trailers.agent, conversation_id: e.trailers.conversation,
        subject: e.subject, files_json: e.files, change_id: e.trailers.changeId, loop_change: e.trailers.loopChange }, c)
    }
  })
}

/**
 * THE BOOK SHRINK INDEX: every commit that touched a library book gets `shrink_json` (the same
 * rule as the commit-msg hook, on `sha^:path` vs `sha:path`). Computed once per commit - a row
 * already carrying one is read back, never recomputed - and attached to the entry in place.
 */
async function indexShrink(repo: string, dir: string, entries: LogEntry[]) {
  const lib = entries.filter(e => touchesLibrary(e.files))
  for (const e of entries) e.shrink = null
  if (!lib.length) return
  const have = await ops.commitShrinks(repo, lib.map(e => e.sha))
  for (const e of lib) {
    const stored = have.get(e.sha)
    if (stored) {
      try {
        const rep = stored as NonNullable<LogEntry['shrink']>
        // a report stored before reworded headings were told apart from lost ones (no renamedHeadings
        // on a flagged file) is recomputed once; the rule only ever un-flags, so an empty one stands
        if (!rep.files?.some((f: { renamedHeadings?: unknown }) => !Array.isArray(f.renamedHeadings))) { e.shrink = rep; continue }
      } catch { /* a bad row is recomputed below */ }
    }
    const rep = await commitShrink(dir, e.sha, [e.subject, e.body].join('\n\n'))
    e.shrink = rep
    if (rep) await ops.update('commits', [repo, e.sha], { shrink_json: rep })
  }
}

function repoById(id: string): Repo {
  const r = config.repos().find(x => x.id === id)
  if (!r) throw new HttpError(404, `no repo ${id} in repos.json`)
  return r
}

/** the Conversation trailers in a commit list, newest first, with their chat title when the
 *  cockpit still knows it (null = not in this cockpit's database: another machine, or deleted) */
async function conversationsOf(commits: { ts: number; trailers: { conversation: string | null; agent: string | null } }[]) {
  const seen = new Map<string, { id: string; last: number; n: number; agent: string | null; title: string | null }>()
  for (const c of commits) {
    const id = c.trailers.conversation
    if (!id) continue
    const x = seen.get(id)
    if (x) { x.n++; x.last = Math.max(x.last, c.ts) } else seen.set(id, { id, last: c.ts, n: 1, agent: c.trailers.agent, title: null })
  }
  if (seen.size) {
    try {
      const ids = [...seen.keys()]
      const rows = await ops.select('conversations', { where: { id: ids } })
      for (const r of rows) { const x = seen.get(r.id)!; x.title = r.title || null; x.agent ??= r.agent_id }
    } catch { /* titles are a convenience; the ids still filter */ }
  }
  return [...seen.values()].sort((a, b) => b.last - a.last)
}

let syncing: Promise<unknown> | null = null

// THE LAND QUEUE (git/land.ts): persisted under ~/fund-data/worktrees, one land at a time
let queue: LandQueue | null = null
const landQueue = () => (queue ??= new LandQueue(LAND_FILE, landWork, () => { cache = null; publish('git', { land: true }) }))

export function register(r: Router) {
  // fundd start: every managed repo gets the guard hooks (idempotent; foreign setups left alone)
  installGuards().catch(e => logEvent('system', `git guard install failed: ${e?.message ?? e}`))
  // a land that was queued (or running) when the daemon stopped runs now
  if (landQueue().items.some(x => x.state === 'queued')) void landQueue().kick()

  r.post('/api/git/guard', async () => ({ repos: await installGuards() }))

  r.get('/api/git/repos', async ({ query }) => {
    if (query.get('fetch') !== '0') backgroundFetch()
    return { repos: await cards(query.get('fresh') === '1') }
  })

  // THE LOG: every filter runs server-side over the whole history in scope, then one page is served
  // (offset/limit, newest first). total = what the filters matched; scope = the repo + era before them
  r.get('/api/git/log', async ({ query }) => {
    const want = query.get('repo')
    const agent = query.get('agent') ?? ''
    const conv = query.get('conversation')
    const shrink = query.get('shrink') === '1'
    const text = (query.get('q') ?? '').trim().slice(0, 200)
    const offset = Number(query.get('offset') ?? 0)
    const limit = Number(query.get('limit') ?? PAGE)
    if (!Number.isFinite(offset) || offset < 0 || !Number.isFinite(limit) || limit < 1) throw new HttpError(400, 'offset and limit are non-negative numbers')
    const since = query.get('since'), until = query.get('until')
    if (since && !isDay(since)) throw new HttpError(400, 'since must be YYYY-MM-DD')
    if (until && until !== 'open' && !isDay(until)) throw new HttpError(400, 'until must be YYYY-MM-DD or open')
    if (since && until && until !== 'open' && since > until) throw new HttpError(400, 'since is after until')
    const range: Range | null = since || until ? { since: since ?? '1970-01-01', until: until && until !== 'open' ? until : null } : null
    const repos = config.repos().filter(x => !want || x.id === want)
    const lists = await Promise.all(repos.map(async x => (await repoLog(x)).map(e => ({ repo: x.id, ...e }))))
    const capped = repos.filter((_, i) => lists[i].length >= LOG_CAP).map(x => x.id)
    const all = lists.flat().sort((a, b) => b.ts - a.ts)
    const roster = new Set(config.agents().map(a => a.id))
    const inScope = filterLog(all, { agent: '', text: '', range }, roster)
    const agents = [...new Set(inScope.map(c => agentOf(c.trailers.agent)).filter(Boolean))].sort()
    let commits = filterLog(inScope, { agent, text, range: null }, roster)
    const conversations = await conversationsOf(commits)
    if (conv === '-') commits = commits.filter(c => !c.trailers.conversation)
    else if (conv) commits = commits.filter(c => c.trailers.conversation === conv)
    const shrunk = commits.filter(c => (c.shrink?.files.length ?? 0) > 0)
    if (shrink) commits = shrunk
    return { commits: pageOf(commits, offset, limit), total: commits.length, scope: inScope.length, shrink: shrunk.length, offset, agents, conversations, capped }
  })

  // the era band: the CEO's annals books, each with its commit count per repo (frontmatter only)
  r.get('/api/git/eras', async () => ({
    series: ANNALS,
    eras: await erasWithCounts(FUND_ROOT, config.repos().map(x => ({ id: x.id, dir: dirOf(x) }))),
  }))

  // the charts: commits per local day per repo and per agent (read-only, cached by HEAD). Default the
  // last 14 days; since/until (an era) give that range, its last 90 days when longer
  r.get('/api/git/activity', async ({ query }) => {
    const since = query.get('since'), until = query.get('until')
    if (since && !isDay(since)) throw new HttpError(400, 'since must be YYYY-MM-DD')
    if (until && until !== 'open' && !isDay(until)) throw new HttpError(400, 'until must be YYYY-MM-DD or open')
    const n = Math.max(1, Math.min(90, Number(query.get('days')) || 14))
    const days = since ? dayRange(since, !until || until === 'open' ? dayKey(Date.now()) : until) : lastDays(n)
    const repos = await Promise.all(config.repos().map(async x => {
      const a = await repoActivity(dirOf(x), days).catch(() => null)
      return { id: x.id, total: a?.total ?? null, agents: a?.agents ?? null }
    }))
    return { days, repos }
  })

  r.get('/api/git/show', async ({ query }) => {
    const repo = repoById(query.get('repo') ?? '')
    const sha = query.get('sha') ?? ''
    if (!/^[0-9a-f]{7,40}$/i.test(sha)) throw new HttpError(400, 'sha must be hex')
    const out = await git(dirOf(repo), ['show', '--stat', '--format=%B', '--no-color', sha])
    if (out.code !== 0) throw new HttpError(404, out.stderr.trim() || 'not found')
    return { repo: repo.id, sha, text: out.stdout }
  })

  // BUILD BRANCHES + THE LAND QUEUE
  r.get('/api/git/branches', async ({ query }) => {
    const q = landQueue()
    const rows = await branches(q)
    const limit = Math.min(1000, Math.max(1, Number(query.get('limit')) || 200))
    return {
      repos: buildRepos().map(r => r.id).filter(id => config.repos().some(x => x.id === id)),
      agents: buildAgents(),
      branches: rows,
      queue: queueView(q.items, rows, limit),
      lands: q.items.length,
    }
  })

  r.post('/api/git/branches', async ({ body }) => {
    const b = await body()
    if (typeof b?.agent !== 'string' || !b.agent) throw new HttpError(400, 'agent required')
    const title = typeof b.title === 'string' ? b.title.trim() : ''
    if (!title) throw new HttpError(400, 'title required: it names the branch')
    try { return await startBuild(b.agent, title, typeof b.prompt === 'string' ? b.prompt : undefined) }
    catch (e) { throw new HttpError(409, (e as Error).message) }
  })

  r.post('/api/git/branches/drop', async ({ body }) => {
    const b = await body()
    const repo = String(b?.repo ?? ''), conv = String(b?.conversation ?? '')
    if (!SAFE_CONV.test(conv)) throw new HttpError(400, 'conversation required')
    try { const rm = await dropBranch(repo, conv); cache = null; publish('git', { dropped: conv }); return rm }
    catch (e) { throw new HttpError(409, (e as Error).message) }
  })

  r.post('/api/git/land', async ({ body }) => {
    const b = await body()
    const repo = String(b?.repo ?? ''), conv = String(b?.conversation ?? '')
    if (neverLands().includes(repo)) throw new HttpError(403, `${repo} never lands from the cockpit: the owner merges its pull requests`)
    if (!buildRepos().some(r => r.id === repo)) throw new HttpError(400, `${repo || 'repo'} has no build branches`)
    if (!SAFE_CONV.test(conv)) throw new HttpError(400, 'conversation required')
    const q = landQueue()
    const w = (await branches(q)).find(x => x.repo === repo && x.conversation === conv)
    if (!w || !w.branch) throw new HttpError(404, 'no such build branch')
    if (w.live === 'live') throw new HttpError(409, 'the agent is mid-turn in this worktree: land when it is idle')
    return { item: q.enqueue({ repo, branch: w.branch, worktree: w.path, conversation: conv, agent: w.agent }) }
  })

  r.post('/api/git/sync', async ({ body }) => {
    const b = await body()
    if (syncing) throw new HttpError(409, 'a sync is already running')
    const repos = b?.repo ? [repoById(String(b.repo))] : config.repos()
    const run = (async () => {
      const results: { id: string; result: SyncResult }[] = []
      for (const x of repos) results.push({ id: x.id, result: await syncTree(dirOf(x), { guarded: x.guarded }) })
      return results
    })()
    syncing = run
    try {
      const results = await run
      const summary = syncSummary(results)
      logEvent('commit', `sync: ${summary}`, { payload: results.map(x => ({ id: x.id, action: x.result.action, note: x.result.note })) })
      cache = null
      publish('git', { synced: true })
      publish('services')
      return {
        summary,
        repos: results.map(x => ({ id: x.id, action: x.result.action, note: x.result.note, reading: x.result.after ? repoReading(x.result.after) : repoReading(x.result.before) })),
      }
    } finally { syncing = null }
  })
}

/** the rail's cards: up to RAIL_MS old is served as is (a refresh starts behind it once past the
 *  room's 5 s, and a reading that moved is announced on `services`), so the rail - fetched on
 *  every `services` event - never waits on ~40 git processes */
const RAIL_MS = 30_000
async function railCards(): Promise<Card[]> {
  if (!cache || Date.now() - cache.at >= RAIL_MS) return cards()
  if (Date.now() - cache.at >= 5_000 && !inflight) {
    const before = cache.cards.map(x => `${x.id}:${x.tone}:${x.reading}`).join('|')
    void cards().then(c => { if (c.map(x => `${x.id}:${x.tone}:${x.reading}`).join('|') !== before) publish('services') }).catch(() => {})
  }
  return cache.cards
}

export async function services(): Promise<ServiceGroup | null> {
  const c = await railCards()
  return {
    id: 'repos', label: 'Repos',
    rows: c.map(x => ({ id: `repo:${x.id}`, label: x.id, status: x.tone as any, reading: x.reading, room: 'git', target: x.id })),
  }
}
