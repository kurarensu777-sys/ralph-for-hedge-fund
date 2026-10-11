// Library payload types. Type-only (no node imports), so the UI may import them too.
import type { Topic } from '../../shared/bookmeta.ts'
import type { Book, BookChapter } from '../../shared/types.ts'

/** pulls = Read-tool reads mid-work (the hook); boots = launch-contract loads. Kept apart, never summed */
export type BookUse = { n30: number; last: number | null; who: string[]; boots30: number; lastBoot: number | null }

/** a retired book: out of every boot list, the file untouched; n = the sessions graded when it was retired */
export type BookMark = { state: 'cold'; n: number; ts: number; note: string | null }

/** a `## Recall` table row that cites a book: the CLAUDE.md it is in, and the moment (its first cell);
 *  chapter = the slug when the row cites `<book>#<slug>` (B-0345), else the whole book */
export type RecallRow = { file: string; moment: string; chapter?: string }

/** a chapter and the agents that boot exactly it (`<book>#<slug>` in a boot list) */
export type LibChapter = BookChapter & { readers: string[] }

/** readers = the agents that boot with it; recall = the Recall rows that send an agent to it (server/library/need.ts) */
export type LibBook = Omit<Book, 'chapters'> & { chapters: LibChapter[]; readers: string[]; recall: RecallRow[]; use?: BookUse; mark?: BookMark }

/** since = the first pull ever recorded; null = no pull has ever arrived (the hook is not wired, or unused) */
export type ReadTracking = { since: number | null; pulls: number }

export type AgentPull = { path: string; n: number; last: number }

/** `path` is the BOOK and `book` its title; a hit inside a chapter of a book written as chapters also carries `chapter` (its slug and
 *  title), and `title` is then "Book > Chapter"; a book without chapters (a reference note) is one hit, no chapter */
export type SearchHit = { path: string; book: string; title: string; shelf: string; series: string; score: number; hits: number; snippet: string; marks: [number, number][]; chapter?: { slug: string; title: string } }
export type LibSearch = { q: string; terms: string[]; hits: SearchHit[]; total: number; indexed: number; ms: number }

export type SaveResult = { written: boolean; committed: boolean; hash: string; sha?: string; error?: string; note?: string }

/** the caps in tokens (app/tools/context-caps.json, server/library/caps.ts): a chapter above chapterTarget and a
 *  book above 90% of `book` are marked over-size; null = the file could not be read (no mark is drawn, none is invented) */
export type LibCaps = { chapter: number; chapterTarget: number; book: number; boot: number } | null

export type LibShelf = { id: string; title: string; dept: string; roots: string[]; count: number; tokens: number; topics?: Topic[] }

/** agents = every roster id, in roster order (what ALL means under a book); loads = agent id -> the
 *  CLAUDE.md files it loads at start (its cwd and every folder above); null = the CLAUDE.md list could
 *  not be read, so every book's recall is unknown, never "none" */
export type LibBooks = { caps: LibCaps; shelves: LibShelf[]; books: LibBook[]; scanned: number; tracking: ReadTracking | null; trackingError?: string; agents: string[]; loads: Record<string, string[]> | null; loadsError?: string }

export type HistoryRow = { sha: string; ts: number; who: string; subject: string }   // who = the Agent: trailer, else "you"

export type LibBookDetail = {
  book: LibBook
  content: string
  history: HistoryRow[] | null        // null = history could not be read (not a repo, git failed)
  historyError?: string
  repo: string                        // fund-relative path of the repo that holds it ("." = fund)
  hash: string                        // of `content`; the editor sends it back as `base`
  editable: boolean                   // only books in the fund repo are edited from here
  reads: { ts: number; agent: string; conversation: string | null }[] | null   // null = the reads table could not be read
}

export type LibAgent = {
  id: string
  name: string
  kind: 'standing' | 'dashboard'
  mode: 'active' | 'dormant'
  dept: string
  role: string
  cwd: string
  boot: { path: string; known: boolean; title: string; shelf: string; tokens: number }[]
  bootTokens: number                  // sum over known books only
  missing: number                     // boot entries that are not books on any shelf
  budget: number | null               // the boot cap (context-caps.json "boot"), the same for every agent; null = the caps file could not be read
  layers: AgentLayers | null          // null = the caps file could not be read
  brief: { path: string; text: string | null; tokens: number }  // app/agents/<id>.md; text null = missing
  pulled?: (AgentPull & { known: boolean; title: string; shelf: string })[]   // books read in 30 d beyond its boot list; undefined = unknown
}

/** one agent's load before its first word, in tokens; null = that layer could not be read, and total is null with it */
export type AgentLayers = {
  base: number | null
  workspace: number; workspaceFiles: { file: string; tokens: number }[]
  agent: number | null
  boot: number
  total: number | null
  caps: { base: number; agent: number; boot: number }
}

/** book = the book's path; chapter = the slug when the row cites `<book>.md#<slug>` and that heading exists */
export type VetRow = { title: string; tag: string; vet: string; paths: string[]; book: string | null; chapter: string | null }

// ---- drafted books from owner corrections (server/library/drafts.ts) ----
export type DraftLevel = 'agent' | 'role' | 'fund'
export type LibDraft = {
  id: number; conv: string; agent: string; shelf: string; level: DraftLevel; path: string; title: string
  book: string; seriesRow: string; quote: string; state: 'open' | 'saved' | 'dismissed'
  sha: string | null; error: string | null; ts: number; updated: number | null
}
export type LibDrafts = {
  drafts: LibDraft[]                  // open ones, newest first
  saved: number; dismissed: number
  lastScan: { ts: number; scanned: number; found: number; cost: number; note: string | null } | null   // null = the detector never ran
}

// ---- helpful / harmful per book, and the retire queue (server/library/outcomes.ts) ----
export type Outcome = 'helpful' | 'harmful' | 'neutral'
/** sessions (conversations) that PULLED the book, graded by what happened in them */
export type BookOutcome = { pulls: number; n: number; helpful: number; harmful: number; net: number | null }
export type RetireRow = BookOutcome & { path: string; title: string; shelf: string; reason: 'harm' | 'unread'; why: string }
export type LibOutcomes = {
  books: Record<string, BookOutcome>
  sessions: number; harmful: number; helpful: number
  base: number | null                 // harmful rate across every conversation; null = no conversations
  min: number                         // n below this is shown dashed and never queued
  queue: RetireRow[]
  cold: { path: string; title: string; n: number; ts: number; note: string | null }[]
  unreadNote: string | null           // why the unread half could not be claimed, when it could not
}

// ---- the link audit (server/library/links.ts) ----
/**
 * unlisted = a book with no row in its series' _series.md · dead-row = a _series row naming a missing file ·
 * dead-recall = a `.md` in a CLAUDE.md `## Recall` table that resolves to nothing · dead-boot = a boot entry
 * that is not a book · dead-anchor = a boot entry or Recall citation `<book>#<slug>` whose slug names no `## ` heading · dead-import = an `@path` line (a CLAUDE.md or any .md under a shelf) whose target does
 * not exist, resolved from the importing file's folder · unreached = a book nothing cites (no Recall row, boot list or other book, neither
 * the file nor its series) · no-index = a series folder with no _series.md · no-topic / bad-topic = a book on a
 * shelf that names topics carries none / one off the list (or too many) · bad-vocab = a shelf's list itself is unsound
 */
export type LinkFault = 'unlisted' | 'dead-row' | 'dead-recall' | 'dead-boot' | 'dead-anchor' | 'dead-import' | 'unreached' | 'no-index' | 'no-topic' | 'bad-topic' | 'bad-vocab'
export type LinkRow = {
  fault: LinkFault
  path: string            // fund-relative file (or folder, for no-index) the fault lives in
  target: string | null   // the missing thing a dead-* row names
  shelf: string | null
  book: string | null     // a book the Open button can open, when there is one
  agent?: string          // dead-boot: whose boot list
}
export type LibLinks = { rows: LinkRow[]; books: number; series: number; claude: number; scanned: number }
