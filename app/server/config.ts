import { existsSync, readdirSync, readFileSync, watch, type FSWatcher } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { Agent, Dashboard, Repo, Shelf } from '../shared/types.ts'
import { publish } from './events.ts'
import { AGENTS_DIR, AGENTS_REL, APP_LIBRARY_REL, BOARD_CONFIG_FILE, CONTROLS_FILE, DASHBOARD_FILE, DASHBOARDS_DIR, FUND_ROOT, LEGACY_LIBRARY_REL, LOOP_CONFIG_FILE, REAPER_FILE, REPOS_FILE, SCHEDULE_FILE, currentAgentId, fundRel } from './paths.ts'
import { docWithCap, readControls } from './system/controlsfile.ts'
import { readReapConfig, type ReapConfig } from './chat/reaper.ts'
import { readRoster, saveAgentFiles, type RosterProblem } from './roster.ts'
import { deriveShelves } from './shelves.ts'
import { dashboardFileErrors, registryErrors } from './proc/configwrite.ts'

/**
 * The fund's configuration, read fresh on demand (the files are small) and announced on the event
 * bus as topic `config` when any of them changes, so the UI never holds a stale copy. The spine/
 * folder these used to share was retired on 2026-09-25; each file now lives with what it describes:
 *
 *   the roster       one file per agent         app/agents/<id>.md (server/roster.ts)
 *   repos.json       the repo + verify           <fund>/repos.json (the root keeps the law)
 *   schedule.json    the jobs                   app/schedule.json (read by server/sched)
 *   the loop         its autonomy setting       app/loop/config.json (server/loop/config.ts)
 *   the board        Auto / Manual + its model  app/board/config.json (server/board/config.ts)
 *   dashboards       one file per dashboard     platform/dashboards/<id>/dashboard.json
 *   shelves          DERIVED, never configured  server/shelves.ts over app/library/ (the one library)
 *
 * The topic `config` means "the fund's configuration moved"; it was called `spine`, after that
 * folder, until B-0084 renamed it with this file (was server/spine.ts).
 */

function readJson<T>(file: string, fallback: T): T {
  try { return JSON.parse(readFileSync(file, 'utf8')) as T } catch { return fallback }
}

/** `{key: [...]}` or a bare list: the list, else [] */
function listOf<T>(doc: unknown, key: string): T[] {
  if (Array.isArray(doc)) return doc as T[]
  const v = doc && typeof doc === 'object' ? (doc as Record<string, unknown>)[key] : undefined
  return Array.isArray(v) ? v as T[] : []
}

// ---- dashboards: collected from every <id>/dashboard.json, each validated on its own ----

export type DashboardProblem = { path: string; error: string }
export type DashboardRead = { dashboards: Dashboard[]; problems: DashboardProblem[] }

/**
 * Every `<dir>/<id>/dashboard.json`, validated. A file that does not parse or does not satisfy
 * the shape is LEFT OUT and named in `problems` (the Dash room shows it; the rest still run). There
 * is no service kind: live data is the platform's in-process library inside each dashboard (live
 * data v2, 2026-09-26), never a process the cockpit launches. Faults
 * between files (an order or an agent used twice, one port claimed by two servers) are named too,
 * but no row is dropped for them: which one is wrong is the owner's call. Sorted by `order`, then
 * id. The shape is the platform's `dashboards/registry.py`; this is its reader in the cockpit.
 */
export function readDashboards(dir = DASHBOARDS_DIR): DashboardRead {
  const out: Dashboard[] = []
  const problems: DashboardProblem[] = []
  const load = (file: string, folder: string) => {
    const path = fundRel(file)
    let doc: unknown
    try { doc = JSON.parse(readFileSync(file, 'utf8')) } catch (e) { problems.push({ path, error: `unreadable: ${(e as Error).message}` }); return }
    const errs = dashboardFileErrors(doc, folder)
    if (errs.length) { problems.push({ path, error: errs.join('; ') }); return }
    out.push(doc as Dashboard)
  }
  let folders: string[] = []
  try { folders = readdirSync(dir, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name).sort() } catch { /* no dashboards home */ }
  for (const folder of folders) {
    const file = join(dir, folder, DASHBOARD_FILE)
    if (existsSync(file)) load(file, folder)
  }
  if (!out.length && !problems.length) return { dashboards: [], problems: [] }
  for (const error of registryErrors(out)) problems.push({ path: fundRel(dir), error })
  out.sort((a, b) => (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER) || a.id.localeCompare(b.id))
  return { dashboards: out, problems }
}

/** THE live registry the Dash room launches from: every dashboard.json */
export function readRegistry(): DashboardRead {
  return readDashboards(DASHBOARDS_DIR)
}

// ---- the readers ----

/** the roster, with the files that did not load (the System room names them) */
export function roster(): { agents: Agent[]; problems: RosterProblem[] } {
  const r = readRoster(AGENTS_DIR, AGENTS_REL)
  return { agents: r.agents, problems: r.problems }
}

export const config = {
  agents: () => readRoster(AGENTS_DIR, AGENTS_REL).agents,
  repos: () => listOf<Repo>(readJson(REPOS_FILE, null), 'repos'),
  dashboards: () => readRegistry().dashboards,
  shelves: (): Shelf[] => deriveShelves(FUND_ROOT, readRoster(AGENTS_DIR, AGENTS_REL).agents),
}

/** the raw roster as one document, `{agents: [<every header, with keys this code does not type,
 *  such as budgetTokensPerDay>]}`; null when no agent file loads */
export function agentsDoc(): Record<string, unknown> | null {
  const r = readRoster(AGENTS_DIR, AGENTS_REL)
  if (!r.headers.length) return null
  // the Controls page's daily cap is the fallback ceiling of an agent whose file writes none
  return docWithCap(r.headers, readControls(CONTROLS_FILE).tokenCap)
}

/** the idle-hand reaper's limits (app/reaper.json; a missing file or key is the default, chat/reaper.ts) */
export const reaperConfig = (): ReapConfig => readReapConfig(REAPER_FILE)

/** one agent by id; a retired id (paths.ts RETIRED_AGENTS: dash:trade -> dash:terminal) answers as its successor */
export function agent(id: string): Agent | undefined {
  const all = config.agents()
  return all.find(a => a.id === id) ?? all.find(a => a.id === currentAgentId(id))
}

/** Persist roster rows (boot-list toggles, model changes): each agent's header in its own file,
 *  the brief and every other key kept. Returns the fund-relative files written. */
export function saveAgents(agents: Agent[]): string[] {
  return saveAgentFiles(AGENTS_DIR, agents, AGENTS_REL)
}

// ---- the watch: one directory watcher per home, filtered to the files that are configuration ----

/** what the `config` topic announces: a fund-relative file, or a library home whose shelves changed */
type Home = { dir: string; recursive: boolean; hit: (name: string) => string | null; touch?: (name: string) => void }

export function homes(): Home[] {
  const file = (f: string): Home => ({ dir: dirname(f), recursive: false, hit: n => (n === basename(f) ? fundRel(f) : null) })
  return [
    file(REPOS_FILE),
    file(SCHEDULE_FILE),
    file(LOOP_CONFIG_FILE),
    { dir: AGENTS_DIR, recursive: false, hit: n => (n.toLowerCase().endsWith('.md') ? `${AGENTS_REL}/${n}` : null) },
    // a dashboard's file (its runbook is its CLAUDE.md beside it)
    { dir: DASHBOARDS_DIR, recursive: true, hit: n => (basename(n) === DASHBOARD_FILE ? fundRel(join(DASHBOARDS_DIR, n)) : null) },
    // a shelf appears or goes when a top-level library folder does
    ...[APP_LIBRARY_REL, LEGACY_LIBRARY_REL].map(rel => ({ dir: join(FUND_ROOT, rel), recursive: false, hit: (n: string) => (/\.[a-z]+$/i.test(n) ? null : `${rel}/${n}`) })),
    // the board's Auto / Manual switch and its model (after the homes above, so they keep their places)
    file(BOARD_CONFIG_FILE),
    file(CONTROLS_FILE),
  ]
}

const watchers = new Map<string, FSWatcher>()
let timer: ReturnType<typeof setInterval> | null = null

/** a watcher's `name` that is not a path under its home: Node on Windows reports a watched folder
 *  that was DELETED as an endless stream of events named after the folder itself, long-path prefix
 *  and all (seen 2026-09-26 as the long-path form of the retired platform library folder) - never a file inside it */
export function foreignName(n: string): boolean {
  return n.startsWith('//') || n.includes(':')
}

/**
 * Watch one home. A home that goes away closes its watcher (the re-arm picks it up if it comes
 * back) and is announced ONCE; announcements are coalesced per file over `coalesceMs`, so a burst
 * (a checkout, a rename storm) is one event per file, never a flood. Returns null when the home
 * is not on disk or cannot be watched.
 */
export function watchHome(h: Home, announce: (file: string) => void, coalesceMs = 250): FSWatcher | null {
  if (!existsSync(h.dir)) return null
  const pending = new Set<string>()
  let flush: ReturnType<typeof setTimeout> | null = null
  const queue = (file: string) => {
    pending.add(file)
    if (flush) return
    flush = setTimeout(() => { flush = null; const fs = [...pending]; pending.clear(); for (const f of fs) announce(f) }, coalesceMs)
    flush.unref?.()
  }
  let closed = false
  let w: FSWatcher
  const close = () => {
    if (closed) return
    closed = true
    try { w.close() } catch { /* gone */ }
    if (watchers.get(h.dir) === w) watchers.delete(h.dir)
  }
  try {
    w = watch(h.dir, { recursive: h.recursive }, (_e, name) => {
      if (closed) return
      const n = name ? String(name).replace(/\\/g, '/') : ''
      if (!n || foreignName(n)) {
        // the home itself moved: this handle is dead either way (it would keep firing), so close it;
        // gone -> announce the home once; replaced -> the watch re-arms on the new folder shortly
        close()
        if (!existsSync(h.dir)) queue(fundRel(h.dir))
        else if (timer) setTimeout(arm, 1_000).unref?.()
        return
      }
      const file = h.hit(n)
      if (file) queue(file)
      if (h.touch) h.touch(n)
    })
  } catch { return null }
  w.on('error', close)
  return w
}

function arm() {
  for (const h of homes()) {
    if (watchers.has(h.dir)) continue
    const w = watchHome(h, file => publish('config', { file }))
    if (w) watchers.set(h.dir, w)
  }
}

/** watch every configuration home; a home that does not exist yet (or was removed) is re-armed every 30 s */
export function watchConfig() {
  if (timer) return
  arm()
  timer = setInterval(arm, 30_000)
  timer.unref?.()
}

/** close every watcher (tests) */
export function stopConfigWatch() {
  if (timer) clearInterval(timer)
  timer = null
  for (const w of watchers.values()) { try { w.close() } catch { /* gone */ } }
  watchers.clear()
}
