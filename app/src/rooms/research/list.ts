import { FORMATS, FORMAT_IDS, MARKETS, MARKET_IDS, PACES, STYLES, metricsOf, type MarketId, type Study } from '../../../shared/research.ts'
import { matchesText, nameMatches } from './filter.ts'
import { fmtMetric, formatOf, headlineOfManifest, manifestOf, stateWord, verdictKind } from './format.ts'

// THE STUDIES LIST (B-0284, the owner 2026-09-28; it replaced B-0275's view chips and market groups):
// one toolbar (search, Group, Legacy, fold all) over ONE grouped table whose header, group rows and
// study rows share a column template: Study, Market, Style, Format, Result, Headline, Date ("Look A",
// the owner 2026-10-05, B-0502). Grouped by market (a study under its MAIN market only: markets[0]; the
// others show as outlined squares), format, result or not at all. A group row is its name alone.
// Pure, so the rules are tested (test/research-card.test.ts).

/** the main market: the first of the study's markets (profile.markets, the main one first), null when it has none */
export const mainMarket = (s: Study): MarketId | null => s.labels.markets[0] ?? null
/** the markets a study touches besides its main one */
export const otherMarkets = (s: Study): MarketId[] => s.labels.markets.slice(1)

export const isLegacy = (s: Study) => !s.error && s.manifest.state === 'none'

/** the Study column's name: the file stem without what the columns already carry, the date prefix and
 *  a live market word (or the retired `xasset`); a retired word that reads as the subject stays, so
 *  2026-09-vol-premium is "vol premium" */
export function shortName(name: string): string {
  const s = name.replace(/^\d{4}-\d{2}(?:-\d{2})?-/, '').replace(new RegExp(`^(?:${[...MARKET_IDS, 'xasset'].join('|')})-`), '')
  return s.replace(/[-_]+/g, ' ').trim() || name
}

/** THE RESULT a study is grouped by: its verdict word's kind, legacy with no manifest yet, other for a
 *  word none of the three names, a broken notebook or a bad manifest */
export const RESULTS = [
  ['sized', 'Sized', 'dim', 'the verdict names a size (a leverage like 3x, or SIZE ...)'],
  ['nosize', 'No size', 'faint', 'the verdict is NO SIZE'],
  ['notshown', 'Not shown', 'faint', 'the verdict is NOT SHOWN'],
  ['other', 'Other', 'line2', 'another verdict word, a notebook that does not parse, or a manifest the room cannot read'],
  ['legacy', 'Legacy', 'line3', 'no fund.study/1 manifest yet: joins the structure at its next re-run'],
] as const
export type ResultId = typeof RESULTS[number][0]
export function resultOf(s: Study): ResultId {
  const m = manifestOf(s)
  if (m) return verdictKind(m.verdict.word)
  return isLegacy(s) ? 'legacy' : 'other'
}

/** the Result cell: the word and its dot's tone (none for legacy: nothing was concluded) */
export function resultCell(s: Study): { word: string; tone: 'ok' | 'warn' | 'fail' | 'faint' | ''; why: string } {
  const w = stateWord(s)
  return { word: w.word, tone: w.word === 'legacy' ? '' : w.tone, why: w.why }
}

/** the Headline cell: the manifest's own headline (the number its card leads with, the one its gate judges; its label
 *  and hurdle are the tooltip, its gate's verdict the tone), else the format's lead metric VALUE (the one number that
 *  format is read by first), or for a study with no manifest the loop run that recorded it; null when there is none */
export function headlineOf(s: Study): { text: string; value: number | null; tone: 'ok' | 'warn' | 'fail' | 'faint' | ''; title: string } | null {
  const c = manifestOf(s), f = formatOf(c)
  const own = c && headlineOfManifest(c)
  if (own) return { text: own.text, value: typeof c!.headline!.value === 'number' ? c!.headline!.value : null, tone: own.verdict ? own.tone : '', title: own.title }
  if (c && f) {
    const lead = metricsOf(f).find(x => x.key === FORMATS[f].lead)!
    const v = c.metrics![lead.key] ?? null
    const t = fmtMetric(lead, v)
    return { text: t ?? 'n/a', value: t === null ? null : v, tone: '', title: `${lead.label} (${FORMATS[f].label}): ${lead.title}${t === null ? `\nn/a: ${c.na?.[lead.key] ?? 'no reason given'}` : ''}` }
  }
  if (!c && s.loop[0]) return { text: s.loop[0].run, value: null, tone: '', title: `loop record ${s.loop[0].run}: ${s.loop[0].headline}` }
  return null
}

export const GROUP_BY = [
  ['market', 'Market', "one group per market; a study is listed under its main market only (the others show as outlined squares)"],
  ['format', 'Format', 'one group per format'],
  ['result', 'Result', 'one group per result: sized, no size, not shown, other, legacy'],
  ['none', 'None', 'one list'],
] as const
export type GroupBy = typeof GROUP_BY[number][0]

export const COLUMNS = [
  ['name', 'Study', 'the file name without its date and market word; the full name is the tooltip'],
  ['market', 'Market', 'profile.markets, else platform/research/labels.json, else the market word of its name. Filled square: the main market; outlined: any other'],
  ['style', 'Style', "the manifest's tags.style, else platform/research/labels.json; then tags.pace (derived by platform, dashed)"],
  ['format', 'Format', "the manifest's format, else platform/research/labels.json"],
  ['result', 'Result', "the study's verdict (legacy: no manifest yet)"],
  ['lead', 'Headline', "the manifest's headline (label and hurdle in the tooltip, its gate's verdict as the tone), else the format's lead metric; a loop run id for a study with no manifest"],
  ['date', 'Date', 'the last commit touching the file (MM-DD)'],
] as const
export type SortKey = typeof COLUMNS[number][0]

/** the grid's tracks, and what a row needs besides them: the template is built from the columns that fit */
const TRACK: Record<SortKey, number | null> = { name: null, market: 44, style: 84, format: 76, result: 84, lead: 88, date: 36 }
const GAP = 10, EDGES = 40, NAME_MIN = 120
/** the columns a list of this width shows, in COLUMNS order. Format is hidden when grouped by Format (the
 *  group row says it); then Format, Headline and Result give way, in that order, until the rest fit (the
 *  verdict is the last to go). Study, Market, Style and Date always stay. Width 0 (not measured yet) shows
 *  all of them */
export function visibleColumns(width: number, by: GroupBy): SortKey[] {
  let cols = COLUMNS.map(c => c[0]).filter(k => !(by === 'format' && k === 'format'))
  const need = (xs: SortKey[]) => NAME_MIN + EDGES + GAP * (xs.length - 1) + xs.reduce((n, k) => n + (TRACK[k] ?? 0), 0)
  for (const drop of ['format', 'lead', 'result'] as const) { if (width <= 0 || need(cols) <= width) break; cols = cols.filter(k => k !== drop) }
  return cols
}
/** the grid-template-columns for those columns */
export const trackList = (cols: SortKey[]): string => cols.map(k => (TRACK[k] === null ? 'minmax(0, 1fr)' : `${TRACK[k]}px`)).join(' ')
export type Sort = { key: SortKey; dir: 1 | -1 }
export const DEFAULT_SORT: Sort = { key: 'date', dir: -1 }

/** a header click: the same column reverses; another starts newest first for the date, else ascending */
export const nextSort = (s: Sort, key: SortKey): Sort => (s.key === key ? { key, dir: s.dir === 1 ? -1 : 1 } : { key, dir: key === 'date' ? -1 : 1 })

const RESULT_ORDER = RESULTS.map(r => r[0]) as ResultId[]
function sortValue(s: Study, k: SortKey): string | number | null {
  switch (k) {
    case 'name': return shortName(s.name).toLowerCase()
    case 'market': { const k = mainMarket(s); return k ? MARKET_IDS.indexOf(k) : null }
    case 'style': return s.labels.style ? STYLES.indexOf(s.labels.style) * 10 + (s.labels.pace ? PACES.indexOf(s.labels.pace) + 1 : 0) : null
    case 'format': return s.labels.format ? FORMATS[s.labels.format].label : null
    case 'result': return RESULT_ORDER.indexOf(resultOf(s))
    case 'lead': { const h = headlineOf(s); return h?.value ?? h?.text ?? null }
    case 'date': return s.commit?.date ?? null
  }
}
/** legacy always last in its group; then the column (an empty value last either way), then newest, then name */
export function compareStudies(a: Study, b: Study, sort: Sort): number {
  const leg = Number(isLegacy(a)) - Number(isLegacy(b))
  if (leg) return leg
  const va = sortValue(a, sort.key), vb = sortValue(b, sort.key)
  if (va === null || vb === null) { if (va !== vb) return va === null ? 1 : -1 }
  else if (typeof va === 'number' && typeof vb === 'number') { if (va !== vb) return sort.dir * (va - vb) }
  else if (typeof va !== typeof vb) return typeof va === 'number' ? -1 : 1
  else { const c = String(va).localeCompare(String(vb)); if (c) return sort.dir * c }
  return (b.commit?.date ?? '').localeCompare(a.commit?.date ?? '') || a.name.localeCompare(b.name)
}

/** a group: `label` null = the headless list of Group: None */
export type ListGroup = { key: string; label: string | null; hue: string | null; title: string; rows: Study[]; count: string; folded: boolean }

/** a group's count: '3', '3 + 1 legacy', '5 legacy' */
function countOf(rows: Study[]): string {
  const leg = rows.filter(isLegacy).length, rest = rows.length - leg
  return leg ? (rest ? `${rest} + ${leg} legacy` : `${leg} legacy`) : String(rest)
}

/** the folder of superseded and draft studies (platform/research/archive): listed behind the Archive toggle, never in a grouping */
export const ARCHIVE = 'archive'
export const isArchived = (s: Study) => s.group === ARCHIVE

export type ListOpts = { q: string; by: GroupBy; legacy: boolean; archive: boolean; sort: Sort; folds: Record<string, boolean> }

/** the list's groups, in order. A fold is the owner's per group (stored). The archive is one last group of its own,
 *  whatever the grouping, and only when asked for: its studies carry no market or format to group by */
export function listGroups(all: Study[], o: ListOpts): ListGroup[] {
  const list = all.filter(s => matchesText(s, o.q))
  const studies = list.filter(s => s.group === 'studies' && (o.legacy || !isLegacy(s)))
  const out: ListGroup[] = []
  const add = (key: string, label: string | null, hue: string | null, title: string, rows: Study[], count?: string) => {
    if (!rows.length) return
    const sorted = [...rows].sort((a, b) => compareStudies(a, b, o.sort))
    // a search ranks a name match first (the sort holds inside each half)
    const named = (o.q.trim() ? sorted.filter(s => nameMatches(s, o.q)) : []), rest = named.length ? sorted.filter(s => !named.includes(s)) : sorted
    out.push({ key, label, hue, title, rows: [...named, ...rest], count: count ?? countOf(rows), folded: label !== null && (o.folds[key] ?? false) })
  }
  if (o.by === 'none') add('none', null, null, 'every study', studies)
  if (o.by === 'market') {
    for (const id of MARKET_IDS) add(`market:${id}`, MARKETS[id].label, MARKETS[id].hue, `market ${id}: studies whose main (first) market it is`, studies.filter(s => mainMarket(s) === id))
    add('market:none', 'No market', null, 'no profile.markets, no labels.json row and no live market word in its name', studies.filter(s => !mainMarket(s)))
  }
  if (o.by === 'format') {
    for (const id of FORMAT_IDS) add(`format:${id}`, FORMATS[id].label, 'line3', FORMATS[id].title, studies.filter(s => s.labels.format === id))
    add('format:none', 'No format', null, 'neither the manifest nor labels.json names a format', studies.filter(s => !s.labels.format))
  }
  if (o.by === 'result') for (const [id, label, hue, title] of RESULTS) add(`result:${id}`, label, hue, title, studies.filter(s => resultOf(s) === id))
  // and a group holding a name match goes above the groups that hold none (stable otherwise)
  if (o.q.trim()) {
    const hit = (g: ListGroup) => g.rows.some(s => nameMatches(s, o.q))
    out.splice(0, out.length, ...out.filter(hit), ...out.filter(g => !hit(g)))
  }
  if (o.archive) {
    const rows = list.filter(isArchived)
    add(`group:${ARCHIVE}`, 'Archive', null, 'superseded and draft studies (platform/research/archive): kept for the record, not part of the groupings', rows, String(rows.length))
  }
  return out
}

/** the one fold button: collapse every group when any is open, else expand them all */
export function foldAll(groups: ListGroup[], folds: Record<string, boolean>): Record<string, boolean> {
  const heads = groups.filter(g => g.label !== null)
  const anyOpen = heads.some(g => !g.folded)
  return { ...folds, ...Object.fromEntries(heads.map(g => [g.key, anyOpen])) }
}
export const anyOpen = (groups: ListGroup[]) => groups.some(g => g.label !== null && !g.folded)

/** why the two pinned cannot be compared, or null when they can: two, each with a manifest, one format */
export function compareRefusal(a: Study | null, b: Study | null): string | null {
  if (!a || !b) return `Pin two studies to compare them (${[a, b].filter(Boolean).length} pinned). The pin is on each study's card.`
  const ma = manifestOf(a), mb = manifestOf(b)
  const bare = [ma ? null : a.name, mb ? null : b.name].filter(Boolean)
  if (bare.length) return `${bare.join(' and ')} carries no fund.study/1 manifest, so there is nothing to set side by side.`
  const fa = formatOf(ma), fb = formatOf(mb)
  if (fa !== fb) return `One is ${fa ? FORMATS[fa].label : 'without a format'}, the other ${fb ? FORMATS[fb].label : 'without a format'}: studies of two formats share no metric and are never compared.`
  return null
}

export const MAX_PINS = 2
/** pin or unpin; a third pin is refused (null), never a silent swap */
export function togglePin(pins: string[], id: string): string[] | null {
  if (pins.includes(id)) return pins.filter(x => x !== id)
  return pins.length >= MAX_PINS ? null : [...pins, id]
}
