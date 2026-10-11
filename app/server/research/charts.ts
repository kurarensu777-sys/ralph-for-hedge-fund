import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { CHART_CATEGORIES, chartCategoryOf, type ChartExemplar, type ChartType, type ChartsPayload } from '../../shared/research.ts'
import { listNotebooks, nameOf, readStudy, resolveId } from './scan.ts'

/**
 * The Research room's Charts view (B-0505): the chart bank, app/library/research/charts.md (the guide) and its
 * family books charts-<family>.md, read as one card per chart TYPE. A type is each `## ` chapter except the two that are not one; per chapter the `Read when:` line, the
 * list lines Question / Inputs / How to draw / How to read it / Pairs with / Exemplar, and the python block under
 * Code. The chapter slug is the kind id. The checker for the book is platform/research/check_charts.py and holds
 * the book's rules; this reads only what the view draws. Each book is parsed once per file mtime, never
 * per request. The exemplar's PNG is read from the study notebook's output (the cell tagged with the figure id).
 */

export const NOT_A_TYPE = ['How the bank works', 'The types']
/** the figure id the bank and a manifest use */
export const FIG_ID = /^fig:s\d-[\w-]+$/

export const chartSlug = (heading: string) => heading.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')

type Parsed = Omit<ChartType, 'picture' | 'fault' | 'used'>

/** `## ` chapters of the book -> heading and body, in order; a `## ` inside a code fence is code, not a heading */
export function chaptersOf(text: string): { heading: string; body: string }[] {
  const out: { heading: string; body: string }[] = []
  let cur: { heading: string; lines: string[] } | null = null
  let fence = false
  const flush = () => { if (cur) out.push({ heading: cur.heading, body: cur.lines.join('\n') }) }
  for (const line of text.split(/\r?\n/)) {
    if (/^```/.test(line)) fence = !fence
    if (!fence && line.startsWith('## ')) {
      flush()
      const heading = line.slice(3).trim()
      cur = NOT_A_TYPE.includes(heading) ? null : { heading, lines: [] }
    } else cur?.lines.push(line)
  }
  flush()
  return out
}

/** a list line `- **Name:** text` and the indented lines under it: the text, then each sub-bullet; null when the chapter has no such line */
export function fieldOf(body: string, name: string): string[] | null {
  const lines = body.split('\n')
  const head = `- **${name}:**`
  const at = lines.findIndex(l => l.startsWith(head))
  if (at < 0) return null
  const out: string[] = []
  const first = lines[at].slice(head.length).trim()
  if (first) out.push(first)
  for (let i = at + 1; i < lines.length && /^\s+\S/.test(lines[i]); i++) {
    const sub = /^\s+-\s+(.*)$/.exec(lines[i])
    if (sub) out.push(sub[1].trim())
    else if (out.length) out[out.length - 1] += ' ' + lines[i].trim()
  }
  return out
}

/** the exemplar line: `none yet`, `stem` `fig:id` (a note may follow), or neither. Held to the checker's own pattern */
export function exemplarOf(line: string[] | null): ChartExemplar {
  if (line === null) return { state: 'bad', line: '', why: 'the chapter has no Exemplar line' }
  const raw = line[0] ?? ''
  if (/^`?none yet`?$/.test(raw.split('(')[0].trim())) return { state: 'none' }
  const m = /^`([^`]+)`\s+`([^`]+)`(.*)$/.exec(raw)
  if (!m) return { state: 'bad', line: raw, why: 'the Exemplar is neither `none yet` nor `study` `fig:id`' }
  if (!FIG_ID.test(m[2])) return { state: 'bad', line: raw, why: `${JSON.stringify(m[2])} is not a figure id (fig:s<n>-<name>)` }
  const note = /^\s*\((.*)\)\s*$/.exec(m[3])?.[1] ?? (m[3].trim() || null)
  return { state: 'named', study: m[1], fig: m[2], note }
}

/** the `Category:` line of the header block: one of the eight, else null with why (a missing line is a fault, never a default bucket) */
export function categoryOf(body: string): Pick<ChartType, 'category' | 'categoryWhy'> {
  const raw = /^Category:[ \t]*(.*)$/m.exec(body.split('```')[0])?.[1].trim().replace(/\.$/, '').replace(/^`|`$/g, '')
  if (raw === undefined) return { category: null, categoryWhy: 'the chapter has no Category line' }
  const category = chartCategoryOf(raw)
  if (category) return { category, categoryWhy: null }
  return { category: null, categoryWhy: `${JSON.stringify(raw)} is not a category (${CHART_CATEGORIES.map(c => c.name).join(', ')})` }
}

export function codeOf(body: string): string | null {
  return /```python\n([\s\S]*?)\n```/.exec(body)?.[1] ?? null
}

/** one chapter as a card's text; a missing line is empty, never invented */
export function parseChapter(heading: string, body: string): Parsed {
  const q = fieldOf(body, 'Question')?.[0]?.replace(/^`|`$/g, '').trim()
  return {
    id: chartSlug(heading), heading,
    readWhen: /^Read when:[ \t]*(.+)$/m.exec(body)?.[1].trim() ?? null,
    question: q || null,
    ...categoryOf(body),
    inputs: fieldOf(body, 'Inputs') ?? [], draw: fieldOf(body, 'How to draw') ?? [], read: fieldOf(body, 'How to read it') ?? [], pairs: fieldOf(body, 'Pairs with') ?? [],
    code: codeOf(body), exemplar: exemplarOf(fieldOf(body, 'Exemplar')),
  }
}

export const parseBook = (text: string): Parsed[] => chaptersOf(text).map(c => parseChapter(c.heading, c.body))

const BOOKS = new Map<string, { mtime: number; bytes: number; types: Parsed[] }>()
/** the bank's books in order: `charts.md` (the guide, no types) then `charts-<family>.md`, by name; none when the folder is not there */
export function chartBooks(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter(f => /^charts(-[a-z0-9]+)*\.md$/.test(f)).sort().map(f => join(dir, f))
}

/** the book's chapters, re-parsed only when its file changes (mtime and size) */
export function readBook(path: string): Parsed[] | null {
  if (!existsSync(path)) return null
  const st = statSync(path)
  const hit = BOOKS.get(path)
  if (hit && hit.mtime === st.mtimeMs && hit.bytes === st.size) return hit.types
  const types = parseBook(readFileSync(path, 'utf8'))
  BOOKS.set(path, { mtime: st.mtimeMs, bytes: st.size, types })
  return types
}

/** the picture's URL: the notebook id, the figure, and the notebook's mtime so a re-run is a new URL */
export const figSrc = (id: string, fig: string, mtime: number) => `/api/research/chart-fig?id=${encodeURIComponent(id)}&fig=${encodeURIComponent(fig)}&v=${Math.round(mtime)}`

/** the Charts view: every chart type with its exemplar's picture and the studies whose manifests use the type */
export function charts(root: string, books: string[]): ChartsPayload {
  const read = books.map(readBook).filter((b): b is Parsed[] => b !== null)
  if (!read.length) return { exists: false, types: [], at: Date.now() }
  const parsed = read.flat()
  const ids = listNotebooks(root).filter(id => id.startsWith('studies/'))
  const studies = ids.map(id => readStudy(root, id))
  const byStem = new Map(studies.map(s => [nameOf(s.id.split('/').pop()!).name, s]))
  const types: ChartType[] = parsed.map(t => {
    let picture: ChartType['picture'] = null
    let fault: string | null = null
    if (t.exemplar.state === 'named') {
      const { study, fig } = t.exemplar
      const s = byStem.get(study)
      if (!s) fault = `no notebook named ${study} in studies/`
      else if (s.manifest.state === 'ok' && !s.manifest.manifest.figures.some(f => f.id === fig)) fault = `${study} does not list ${fig}`
      else picture = { study: s.id, fig, src: figSrc(s.id, fig, s.mtime) }
    }
    const used: ChartType['used'] = []
    for (const s of studies) {
      if (s.manifest.state !== 'ok') continue
      for (const f of s.manifest.manifest.figures) if (f.kind === t.id) used.push({ id: s.id, name: s.name, fig: f.id, title: f.title ?? null })
    }
    return { ...t, picture, fault, used }
  })
  return { exists: true, types, at: Date.now() }
}

// ---- the exemplar's PNG ----

type Figs = Map<string, Buffer>
const FIGS = new Map<string, { mtime: number; bytes: number; figs: Figs }>()
const FIGS_KEPT = 4

/** every PNG output of a notebook's cells that carry a `fig:` tag, by figure id */
export function figuresOf(nb: { cells?: any[] }): Figs {
  const out: Figs = new Map()
  for (const c of nb.cells ?? []) {
    const tags: unknown[] = c?.metadata?.tags ?? []
    for (const o of c?.outputs ?? []) {
      const png = o?.data?.['image/png']
      const b64 = Array.isArray(png) ? png.join('') : png
      if (typeof b64 !== 'string') continue
      for (const t of tags) if (typeof t === 'string' && FIG_ID.test(t) && !out.has(t)) out.set(t, Buffer.from(b64.replace(/\s+/g, ''), 'base64'))
    }
  }
  return out
}

/** the PNG of one figure of one notebook, or null when the notebook has no such tagged output; kept per notebook mtime, the last few notebooks only */
export function figurePng(root: string, id: string, fig: string): Buffer | null {
  if (!FIG_ID.test(fig)) return null
  const abs = resolveId(root, id)
  const st = statSync(abs)
  let hit = FIGS.get(abs)
  if (!hit || hit.mtime !== st.mtimeMs || hit.bytes !== st.size) {
    hit = { mtime: st.mtimeMs, bytes: st.size, figs: figuresOf(JSON.parse(readFileSync(abs, 'utf8'))) }
    FIGS.delete(abs)
    FIGS.set(abs, hit)
    while (FIGS.size > FIGS_KEPT) FIGS.delete(FIGS.keys().next().value!)
  }
  return hit.figs.get(fig) ?? null
}
