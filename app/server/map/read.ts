import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { dataDir } from '@fund/db'
import type { MapCommit, MapGraph, MapNode } from '../../shared/map.ts'
import type { Repo } from '../../shared/types.ts'
import { reach, where } from '../db.ts'
import { BOARD_DIR, FUND_ROOT, LAB_DIR, PORT, SCHEDULE_FILE, labRel } from '../paths.ts'
import { readRegistry, roster, config } from '../config.ts'
import { listItems } from '../board/store.ts'
import { loadJobs } from '../sched/plan.ts'
import { git } from '../git/run.ts'
import { lastFetchedAt, readState } from '../git/repo.ts'
import { buildMap, repoOf, type JobIn, type MapInput, type RepoIn } from './build.ts'

/**
 * THE MAP'S READER: the files and git's answers the builder needs, then the last commit of every
 * node that names a path. Git is read, never fetched (the Git room fetches; `as of fetch` says when).
 * The whole graph is cached for TTL_MS and dropped when the configuration moves (`config`), so a
 * burst of clicks costs one read; a request for fresh data (?fresh=1) reads again.
 */

export const PIPELINE_REL = 'app/library/law/the-atlas/pipeline.json'
export const DATAFLOW_REL = 'app/library/law/the-atlas/data-flow.json'
export const TTL_MS = 60_000
const UI_PORT = Number(process.env.FUND_UI_PORT ?? 4688)

const abs = (rel: string) => join(FUND_ROOT, rel)

/**
 * Where each storage class of the market store lives (B-0322 section 1). ASSUMED until the database
 * posts its paths on B-0324: the cache and the pins beside the lake under the data root ($FUND_DB_DIR,
 * else ~/fund-data/db), the archive the lake's market/ folder itself. When the real paths land, swap
 * them HERE and nowhere else.
 */
export function storePaths(root = dataDir()): { archive: string; cache: string; pins: string } {
  return { archive: join(root, 'market'), cache: join(root, 'cache'), pins: join(root, 'pins') }
}

/** `[cache] max_bytes` from database/retention.toml; null when the file, the table or the key is not there */
export function cacheBudget(toml: string): number | null {
  const sec = /^\s*\[cache\]\s*$([\s\S]*?)(?=^\s*\[|(?![\s\S]))/m.exec(toml)?.[1]
  const v = sec && /^\s*max_bytes\s*=\s*([0-9_]+)\s*(?:#.*)?$/m.exec(sec)?.[1]
  return v ? Number(v.replace(/_/g, '')) : null
}

const isDir = (p: string) => { try { return statSync(p).isDirectory() } catch { return false } }
const fwd = (p: string) => p.replace(/\\/g, '/')

function readLake(): MapInput['lake'] {
  const s = storePaths()
  let budget: number | null = null
  try { budget = cacheBudget(readFileSync(abs('database/retention.toml'), 'utf8')) } catch { /* no file: unknown */ }
  return {
    path: fwd(s.archive), exists: isDir(s.archive),
    cache: { path: fwd(s.cache), exists: isDir(s.cache) },
    pins: { path: fwd(s.pins), exists: isDir(s.pins) },
    budget,
  }
}

function mdIn(rel: string): string[] {
  try { return readdirSync(abs(rel), { withFileTypes: true }).filter(e => e.isFile() && e.name.toLowerCase().endsWith('.md')).map(e => `${rel}/${e.name}`).sort() } catch { return [] }
}

/** a lab desk is a folder holding beliefs.md or results-log.md, one or two levels under the lab */
export function listDesks(dir = LAB_DIR, rel = labRel()): string[] {
  const out: string[] = []
  const isDesk = (d: string) => existsSync(join(d, 'beliefs.md')) || existsSync(join(d, 'results-log.md'))
  const kids = (d: string) => { try { return readdirSync(d, { withFileTypes: true }).filter(e => e.isDirectory() && !/^[._]/.test(e.name)).map(e => e.name).sort() } catch { return [] } }
  for (const a of kids(dir)) {
    if (isDesk(join(dir, a))) out.push(`${rel.replace(/^platform\//, '')}/${a}`)
    for (const b of kids(join(dir, a))) if (isDesk(join(dir, a, b))) out.push(`${rel.replace(/^platform\//, '')}/${a}/${b}`)
  }
  return out
}

async function lsTop(dir: string): Promise<{ folders: string[] | null; files: string[] | null }> {
  const r = await git(dir, ['ls-tree', '--name-only', '-z', 'HEAD'])
  const t = await git(dir, ['ls-tree', '-d', '--name-only', '-z', 'HEAD'])
  if (r.code !== 0 || t.code !== 0) return { folders: null, files: null }
  const folders = t.stdout.split('\0').filter(Boolean)
  const files = r.stdout.split('\0').filter(x => x && !folders.includes(x))
  return { folders, files }
}

/** the build worktrees beside a repo's main checkout (`git worktree list`), the main one left out */
export function parseWorktrees(porcelain: string): { path: string; branch: string | null }[] {
  const out: { path: string; branch: string | null }[] = []
  for (const block of porcelain.split(/\r?\n\r?\n/)) {
    const path = /^worktree (.+)$/m.exec(block)?.[1]
    if (!path) continue
    const br = /^branch refs\/heads\/(.+)$/m.exec(block)?.[1] ?? null
    out.push({ path, branch: br })
  }
  return out.slice(1)
}

async function repoIn(r: Repo & Record<string, unknown>): Promise<RepoIn> {
  const dir = abs(r.path)
  const [state, top, wt] = await Promise.all([
    readState(dir).catch((e): RepoIn['state'] => ({ branch: null, upstream: null, dirty: 0, conflicts: 0, midOp: null, ahead: null, behind: null, head: null, error: String((e as Error)?.message ?? e) })),
    lsTop(dir),
    git(dir, ['worktree', 'list', '--porcelain']),
  ])
  return {
    id: r.id, path: r.path, holds: r.holds, verify: r.verify, guarded: r.guarded,
    remote: typeof r.remote === 'string' ? r.remote : undefined,
    needs: Array.isArray(r.needs) ? (r.needs as unknown[]).map(String) : undefined,
    lands: typeof r.lands === 'string' ? r.lands : undefined,
    state, fetchedAt: lastFetchedAt(dir), ...top,
    worktrees: wt.code === 0 ? parseWorktrees(wt.stdout) : [],
  }
}

/** the newest commit touching any of the paths, in the repo that holds the first */
async function lastCommit(paths: string[], repos: { id: string; path: string }[]): Promise<MapCommit | null> {
  const repo = repoOf(paths[0], repos)
  if (!repo) return null
  const base = repo.path === '.' ? '' : repo.path.replace(/\/+$/, '') + '/'
  const inner = paths.filter(p => repoOf(p, repos) === repo).map(p => (p.startsWith(base) ? p.slice(base.length) : p) || '.')
  const r = await git(abs(repo.path), ['log', '-1', '--format=%h%x1f%s%x1f%at', '--', ...inner])
  const [sha, subject, at] = r.stdout.trim().split('\x1f')
  return r.code === 0 && sha ? { sha, subject, ts: Number(at) * 1000, repo: repo.id } : null
}

/** run `f` over `xs`, `n` at a time (each git call is a process: a Windows box pays per spawn) */
async function pool<T>(xs: T[], n: number, f: (x: T) => Promise<void>) {
  let k = 0
  await Promise.all(Array.from({ length: Math.min(n, xs.length) }, async () => { while (k < xs.length) await f(xs[k++]) }))
}

const commitPaths = (n: MapNode): string[] | null => {
  if (n.kind === 'stage') { const ev = (n.checks ?? []).filter(c => !c.label.startsWith('loop: ') && c.state === 'ok').map(c => c.label); return ev.length ? ev : null }
  if (n.kind === 'repo' || n.kind === 'remote' || n.kind === 'worktree' || n.kind === 'files' || n.kind === 'external') return null
  return n.path && existsSync(abs(n.path)) ? [n.path] : null
}

export async function readInput(): Promise<MapInput> {
  const problems: { path: string; error: string }[] = []
  const repos = config.repos() as (Repo & Record<string, unknown>)[]
  const r = roster()
  problems.push(...r.problems)
  const dash = readRegistry()
  problems.push(...dash.problems)
  let jobs: JobIn[] = []
  try {
    const j = loadJobs(JSON.parse(readFileSync(SCHEDULE_FILE, 'utf8')))
    jobs = j.jobs.map(x => ({ id: x.id, cwd: x.cwd, cmd: x.cmd, cadence: x.cadence, enabled: x.enabled, kind: x.kind, agent: x.agent }))
    problems.push(...j.errors.map(error => ({ path: 'app/schedule.json', error })))
  } catch (e) { problems.push({ path: 'app/schedule.json', error: `unreadable: ${(e as Error).message}` }) }
  let pipeline: MapInput['pipeline']
  try { pipeline = { doc: JSON.parse(readFileSync(abs(PIPELINE_REL), 'utf8')) } } catch (e) { pipeline = { error: existsSync(abs(PIPELINE_REL)) ? `unreadable: ${(e as Error).message}` : 'missing' } }
  let dataFlow: MapInput['dataFlow']
  try { dataFlow = { doc: JSON.parse(readFileSync(abs(DATAFLOW_REL), 'utf8')) } } catch (e) { dataFlow = { error: existsSync(abs(DATAFLOW_REL)) ? `unreadable: ${(e as Error).message}` : 'missing' } }
  let pg: MapInput['pg']
  try { await reach(2_000); pg = { ok: true } } catch (e) { pg = { ok: false, why: String((e as Error)?.message ?? e).slice(0, 200) } }
  const board = listItems(BOARD_DIR).map(b => ({ id: b.id, title: b.title, status: b.status, owner: b.owner }))
  return {
    repos: await Promise.all(repos.map(repoIn)),
    agents: r.agents, dashboards: dash.dashboards, jobs, desks: listDesks(),
    pipeline, pipelinePath: PIPELINE_REL, dataFlow, dataFlowPath: DATAFLOW_REL,
    exists: rel => existsSync(abs(rel)), mdIn, board,
    ports: { ui: UI_PORT, fundd: PORT, pg: (() => { try { return where().port } catch { return null } })() },
    pg, lake: readLake(), problems,
  }
}

/** the graph, with every path-naming node's last commit */
export async function readMap(): Promise<MapGraph> {
  const input = await readInput()
  const g = buildMap(input)
  const todo = g.views.flatMap(v => v.nodes).map(n => ({ n, paths: commitPaths(n) })).filter((x): x is { n: MapNode; paths: string[] } => !!x.paths)
  await pool(todo, 6, async ({ n, paths }) => { n.commit = await lastCommit(paths, input.repos) })
  return g
}

let cache: { at: number; g: Promise<MapGraph> } | null = null
export function cachedMap(fresh = false): Promise<MapGraph> {
  if (!fresh && cache && Date.now() - cache.at < TTL_MS) return cache.g
  const g = readMap()
  cache = { at: Date.now(), g }
  g.catch(() => { if (cache?.g === g) cache = null })
  return g
}
export const dropMap = () => { cache = null }
