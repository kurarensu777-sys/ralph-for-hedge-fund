import { existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { agentFileName } from '../shared/agentfile.ts'

/**
 * THE LAYOUT (2026-09-25, the owner's plan): the fund root holds only the law (CLAUDE.md, repos.json,
 * .claude/, start.bat); `app/` is the MACHINE that builds and improves the fund (this cockpit, the
 * roster, the board, the loop, the tools, the library of how we work); `platform/` IS the fund (the
 * core package, the sealed dashboards, the live feed, research, the lab and the market books);
 * `database/` is the one data layer. Every path here is either app-relative (what this repo owns) or
 * resolved against the layout that is on disk, so the cockpit reads a checkout on either side of a
 * sub-repo's move (the new home first, the old one while it is the only one there).
 * app/tools/_root.py is the python half; test/layout-parity.test.ts holds the two together.
 */

/** app */
export const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
/** the fund root: the app's PARENT (<fund>/app). FUND_ROOT wins; the grandparent is read only
 *  while a checkout still sits at the old <fund>/repos/app (2026-09-24..25) */
export const FUND_ROOT = process.env.FUND_ROOT ? resolve(process.env.FUND_ROOT) : fundAbove(APP_ROOT)
/** does `dir` look like the fund root: it carries repos.json, the list of the sub-repos (agents.json,
 *  the roster that marked it until 2026-09-25, is still accepted while an old checkout has it) */
export function isFundDir(dir: string): boolean {
  return existsSync(join(dir, 'repos.json')) || existsSync(join(dir, 'agents.json'))
}
function fundAbove(app: string): string {
  const parent = resolve(app, '..')
  const grand = resolve(app, '..', '..')
  return !isFundDir(parent) && isFundDir(grand) ? grand : parent
}
/** machine-local state that never enters git: logs, backups, the floor. The store itself is the ops
 *  store in PostgreSQL (database/, reached through @fund/db; its data under ~/fund-data/db) */
export const DATA_DIR = process.env.FUND_DATA_DIR ? resolve(process.env.FUND_DATA_DIR) : join(homedir(), 'fund-data')
/** the owner's time zone: a "day" in the store's readings (spend per day) is a local day here */
export const LOCAL_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
export const LOG_DIR = join(DATA_DIR, 'logs')
/** the floor: machine-local runtime state outside every repo - the STOP switch. Probe readings and
 *  the no-lesson stand-downs are rows of the ops store (ops.health_readings, ops.no_lesson) since
 *  2026-09-26. FUND_FLOOR wins, else <DATA_DIR>/floor. app/tools/_root.py floor_dir() is
 *  the same rule for the python tools. */
export const FLOOR_DIR = process.env.FUND_FLOOR ? resolve(process.env.FUND_FLOOR) : join(DATA_DIR, 'floor')
export const STOP_FILE = join(FLOOR_DIR, 'STOP')
export const PORT = Number(process.env.FUNDD_PORT ?? 4689)
/** the ONE venv: <fund>/.venv, with platform installed editable */
export const PYTHON = process.env.FUND_PYTHON ?? join(FUND_ROOT, '.venv', process.platform === 'win32' ? 'Scripts' : 'bin', process.platform === 'win32' ? 'python.exe' : 'python')
/** the code repo the platform helpers run in (fundplat.*) */
export const PLATFORM_ROOT = join(FUND_ROOT, 'platform')

// ---- the machine: what this repo holds (a fund-relative label beside each absolute path) ----
// Every one is resolved under FUND_ROOT (<fund>/app/...), not under this file's own checkout: the
// fund the cockpit serves is the one FUND_ROOT names (a test's scratch fund, or the live one, whose
// app/ IS this checkout), so a test never reads or rewrites the live roster, board or schedule.
export const APP_REL = 'app'
/** the machine's folder in the fund this cockpit serves (== APP_ROOT on the live tree) */
export const MACHINE_DIR = join(FUND_ROOT, APP_REL)
/** the roster: one app/agents/<id>.md per agent, a YAML header + the brief (shared/agentfile.ts) */
export const AGENTS_DIR = join(MACHINE_DIR, 'agents')
export const AGENTS_REL = `${APP_REL}/agents`
/** the board: app/board/B-NNNN.md */
export const BOARD_DIR = join(MACHINE_DIR, 'board')
export const BOARD_REL = `${APP_REL}/board`
/** the owner's own board: app/board/ceo/C-NNNN.md, a store the agents' board never reads (server/board/ceo.ts) */
export const CEO_DIR = join(BOARD_DIR, 'ceo')
/** the board's own setting: Auto / Manual pickup and the model board conversations boot on */
export const BOARD_CONFIG_FILE = join(BOARD_DIR, 'config.json')
/** the Controls view's own settings: dashboard wakes on / off and the daily token cap (server/system/controlsfile.ts) */
export const CONTROLS_FILE = join(MACHINE_DIR, 'controls.json')
/** the idle-hand reaper's limits: how long a chat's agent process may sit idle, the memory valve, the idle cap (server/chat/reaper.ts) */
export const REAPER_FILE = join(MACHINE_DIR, 'reaper.json')
/** the scheduled jobs */
export const SCHEDULE_FILE = join(MACHINE_DIR, 'schedule.json')
/** the self-improvement loop: its records (proposals, the watch and metrics ledgers), its python
 *  tools (preregister, record, remeasure, ... run with cwd = the fund root) and its autonomy setting */
export const LOOP_RECORDS_REL = `${APP_REL}/loop/records`
export const LOOP_TOOLS_REL = `${APP_REL}/loop/tools`
export const LOOP_CONFIG_FILE = join(MACHINE_DIR, 'loop', 'config.json')
/** probes, budget, check.py, clone.py, _root.py (the python half of this file) */
export const TOOLS_DIR = join(MACHINE_DIR, 'tools')
export const TOOLS_REL = `${APP_REL}/tools`
/** the sub-repos, at the fund root with the law */
export const REPOS_FILE = join(FUND_ROOT, 'repos.json')
/** the configuration files, in the order a setting (the loop's `loop` object) is looked up */
export const CONFIG_FILES = [LOOP_CONFIG_FILE, SCHEDULE_FILE, REPOS_FILE]

// ---- the fund (platform/): homes that moved in the 2026-09-25 relayout, current first ----
/** the first of `homes` (fund-relative) that exists under `fundRoot`, else the first (the current home) */
export function homeOf(homes: readonly string[], fundRoot: string = FUND_ROOT): string {
  return homes.find(h => existsSync(join(fundRoot, h))) ?? homes[0]
}
/** where the lab's desks live: platform/lab (the fund root's lab/ before) */
export const LAB_HOMES = ['platform/lab', 'lab'] as const
/** where each dashboard's folder (dashboard.json, its code, its own library/) lives */
export const DASHBOARD_HOMES = ['platform/dashboards'] as const
export const labRel = (fundRoot: string = FUND_ROOT) => homeOf(LAB_HOMES, fundRoot)
export const dashboardsRel = (fundRoot: string = FUND_ROOT) => homeOf(DASHBOARD_HOMES, fundRoot)
/** the lab folder of the layout on disk at start (a desk's own folder is resolved per call: deskDir) */
export const LAB_DIR = join(FUND_ROOT, labRel())
/** every <id>/dashboard.json under this folder is one dashboard */
export const DASHBOARDS_DIR = join(FUND_ROOT, dashboardsRel())
export const DASHBOARD_FILE = 'dashboard.json'
/** the MCP server list every agent the cockpit boots carries (server/chat/launch.ts mcpServers):
 *  the fund root's .mcp.json first (the root law, W1.4), then this repo's own app/.mcp.json. A
 *  relative `command` resolves against the folder of the file that names it. */
export const MCP_FILES_REL = ['.mcp.json', `${APP_REL}/.mcp.json`] as const
export const MCP_FILE = join(FUND_ROOT, MCP_FILES_REL[0])

// ---- the library: the shelves are DERIVED from these homes (server/shelves.ts) ----
/** THE ONE LIBRARY (2026-09-26): every top-level folder is a shelf - law, craft, app (how we work),
 *  markets, platform (what the fund knows), dashboards (one folder per dashboard, <id>/) */
export const APP_LIBRARY_REL = `${APP_REL}/library`
/** the fund root's library/, retired 2026-09-25 (fund -> app/library/law, craft -> app/library/craft,
 *  markets -> app/library/markets). Until the root lets it go, a folder of it is a shelf only
 *  when no current home holds a shelf of that id and it is not one of the RETIRED names. */
export const LEGACY_LIBRARY_REL = 'library'
export const LEGACY_LIBRARY_RETIRED: readonly string[] = ['fund', 'craft']
/** the owner's vet list */
export const VET_FILE_REL = `${APP_LIBRARY_REL}/shelf.md`

/** a fund-absolute path as the fund-relative, forward-slash label the UI and messages show */
export function fundRel(abs: string): string {
  return relative(FUND_ROOT, abs).split(sep).join('/')
}

mkdirSync(LOG_DIR, { recursive: true })
mkdirSync(FLOOR_DIR, { recursive: true })

/** resolve a fund-relative path and refuse anything that escapes the fund root */
export function inFund(rel: string): string | null {
  const abs = resolve(FUND_ROOT, rel)
  return within(abs, FUND_ROOT) ? abs : null
}

/** is `abs` the root itself or inside it? Case-insensitive only on Windows. */
export function within(abs: string, root: string): boolean {
  const norm = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p)
  const a = norm(resolve(abs))
  const r = norm(resolve(root))
  return a === r || a.startsWith(r.endsWith(sep) ? r : r + sep)
}

// ---- lab desk <-> library base ----
// A desk's machine files live at lab/<desk>; the books it wrote live in a library folder. The
// 2026-09-25 re-shelve (B-0073) and the move of the platform's own shelves into its repo ended the
// old identity mirror (lab/<desk> <-> library/<desk>), so this is a TABLE: each desk's library
// candidates, the current home first and every earlier home after it still on disk or in a live
// record (the one-day platform/library home, 2026-09-25..26, is not one: B-0202). libraryOf() answers the first
// that exists (the current home when none does); deskOfLibraryBook() recognises every one of them, so a
// book's git history under an old path still finds its desk. `$1` = the desk's own last segment. A home
// ending in .md is ONE book (the 2026-10-03 fold into 15 books, B-0344): every desk of its family shares
// it (platform/$1 -> platform.md). execution files no books (its own CLAUDE.md is its runbook).
export const DESK_LIBRARY: [string, string[]][] = [
  ['platform/carry', ['app/library/platform/engines.md', 'app/library/platform/carry', 'library/platform/carry']],   // the carry and directional engines: their own book, ahead of the family's
  ['platform/$1', ['app/library/platform/platform.md', 'app/library/platform/$1', 'library/platform/$1']],
  ['dashboards/app', ['app/library/platform/dashboards.md', 'app/library/craft/dashboards', 'library/craft/dashboards', 'library/dashboards/app']],
  ['dashboards/$1', ['platform/dashboards/$1/CLAUDE.md', 'app/library/dashboards/$1', 'platform/dashboards/$1/library', 'library/dashboards/$1']],
  ['research', ['app/library/research/research.md', 'app/library/craft/research', 'library/craft/research', 'library/research']],
  ['predmkts', ['app/library/research/predmkts.md', 'app/library/markets/predmkts', 'library/markets/predmkts']],
]
/** a DESK_LIBRARY template as a regex: `$1` is one path segment, captured */
const tmplRe = (t: string, tail: string) => new RegExp('^' + t.replace(/[.*+?^{}()|[\]\\]/g, '\\$&').replace('$1', '([^/]+)') + tail)

// Desk ids before the rename, when lab/ still mirrored the CODE paths (lab/api/data/<path>) and,
// before the cut-over, lived at desks/. Old rows, old conversations and old docs carry them; each is
// READ as its new name, never rewritten. Longest prefix first. The Python half is app/tools/_root.py
// LEGACY_DESK; test/layout-parity.test.ts fails when the two differ.
export const LEGACY_DESK: [string, string][] = [
  ['api/data/venues/', 'venues/'],
  ['api/data/store', 'platform/store'],
  ['api/data', 'platform/data'],
  ['api/lib/carry', 'platform/carry'],
  ['api/lib/dir', 'platform/dir'],
  ['api/lib', 'platform/lib'],
  ['api/execution', 'execution'],
  ['app/frontend', 'dashboards/frontend'],
  ['app/server', 'dashboards/server'],
  ['app', 'dashboards/app'],
]

// Code-repo cwds before today's layout (old -> new; the first entry that matches wins, so a longer
// old path sits above any shorter one it starts with): a conversation or a run begun in
// crypto/ (before 2026-09-24), under repos/ (2026-09-24..25), in the research repo at the root or in a
// dashboard under platform/fundplat/dashboards/ (before the 2026-09-25 relayout) is FOUND under its
// new home. A TRANSLATION of historical records, never a place to look: Claude keys a transcript by
// the cwd it ran in, so a conversation begun in an old cwd (4 in the ops store under
// platform/fundplat/dashboards, counted 2026-09-25) is only reachable through it. Dashboards are
// looked for under DASHBOARD_HOMES alone. The Python half is app/tools/_root.py LEGACY_CWD.
export const LEGACY_CWD: [string, string][] = [
  ['platform/fundplat/dashboards', 'platform/dashboards'],
  ['crypto/research', 'platform/research'],
  ['crypto', 'platform'],
  ['repos/research', 'platform/research'],
  ['repos/platform', 'platform'],
  ['repos/app', 'app'],
  ['research', 'platform/research'],
]

// Agents retired by the 2026-09-25 relayout (old id -> the agent that took its work): the four
// terminal views became ONE dashboard with one agent. A conversation, a usage row or a board item
// naming an old id is READ as its successor (server/config.ts agent()), never rewritten.
export const RETIRED_AGENTS: [string, string][] = [
  ['dash:trade', 'dash:terminal'],
  ['dash:sellvol', 'dash:terminal'],
  ['dash:datactl', 'dash:terminal'],
]
/** an agent id as the agent that answers for it now */
export const currentAgentId = (id: string) => RETIRED_AGENTS.find(([old]) => old === id)?.[1] ?? id

/** any desk id - `lab/platform/data`, its folder `platform/lab/platform/data`, `lab/api/data`, `desks/api/data`,
 *  `api/data` - as its current LOGICAL id (`lab/platform/data`; deskRel() finds its folder) */
export function canonicalDesk(desk: string): string {
  let s = desk.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
  // a desk's FOLDER (platform/lab/..., since 2026-09-25) reads as its id too
  const home = ['desks', ...LAB_HOMES].find(h => s.startsWith(`${h}/`))
  if (home) s = s.slice(home.length + 1)
  for (const [old, now] of LEGACY_DESK) {
    if (old.endsWith('/') ? s.startsWith(old) : (s === old || s.startsWith(old + '/'))) { s = now + s.slice(old.length); break }
  }
  return `lab/${s}`
}

/** the pre-rename fragment a current desk replaced (`platform/data` -> `api/data`), or null */
export function legacyDeskFragment(frag: string): string | null {
  const s = frag.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
  for (const [old, now] of LEGACY_DESK) {
    if (now.endsWith('/') ? s.startsWith(now) : (s === now || s.startsWith(now + '/'))) return old + s.slice(now.length)
  }
  return null
}

/** every library folder a lab desk's books have lived in, current home first; [] = not a book desk */
export function libraryCandidates(desk: string): string[] {
  const d = canonicalDesk(desk).slice(4)
  for (const [t, homes] of DESK_LIBRARY) {
    const m = tmplRe(t, '$').exec(d)
    if (m) return homes.map(h => h.replace('$1', m[1] ?? ''))
  }
  return []
}

/** the library folder holding a lab desk's books ("lab/research" -> "app/library/research/research.md"):
 *  the first candidate that exists, else the current home; null = the desk files no books */
export function libraryOf(desk: string, has: (rel: string) => boolean = rel => existsSync(join(FUND_ROOT, rel))): string | null {
  const c = libraryCandidates(desk)
  return c.find(has) ?? c[0] ?? null
}

/** the lab desk a library book belongs to (the deepest home that holds it, any era), or '.' (the fund) */
export function deskOfLibraryBook(rel: string): string {
  const p = rel.replace(/\\/g, '/')
  let best: { len: number; desk: string } | null = null
  for (const [t, homes] of DESK_LIBRARY) {
    for (const h of homes) {
      // a home that is one book (platform.md, a screen's CLAUDE.md) matches exactly; a folder, by prefix
      const m = tmplRe(h, h.endsWith('.md') ? '$' : '/').exec(p)
      if (m && (!best || m[0].length > best.len)) best = { len: m[0].length, desk: t.replace('$1', m[1] ?? '').replace(/\/$/, '') }
    }
  }
  return best ? `lab/${best.desk}` : '.'
}

// ---- a desk's folder: the id is LOGICAL (`lab/<name>`), the folder follows the layout ----
// A desk id has read `lab/<name>` since the 2026-09-24 cut-over, in every database row, run ledger,
// conversation and board item; the 2026-09-25 relayout moved the folders to platform/lab/<name>.
// The id stays (canonicalDesk above), and these two resolve it to wherever the lab is on disk.

/** the fund-relative folder of a desk id ("lab/example" -> "platform/lab/example") */
export function deskRel(desk: string, fundRoot: string = FUND_ROOT): string {
  return `${labRel(fundRoot)}/${canonicalDesk(desk).slice(4)}`
}
/** the absolute folder of a desk id */
export function deskDir(desk: string, fundRoot: string = FUND_ROOT): string {
  return join(fundRoot, deskRel(desk, fundRoot))
}
/** a fund-relative path under any lab home ("platform/lab/example/beliefs.md") as the same path
 *  under the logical `lab/` ("lab/example/beliefs.md"); anything else comes back unchanged */
export function logicalLabPath(rel: string): string {
  const p = rel.replace(/\\/g, '/')
  for (const h of LAB_HOMES) if (p === h || p.startsWith(`${h}/`)) return `lab${p.slice(h.length)}`
  return p
}

// ---- the roster ----
// Every agent is ONE file, app/agents/<id>.md (':' -> '-', so dash:vol is dash-vol.md): a YAML header
// (id, cwd, writes, boot, model, effort, ...) and the brief under it (who it is, what it owns, how it
// works, what it never does). server/roster.ts reads and writes it; shared/agentfile.ts is the format.

/** the fund-relative path of an agent's file (its header and its brief) */
export function briefOf(a: { id: string; brief?: string }): string {
  if (a.brief) return a.brief.split(sep).join('/').replace(/^[.][/]/, '')
  return `${AGENTS_REL}/${agentFileName(a.id)}`
}
