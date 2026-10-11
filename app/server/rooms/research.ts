import { readFileSync, statSync, watch, type FSWatcher } from 'node:fs'
import { join, resolve } from 'node:path'
import type { Router } from '../http.ts'
import { HttpError } from '../http.ts'
import type { ServiceGroup } from '../../shared/types.ts'
import { publish } from '../events.ts'
import { APP_LIBRARY_REL, FUND_ROOT, PLATFORM_ROOT } from '../paths.ts'
import { config } from '../config.ts'
import type { MarketId } from '../../shared/research.ts'
import { git } from '../git/run.ts'
import { loadAll } from '../lab/runs.ts'
import { lastCommits, namingMarkets, notebookText, renameMap, studies } from '../research/scan.ts'
import { chartBooks, charts, figurePng } from '../research/charts.ts'
import { questionsFor } from '../research/questions.ts'
import type { Run } from '../lab/runs.ts'

// ROOM: research - every notebook in platform/research: its two labels (market, format), its study MANIFEST (fund.study/1, the
// research craft book the-study-manifest.md; builder B-0240), the loop runs that ran it, and the
// notebook itself for the reader. Read-only: the cockpit never executes a notebook.

// FUND_RESEARCH_DIR points a test instance at another folder (a fixture), as FUND_BOARD_DIR does
const ROOT = process.env.FUND_RESEARCH_DIR ? resolve(process.env.FUND_RESEARCH_DIR) : join(PLATFORM_ROOT, 'research')
const REPO_PREFIX = 'research/'   // paths in the platform repo's git log

let commits: { at: number; map: Map<string, { hash: string; date: string }> | null } = { at: 0, map: null }
async function commitMap() {
  if (commits.map && Date.now() - commits.at < 60_000) return commits.map
  const out = await git(PLATFORM_ROOT, ['log', '--format=%x01%h %cs', '--name-only', '--', 'research'], 20_000).catch(() => null)
  commits = { at: Date.now(), map: out && out.code === 0 ? lastCommits(out.stdout) : null }
  return commits.map
}

// a migration table in the research book lists a legacy notebook under its market (research's book; re-read when it
// moves). The 2026-10 book has none: every notebook on disk carries the pattern, so the map is empty and the name speaks
const CHARTS = join(FUND_ROOT, APP_LIBRARY_REL, 'research')
const NAMING = join(FUND_ROOT, APP_LIBRARY_REL, 'research', 'research.md')
let naming: { mtime: number; map: Map<string, MarketId> } = { mtime: -1, map: new Map() }
function namingMap() {
  try {
    const m = statSync(NAMING).mtimeMs
    if (m !== naming.mtime) naming = { mtime: m, map: namingMarkets(readFileSync(NAMING, 'utf8')) }
  } catch { naming = { mtime: -1, map: new Map() } }
  return naming.map
}

// the two labels' table for the notebooks whose manifest does not name them yet (B-0284; research's
// file). Absent is a true reading (the manifests and names label alone); unreadable is a failure
const LABELS = join(ROOT, 'labels.json')
function labelsText(): { text: string } | { error: string } | null {
  try { return { text: readFileSync(LABELS, 'utf8') } }
  catch (e) { return (e as NodeJS.ErrnoException).code === 'ENOENT' ? null : { error: (e as Error).message } }
}

/** each desk's renames.json (a desk may carry one beside its ledger): old notebook -> new, so a run whose recorded command names an
 *  old stem still joins its notebook. A missing or unreadable file is no rename, never an error. */
function renamesOf(runs: Run[]): Map<string, string> {
  const docs: unknown[] = []
  for (const desk of new Set(runs.map(x => x.desk))) {
    try { docs.push(JSON.parse(readFileSync(join(FUND_ROOT, desk, 'renames.json'), 'utf8'))) } catch { /* none, or not JSON */ }
  }
  return renameMap(docs)
}

/** where JupyterLab opens: its dashboard.json's own url, never spelled here */
const jupyterUrl = () => config.dashboards().find(d => d.id === 'jupyter')?.open ?? null

let watcher: FSWatcher | null = null
let pub: ReturnType<typeof setTimeout> | null = null
function startWatch() {
  if (watcher) return
  try {
    watcher = watch(ROOT, { recursive: true }, (_e, name) => {
      if (name && !/\.ipynb$|(^|[\\/])labels\.json$/i.test(String(name))) return
      commits.at = 0
      if (pub) clearTimeout(pub)
      pub = setTimeout(() => { pub = null; publish('research') }, 800)
    })
    watcher.on('error', () => { watcher?.close(); watcher = null })
  } catch { watcher = null }
}

export function register(r: Router) {
  startWatch()
  r.get('/api/research/studies', async () => {
    const runs = loadAll(FUND_ROOT).flatMap(d => d.runs)
    return studies(ROOT, runs, await commitMap(), REPO_PREFIX, { naming: namingMap(), jupyter: jupyterUrl(), labels: labelsText(), renames: renamesOf(runs) })
  })
  r.get('/api/research/notebook', ({ query }) => {
    const id = query.get('id')
    if (!id) throw new HttpError(400, 'need ?id=')
    try { return { id, nb: JSON.parse(notebookText(ROOT, id)) } }
    catch (e) { throw new HttpError((e as NodeJS.ErrnoException).code === 'ENOENT' ? 404 : 400, (e as Error).message) }
  })
  // the Questions block (B-0524): each section's question, figure ids and tables, read from the notebook; null for a notebook without the nine sections
  r.get('/api/research/questions', ({ query }) => {
    const id = query.get('id')
    if (!id) throw new HttpError(400, 'need ?id=')
    try { return { id, ...questionsFor(ROOT, id) } }
    catch (e) { throw new HttpError((e as NodeJS.ErrnoException).code === 'ENOENT' ? 404 : 400, (e as Error).message) }
  })
  // the chart bank (B-0505): one card per chart type of the books app/library/research/charts*.md, each parsed once per file mtime
  r.get('/api/research/charts', () => charts(ROOT, chartBooks(CHARTS)))
  // an exemplar's PNG, from the notebook's cell tagged with the figure id; the URL carries the notebook's mtime, so it may be kept
  r.get('/api/research/chart-fig', ({ query, res }) => {
    const id = query.get('id'), fig = query.get('fig')
    if (!id || !fig) throw new HttpError(400, 'need ?id= and ?fig=')
    let png: Buffer | null
    try { png = figurePng(ROOT, id, fig) }
    catch (e) { throw new HttpError((e as NodeJS.ErrnoException).code === 'ENOENT' ? 404 : 400, (e as Error).message) }
    if (!png) throw new HttpError(404, `${id} has no PNG output tagged ${fig}`)
    res.writeHead(200, { 'content-type': 'image/png', 'content-length': png.length, 'cache-control': 'private, max-age=3600' })
    res.end(png)
  })
}

/** the research folder is not a service */
export async function services(): Promise<ServiceGroup | null> { return null }
