// Types shared by fundd (server/) and the UI (src/). The fund's configuration files are the source
// of truth and these types describe them: the roster app/agents/<id>.md (shared/agentfile.ts),
// repos.json at the fund root, one platform/dashboards/<id>/dashboard.json per dashboard; shelves
// are derived from the library folders (server/shelves.ts).

import type { Topic } from './bookmeta.ts'

export type Status = 'ok' | 'warn' | 'fail' | 'unknown' | 'off'

export type Agent = {
  id: string                     // "fund", "platform", "dash:terminal"
  name: string
  kind: 'standing' | 'dashboard'
  mode: 'active' | 'dormant'
  dept: string                   // department the agent belongs to (a label, not a person)
  role: string                   // one line: what you talk to it for
  cwd: string                    // fund-relative working folder
  writes: string[]               // fund-relative path prefixes it may commit to
  reads?: string[]               // extra fund-relative folders it may read
  model: string                  // an EXACT id from shared/models.ts (claude-opus-5-5, ...)
  effort: string                 // low | medium | high
  boot: string[]                 // books (fund-relative .md paths) loaded at EVERY boot
  brief?: string                 // fund-relative .md holding the brief (default: its own roster file, app/agents/<id>.md)
  dashboard?: string             // for kind=dashboard: the dashboard id it owns
  order?: number                 // roster order (the file's `order:`; unordered agents after, by id)
}

export type Shelf = {
  id: string
  title: string
  dept: string
  roots: string[]                // fund-relative folders; every .md under them is a book (derived: app/library/<id>, the one library)
  topics?: Topic[]               // the shelf's closed topic list, from its top _series.md (shared/bookmeta.ts); absent = the shelf names none
}

export type Book = {
  path: string                   // fund-relative, the book's id
  shelf: string
  series: string                 // folder name
  title: string
  readWhen: string               // the moment it fires, from the series index ("" if none)
  topics: string[]               // its frontmatter `topics:` as written (shared/bookmeta.ts); [] = none
  type: string | null            // its frontmatter `type:` (guide | strategy); null = none
  parent: string | null          // its frontmatter `parent:` (a strategy book's family); null = none
  chapters: BookChapter[]        // its `## ` chapters, in order (shared/bookmeta.ts chaptersOf); [] = a book of one piece
  tokens: number                 // estimate: chars / 4
  updated: number                // mtime ms
}

/** one `## ` chapter of a book, addressed as `<book path>#<slug>`; tokens = its slice alone */
export type BookChapter = { slug: string; title: string; readWhen: string; tokens: number }

export type HealthCheck =
  | { id: string; check: 'port'; port: number }
  | { id: string; check: 'http'; url: string }
  | { id: string; check: 'file_age'; path: string; max_h: number }
  | { id: string; check: 'exists'; path: string }

export type Dashboard = {
  id: string                     // "trade"
  name: string
  market: string                 // crypto | tradfi | predmkts | all
  agent: string                  // "dash:trade"
  open: string                   // url to open in the browser
  kind?: 'dashboard' | 'tool'
  start?: { cmd: string; cwd: string; port: number; shared?: string }   // shared = a server several dashboards ride
  start_dev?: { cmd: string; cwd: string; port: number }
  health: HealthCheck[]
  every?: string                 // "15m"
  on_fail?: 'wake_agent' | 'notify'
  order?: number                 // display order in the cockpit (unique across dashboard.json files)
  summary?: DashSummaryDecl      // dashboards only: where its LIVE SUMMARY CARD is read (registry.py)
}

/** a dashboard.json `summary`: the url it serves its card on (http://127.0.0.1:<its own start.port>/...)
 *  and how often the cockpit reads it ("30s", "1m", "5m": digits + s|m|h) */
export type DashSummaryDecl = { url: string; every: string }

/** THE /api/summary CONTRACT (platform/dashboards/registry.py validate_summary; mirrored in
 *  server/proc/summary.ts): exactly three headline entries, a label of 1..24 characters, a value that
 *  is a string or a number (never a bool, null or NaN), the numbers law's tag, the as-of in ms */
export type SummaryTag = '[V]' | '[1]' | '[U]' | '[API]'
export type SummaryEntry = { label: string; value: string | number; tag?: SummaryTag; hint?: string }
export type SummaryBody = { as_of_ms: number; health: 'ok' | 'warn' | 'fail'; headline: SummaryEntry[] }

/**
 * What the Dash room shows for one dashboard's card. `none` = it declares no summary (the card says
 * "no summary published"); `stopped` = its port was measured closed (known, not unknown; nothing is
 * polled); `unknown` = declared but not readable now (unreachable, not read yet, or a body that
 * breaks the contract - `reason` names which); `ok` = the last poll answered a valid body.
 * `last` is the newest VALID body ever read and when, kept so a card can show what it last said,
 * marked as last seen - never presented as current.
 */
export type DashSummaryView = {
  state: 'ok' | 'stopped' | 'unknown' | 'none'
  reason?: string
  url?: string
  every?: string
  readAt: number | null          // when the cockpit last polled it (ms), null = never
  body?: SummaryBody             // present only when state is ok
  last?: { body: SummaryBody; readAt: number }
}


export type Repo = {
  id: string                     // fund | app | platform | research | execution
  path: string                   // fund-relative ("." for the control repo)
  holds: string
  verify?: string                // command run from path
  guarded?: boolean
}

export type BoardItem = {
  id: string                     // "B-0007"
  title: string
  status: 'needs-you' | 'backlog' | 'ready' | 'doing' | 'review' | 'done'
  kind: 'todo' | 'instruction' | 'build' | 'question' | 'bug'
  owner: string                  // agent id, "you", or "" (unassigned)
  from: string                   // who filed it: agent id or "you"
  priority: 'p0' | 'p1' | 'p2'
  labels: string[]
  created: string                // ISO date
  updated: string                // ISO date
  body: string                   // markdown: the thinking, then notes newest last
}

/** reading = the short text beside the dot; hint = the tooltip (defaults to reading) */
export type ServiceRow = { id: string; label: string; status: Status | 'run' | 'ask'; reading?: string; hint?: string; room?: string; target?: string; kind?: string }   // kind: what a row is when a group counts more than one sort (dashboard | tool)
export type ServiceGroup = { id: string; label: string; rows: ServiceRow[]; tally?: string }   // tally: the group's own count, shown folded and reused wherever else it is quoted
