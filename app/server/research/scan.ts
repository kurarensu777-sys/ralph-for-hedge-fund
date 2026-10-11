import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { FORMAT_IDS, MARKET_IDS, STUDY_MIME, STYLES, isFormat, isMarket, isPace, isStyle, manifestProblems, type Labels, type LabelsFile, type LabelSource, type LoopLink, type Manifest, type ManifestState, type MarketId, type Study, type StudiesPayload } from '../../shared/research.ts'
import type { Run } from '../lab/runs.ts'

/**
 * The Research room's reading of platform/research: every notebook under its folders (studies/), each read as the JSON file it is (a notebook is source, not stored data; the
 * cockpit never runs one; a file starting _ is a template, not a study). Per notebook: its cell counts, its kernel, its MANIFEST (the one
 * STUDY_MIME output, the fund.study/1 manifest, shared/research.ts) and the loop runs whose command
 * names it. Pure apart from the file reads; the room wires git and the watcher.
 */

export const RESEARCH_REL = 'platform/research'

type Nb = { cells?: any[]; metadata?: { kernelspec?: { name?: string } } }

/** the manifest a notebook carries: exactly one output under STUDY_MIME (the book: one per notebook) */
export function manifestOf(nb: Nb): ManifestState {
  const found: { cell: number; data: unknown }[] = []
  ;(nb.cells ?? []).forEach((c, i) => {
    for (const o of c?.outputs ?? []) if (o?.data && STUDY_MIME in o.data) found.push({ cell: i, data: o.data[STUDY_MIME] })
  })
  if (!found.length) return { state: 'none' }
  if (found.length > 1) return { state: 'many', cells: found.map(f => f.cell) }
  const [f] = found
  // nbformat keeps a JSON output as an object; a writer that stringified it is read the same
  let data = f.data
  if (typeof data === 'string') { try { data = JSON.parse(data) } catch { return { state: 'invalid', cell: f.cell, problems: ['the manifest is a string that is not JSON'] } } }
  const problems = manifestProblems(data)
  return problems.length ? { state: 'invalid', cell: f.cell, problems } : { state: 'ok', manifest: data as Manifest, cell: f.cell }
}

export function cellCounts(nb: Nb): Study['cells'] {
  const cells = nb.cells ?? []
  let markdown = 0, code = 0, executed = 0, images = 0
  for (const c of cells) {
    if (c?.cell_type === 'markdown') markdown++
    if (c?.cell_type === 'code') { code++; if (c.execution_count) executed++ }
    for (const o of c?.outputs ?? []) if (o?.data && ('image/png' in o.data || 'image/jpeg' in o.data || 'image/svg+xml' in o.data)) images++
  }
  return { markdown, code, executed, images }
}

/** "[latest] 2026-09-x.ipynb" -> { name: "2026-09-x", tag: "latest" } */
export function nameOf(file: string): { name: string; tag: string | null } {
  const stem = file.replace(/\.ipynb$/i, '')
  const m = /^\[([^\]]+)\]\s*(.*)$/.exec(stem)
  return m ? { name: m[2], tag: m[1] } : { name: stem, tag: null }
}

/** the notebook file a loop command ran: nbconvert's last `.ipynb` argument, basename only */
export function notebookOfCmd(cmd: unknown): string | null {
  const s = Array.isArray(cmd) ? cmd.join(' ') : typeof cmd === 'string' ? cmd : ''
  const m = /((?:\[[^\]]+\]\s)?[\w.\-]+\.ipynb)(?!.*\.ipynb)/.exec(s)
  return m ? m[1].split(/[\\/]/).pop()! : null
}

export function loopLink(r: Run): LoopLink {
  const res = r.rows.filter(x => x.stage === 'result').at(-1)
  const graded: LoopLink['graded'] = {}
  for (const [k, g] of Object.entries(res?.graded ?? {})) {
    const v = g as any
    if (v && typeof v.actual === 'number') graded[k] = { actual: v.actual, band: String(v.band ?? ''), verdict: String(v.verdict ?? '') }
  }
  const main = res ?? r.rows.at(-1)
  return {
    key: r.key, desk: r.desk, run: r.run, kind: r.kind, stage: r.stage,
    ts: r.ts === null ? null : new Date(r.ts).toISOString(),
    headline: r.headline, window: r.window, verify: r.verify, graded,
    comparator: main?.comparator && typeof main.comparator === 'object' ? main.comparator : null,
  }
}

/** old notebook file -> the notebook it was renamed to, from the desks' renames.json documents ({renames:[{old,new}]}).
 *  A rename of a rename is followed to its end; a cycle stops where it began. Ledger rows are never rewritten
 *  (the-naming rename checklist, step 4), so a run whose command names an old stem is joined to the new notebook here. */
export function renameMap(docs: unknown[]): Map<string, string> {
  const direct = new Map<string, string>()
  for (const d of docs) {
    const list = (d as { renames?: unknown } | null)?.renames
    if (!Array.isArray(list)) continue
    for (const x of list as { old?: unknown; new?: unknown }[]) {
      if (typeof x?.old === 'string' && typeof x?.new === 'string' && x.old !== x.new) direct.set(x.old, x.new)
    }
  }
  const out = new Map<string, string>()
  for (const old of direct.keys()) {
    let cur = direct.get(old)!
    const seen = new Set([old])
    while (direct.has(cur) && !seen.has(cur)) { seen.add(cur); cur = direct.get(cur)! }
    out.set(old, cur)
  }
  return out
}

/** every loop run, keyed by the notebook file its command ran (an old stem mapped to the notebook it became) */
export function runsByNotebook(runs: Run[], renames: Map<string, string> = new Map()): Map<string, LoopLink[]> {
  const out = new Map<string, LoopLink[]>()
  for (const r of runs) {
    const ran = notebookOfCmd(r.rows.find(x => x.cmd)?.cmd)
    const nb = ran ? (renames.get(ran) ?? ran) : null
    if (!nb) continue
    if (!out.has(nb)) out.set(nb, [])
    out.get(nb)!.push(loopLink(r))
  }
  for (const l of out.values()) l.sort((a, b) => (b.ts ?? '').localeCompare(a.ts ?? ''))
  return out
}

/** the notebook files under the research root: one level of folders (studies/) */
export function listNotebooks(root: string): string[] {
  if (!existsSync(root)) return []
  const out: string[] = []
  for (const d of readdirSync(root, { withFileTypes: true })) {
    if (!d.isDirectory() || d.name.startsWith('.') || d.name === '__pycache__') continue
    for (const f of readdirSync(join(root, d.name), { withFileTypes: true })) {
      if (f.isFile() && /\.ipynb$/i.test(f.name) && !f.name.startsWith('_')) out.push(`${d.name}/${f.name}`)
    }
  }
  return out.sort()
}

/** a notebook id from a request, refused unless it names a notebook inside the root */
export function resolveId(root: string, id: string): string {
  if (!/\.ipynb$/i.test(id) || id.includes('\0')) throw new Error('not a notebook id')
  const abs = resolve(root, id)
  const rel = relative(root, abs)
  if (!rel || rel.startsWith('..') || rel.includes(`..${sep}`)) throw new Error('outside the research folder')
  return abs
}

type Bare = Omit<Study, 'loop' | 'commit' | 'labels'>
type Cached = { mtime: number; bytes: number; study: Bare }
const CACHE = new Map<string, Cached>()

/** one notebook, parsed once per (mtime, size) */
export function readStudy(root: string, id: string): Bare {
  const abs = join(root, id)
  const st = statSync(abs)
  const hit = CACHE.get(abs)
  if (hit && hit.mtime === st.mtimeMs && hit.bytes === st.size) return hit.study
  const [group, file] = id.split('/')
  const { name, tag } = nameOf(file)
  let study: Bare
  try {
    const nb = JSON.parse(readFileSync(abs, 'utf8')) as Nb
    study = { id, name, tag, group, bytes: st.size, mtime: st.mtimeMs, cells: cellCounts(nb), kernel: nb.metadata?.kernelspec?.name ?? null, error: null, manifest: manifestOf(nb) }
  } catch (e) {
    study = { id, name, tag, group, bytes: st.size, mtime: st.mtimeMs, cells: { markdown: 0, code: 0, executed: 0, images: 0 }, kernel: null, error: `does not parse: ${(e as Error).message}`, manifest: { state: 'none' } }
  }
  CACHE.set(abs, { mtime: st.mtimeMs, bytes: st.size, study })
  return study
}

/** the naming book's migration table (| `old.ipynb` | `new.ipynb` |) -> old file -> the market word of
 *  its new name: how a legacy notebook, named before the pattern, is listed under its market */
export function namingMarkets(book: string): Map<string, MarketId> {
  const out = new Map<string, MarketId>()
  for (const m of book.matchAll(/^\|\s*`([^`]+\.ipynb)`\s*\|\s*`([^`]+\.ipynb)`\s*\|/gm)) {
    const w = nameMarket(m[2])
    if (w) out.set(m[1], w)
  }
  return out
}

/** the market word of a name on the naming pattern (<YYYY-MM-DD>-<market>-<subject>; the legacy
 *  <YYYY-MM>-<market>-... reads the same), or null. Only a live market maps: `xasset` and `vol` stay
 *  in file names (the naming law) and are retired as labels (B-0284) */
export function nameMarket(file: string): MarketId | null {
  const w = /^(?:\[[^\]]+\]\s*)?\d{4}-\d{2}(?:-\d{2})?-([a-z]+)-/.exec(file)?.[1]
  return isMarket(w) ? w : null
}

/** labels.json as text -> its rows, or why it cannot be read; a row that is not an object is a problem */
export function parseLabels(text: string): { file: LabelsFile; problems: string[] } {
  let j: unknown
  try { j = JSON.parse(text) } catch (e) { return { file: {}, problems: [`labels.json does not parse: ${(e as Error).message}`] } }
  if (!j || typeof j !== 'object' || Array.isArray(j)) return { file: {}, problems: ['labels.json is not an object of notebook path -> { markets, format, style }'] }
  const file: LabelsFile = {}, problems: string[] = []
  for (const [k, v] of Object.entries(j as Record<string, unknown>)) {
    if (k.startsWith('_') || k.startsWith('$')) continue          // a comment key
    if (!v || typeof v !== 'object' || Array.isArray(v)) problems.push(`labels.json ${k}: not { markets, format, style }`)
    else file[k] = v as LabelsFile[string]
  }
  return { file, problems }
}

/** THE LABELS (B-0284, B-0502). Markets: the manifest's profile.markets, else labels.json, else the old
 *  single profile.market, the file name's word or the naming book's row when it is one of the four,
 *  else none; the first is the main market. Format: the manifest's, else labels.json. Style: the manifest's
 *  tags.style, else labels.json's (a study not yet re-run). Pace: the manifest's tags.pace and nothing else:
 *  the room reads it and never computes it. A value off the closed list is a fault (shown on the row and
 *  the card); it never labels, and never vanishes. A notebook outside studies/ has none */
export function labelsOf(s: Pick<Study, 'id' | 'group' | 'manifest'>, file: LabelsFile, book: Map<string, MarketId>): Labels {
  const out: Labels = { markets: [], format: null, style: null, pace: null, from: { markets: null, format: null, style: null }, faults: [] }
  if (s.group !== 'studies') return out
  const m = s.manifest.state === 'ok' ? s.manifest.manifest : null
  const row = file[s.id]
  const markets = (v: unknown, where: string): MarketId[] => {
    if (v === undefined || v === null) return []
    if (!Array.isArray(v)) { out.faults.push(`${where} is ${JSON.stringify(v)}, not a list of markets`); return [] }
    const ok: MarketId[] = []
    for (const x of v) {
      if (isMarket(x)) { if (!ok.includes(x)) ok.push(x) }
      else out.faults.push(`${where}: ${JSON.stringify(x)} is not a market (${MARKET_IDS.join('|')})`)
    }
    return ok
  }
  const set = (ids: MarketId[], from: LabelSource) => { if (!out.markets.length && ids.length) { out.markets = ids; out.from.markets = from } }
  set(markets(m?.profile?.markets, 'profile.markets'), 'manifest')
  set(markets(row?.markets, 'labels.json markets'), 'labels.json')
  const old = m?.profile?.market ?? m?.strategy?.market
  if (isMarket(old)) set([old], 'profile.market')
  const name = s.id.split('/').pop()!
  const n = nameMarket(name)
  if (n) set([n], 'name')
  const b = book.get(name)
  if (b) set([b], 'naming book')
  if (m && isFormat(m.format)) { out.format = m.format; out.from.format = 'manifest' }
  else if (row?.format !== undefined) {
    if (isFormat(row.format)) { out.format = row.format; out.from.format = 'labels.json' }
    else out.faults.push(`labels.json format: ${JSON.stringify(row.format)} is not a format (${FORMAT_IDS.join('|')})`)
  }
  if (isStyle(m?.tags?.style)) { out.style = m!.tags!.style!; out.from.style = 'manifest' }
  else if (row?.style !== undefined) {
    if (isStyle(row.style)) { out.style = row.style; out.from.style = 'labels.json' }
    else out.faults.push(`labels.json style: ${JSON.stringify(row.style)} is not a style (${STYLES.join('|')})`)
  }
  if (isPace(m?.tags?.pace)) out.pace = m!.tags!.pace!
  return out
}

/** `git log --format=%x01%h %cs --name-only` over the research folder -> file (repo-relative) -> its newest commit */
export function lastCommits(log: string): Map<string, { hash: string; date: string }> {
  const out = new Map<string, { hash: string; date: string }>()
  for (const block of log.split('\x01')) {
    const [head, ...files] = block.split('\n').map(s => s.trim()).filter(Boolean)
    if (!head) continue
    const [hash, date] = head.split(' ')
    for (const f of files) if (!out.has(f)) out.set(f, { hash, date })
  }
  return out
}

export function studies(root: string, runs: Run[], commits: Map<string, { hash: string; date: string }> | null, repoPrefix: string,
  opts: { naming?: Map<string, MarketId>; jupyter?: string | null; labels?: { text: string } | { error: string } | null; renames?: Map<string, string> } = {}): StudiesPayload {
  const byNb = runsByNotebook(runs, opts.renames)
  const exists = existsSync(root)
  const lf = !opts.labels ? null : 'error' in opts.labels ? { file: {}, problems: [`labels.json cannot be read: ${opts.labels.error}`] } : parseLabels(opts.labels.text)
  const ids = listNotebooks(root)
  const list: Study[] = ids.map(id => {
    const s = readStudy(root, id)
    const file = id.split('/').pop()!
    return { ...s, loop: byNb.get(file) ?? [], commit: commits?.get(`${repoPrefix}${id}`) ?? null, labels: labelsOf(s, lf?.file ?? {}, opts.naming ?? new Map()) }
  })
  const problems = lf ? [...lf.problems, ...Object.keys(lf.file).filter(k => !ids.includes(k)).map(k => `labels.json names ${k}, which is not a notebook here`)] : []
  const labels: StudiesPayload['labels'] = { state: !lf ? 'absent' : lf.problems.length ? 'failed' : 'ok', problems }
  return { root: RESEARCH_REL, exists, studies: list, at: Date.now(), jupyter: opts.jupyter ?? null, labels }
}

/** a notebook for the reader, as its file holds it (text), refused outside the root */
export function notebookText(root: string, id: string): string {
  return readFileSync(resolveId(root, id), 'utf8')
}
