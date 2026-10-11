import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FORMAT_IDS, PACES, STYLES, manifestProblems, metricsOf, type Gate, type Labels, type Manifest, type Study } from '../shared/research.ts'
import { labelsOf, nameMarket, namingMarkets, parseLabels, studies as scanStudies } from '../server/research/scan.ts'
import { METRIC_GROUPS, RESULT_KEYS, TABLE_COLS, gateCounts, gateGrid, gateText, gateWord, metricGroups, verdictKind, verdictTone } from '../src/rooms/research/format.ts'
import { COLUMNS, DEFAULT_SORT, anyOpen, compareRefusal, compareStudies, foldAll, headlineOf, isArchived, listGroups, resultCell, mainMarket, nextSort, otherMarkets, resultOf, shortName, togglePin, trackList, visibleColumns, type ListOpts } from '../src/rooms/research/list.ts'

// B-0275 + B-0284: the studies list (one grouped table over two labels, market and format), the pins
// and the ONE fixed summary card. The room reads, never computes: these hold what it reads from where,
// and the one arithmetic it does.

const M: Manifest = {
  schema: 'fund.study/1', id: 'x', kind: 'strategy', desk: 'lab/research', title: 'T', question: 'Q?', status: 'run',
  run: { executed: '2026-09-27T20:02Z', kernel: 'ccvenv' }, window: { from: '2026-07-15T00:00Z', to: '2026-09-27T20:00Z', hours: 1797, regimes: 1 },
  verify: { passed: 41, total: 41 }, gates: [], sections: [], figures: [], verdict: { word: '3x' }, caveats: [],
}
const full = (f: typeof FORMAT_IDS[number]) => Object.fromEntries(metricsOf(f).map(x => [x.key, 1])) as Record<string, number>
const ok = (m: Partial<Manifest>): Study['manifest'] => ({ state: 'ok', cell: 1, manifest: { ...M, ...m } })
const NO_LABELS: Labels = { markets: [], format: null, style: null, pace: null, from: { markets: null, format: null, style: null }, faults: [] }
const lab = (markets: Labels['markets'], format: Labels['format'] = null, style: Labels['style'] = null, pace: Labels['pace'] = null): Labels =>
  ({ ...NO_LABELS, markets, format, style, pace, from: { markets: markets.length ? 'labels.json' : null, format: format ? 'labels.json' : null, style: style ? 'labels.json' : null } })
const study = (id: string, manifest: Study['manifest'], extra: Partial<Study> = {}): Study => ({
  id: `studies/${id}.ipynb`, name: id, tag: null, group: 'studies', bytes: 1, mtime: 0, cells: { markdown: 0, code: 1, executed: 1, images: 0 },
  kernel: 'ccvenv', error: null, manifest, loop: [], commit: { hash: 'abc', date: '2026-09-27' }, labels: NO_LABELS, ...extra,
})

describe('the two labels a study carries (B-0284)', () => {
  // a migration table as the naming book once carried it (the live book has none since 2026-10-03)
  const book = namingMarkets([
    '| `cashcarry_acme.ipynb` | `2026-09-22-crypto-cashcarry-acme.ipynb` |',
    '| `[latest] 2026-09-semis-pair-thesis.ipynb` | `2026-09-22-xasset-semis-pair-leg.ipynb` |',
  ].join('\n'))
  const at = (file: string, manifest: Study['manifest'] = { state: 'none' }) => ({ id: `studies/${file}`, group: 'studies', manifest })
  it('a live market word in the name maps; xasset and vol stay in names and are retired as labels', () => {
    expect(nameMarket('2026-09-27-predmkts-fed-tail-hedge-event.ipynb')).toBe('predmkts')
    expect(nameMarket('2026-09-vol-premium.ipynb')).toBeNull()
    expect(nameMarket('2026-09-22-xasset-semis-pair-leg.ipynb')).toBeNull()
    expect(nameMarket('2026-09-sofr-tail-thesis.ipynb')).toBeNull()        // sofr is not a market word
    expect(book.get('cashcarry_acme.ipynb')).toBe('crypto')
    expect(book.get('[latest] 2026-09-semis-pair-thesis.ipynb')).toBeUndefined()   // its new name says xasset: retired
  })
  it('precedence 1-4: profile.markets, then labels.json, then the old single word (profile.market, name, book), then none', () => {
    const file = { 'studies/2026-09-27-rates-x.ipynb': { markets: ['rates', 'predmkts'], format: 'short_vol' } }
    // 1: the manifest's own markets and format win over the file
    const one = labelsOf(at('2026-09-27-rates-x.ipynb', ok({ profile: { markets: ['crypto'] }, format: 'carry', metrics: full('carry') })), file, book)
    expect([one.markets, one.format, one.from]).toEqual([['crypto'], 'carry', { markets: 'manifest', format: 'manifest', style: null }])
    // 2: a manifest that names neither: labels.json, both markets, in the file's order
    const two = labelsOf(at('2026-09-27-rates-x.ipynb', ok({ profile: { market: 'equities' } })), file, book)
    expect([two.markets, two.format, two.from]).toEqual([['rates', 'predmkts'], 'short_vol', { markets: 'labels.json', format: 'labels.json', style: null }])
    // 3: no file row: the old single profile.market, then the name's word, then the naming book
    expect(labelsOf(at('2026-09-27-rates-x.ipynb', ok({ profile: { market: 'equities' } })), {}, book)).toMatchObject({ markets: ['equities'], from: { markets: 'profile.market' } })
    expect(labelsOf(at('2026-09-27-rates-x.ipynb', ok({ profile: { market: 'xasset' } })), {}, book)).toMatchObject({ markets: ['rates'], from: { markets: 'name' }, faults: [] })
    expect(labelsOf(at('cashcarry_acme.ipynb'), {}, book)).toMatchObject({ markets: ['crypto'], format: null, from: { markets: 'naming book' } })
    // 4: nothing names one
    expect(labelsOf(at('2026-09-vol-premium.ipynb'), {}, book)).toEqual(NO_LABELS)
    expect(labelsOf({ id: 'other/acme.ipynb', group: 'other', manifest: { state: 'none' } }, file, book)).toEqual(NO_LABELS)   // outside studies/ nothing labels
  })
  it('a value off the closed list is a visible fault, never silently dropped, and never a label', () => {
    const l = labelsOf(at('2026-09-vol-premium.ipynb'), { 'studies/2026-09-vol-premium.ipynb': { markets: ['vol', 'crypto'], format: 'vol_selling' } }, book)
    expect(l.markets).toEqual(['crypto'])
    expect(l.format).toBeNull()
    expect(l.faults).toHaveLength(2)
    expect(l.faults[0]).toMatch(/"vol" is not a market/)
    expect(l.faults[1]).toMatch(/"vol_selling" is not a format/)
    // every market off the list: the next source labels it, the fault still shows
    const m = labelsOf(at('2026-09-27-rates-x.ipynb', ok({ profile: { markets: ['xasset'] } })), {}, book)
    expect([m.markets, m.from.markets, m.faults.length]).toEqual([['rates'], 'name', 1])
    expect(labelsOf(at('x.ipynb'), { 'studies/x.ipynb': { markets: 'crypto' } }, book).faults[0]).toMatch(/not a list/)
  })
  it("style (B-0502): the manifest's tags.style, else labels.json; the pace is the manifest's tags.pace and nothing else, never computed", () => {
    const file = { 'studies/2026-10-04-equities-x.ipynb': { markets: ['equities'], format: 'directional', style: 'discretionary' } }
    // the manifest wins over the file; the file serves a study not yet re-run
    expect(labelsOf(at('2026-10-04-equities-x.ipynb', ok({ tags: { style: 'systematic', pace: 'swing' } })), file, book))
      .toMatchObject({ style: 'systematic', pace: 'swing', from: { style: 'manifest' } })
    expect(labelsOf(at('2026-10-04-equities-x.ipynb', ok({})), file, book)).toMatchObject({ style: 'discretionary', pace: null, from: { style: 'labels.json' } })
    expect(labelsOf(at('2026-10-04-equities-x.ipynb'), file, book)).toMatchObject({ style: 'discretionary', pace: null })
    // a pace is never inferred: 6 hours held, and a pace typed in labels.json, both read as no pace
    const held = ok({ format: 'directional', metrics: { ...full('directional'), avg_hold_h: 6 } })
    expect(labelsOf(at('2026-10-04-equities-x.ipynb', held), { 'studies/2026-10-04-equities-x.ipynb': { pace: 'intraday' } } as never, book).pace).toBeNull()
    // none of it: an empty pair
    expect(labelsOf(at('2026-10-04-equities-y.ipynb', ok({})), {}, book)).toMatchObject({ style: null, pace: null, from: { style: null } })
    // off the list: a fault that shows, and no label
    const bad = labelsOf(at('2026-10-04-equities-x.ipynb'), { 'studies/2026-10-04-equities-x.ipynb': { style: 'mft' } }, book)
    expect(bad.style).toBeNull()
    expect(bad.faults[0]).toMatch(/labels.json style: "mft" is not a style \(systematic\|discretionary\)/)
  })
  it('labels.json: a row for no notebook and a file that does not parse are named, never swallowed', () => {
    expect(parseLabels('{ "_note": "x", "studies/a.ipynb": { "markets": ["crypto"] } }')).toEqual({ file: { 'studies/a.ipynb': { markets: ['crypto'] } }, problems: [] })
    expect(parseLabels('{ nope').problems[0]).toMatch(/does not parse/)
    expect(parseLabels('[]').problems[0]).toMatch(/not an object/)
    const root = join(__dirname, 'no-such-research-root')
    expect(scanStudies(root, [], null, 'research/', { labels: null }).labels).toEqual({ state: 'absent', problems: [] })
    expect(scanStudies(root, [], null, 'research/', { labels: { text: '{"studies/gone.ipynb": {"markets": ["crypto"]}}' } }).labels)
      .toEqual({ state: 'ok', problems: ['labels.json names studies/gone.ipynb, which is not a notebook here'] })
    expect(scanStudies(root, [], null, 'research/', { labels: { error: 'EACCES' } }).labels.state).toBe('failed')
  })
})

describe('the fixed card fields the room reads', () => {
  it('profile needs markets (or the old single market); book needs legs of side and instrument; both optional', () => {
    expect(manifestProblems(M)).toEqual([])
    expect(manifestProblems({ ...M, profile: { market: 'rates', venues: ['cme'], bar: '1d' }, book: { at: '1x', legs: [{ side: 'SELL', instrument: 'SR3 put', qty: 40, unit: 'lots' }] } })).toEqual([])
    expect(manifestProblems({ ...M, profile: { markets: ['rates', 'predmkts'] } })).toEqual([])
    expect(manifestProblems({ ...M, profile: { venues: ['cme'] } })).toContain('profile needs markets')
    expect(manifestProblems({ ...M, profile: { markets: [] } })).toContain('profile needs markets')
    expect(manifestProblems({ ...M, book: { legs: [{ side: 'LONG' }] } })).toContain('book needs legs [{side, instrument}]')
  })
})

describe('gates: the closed verdict, the row text, the one count', () => {
  const g = (verdict: string, x: Partial<Gate> = {}): Gate => ({ id: 'G1', section: 'S3', name: 'funding-only above the T-bill', verdict, ...x })
  it("the older words map as the manifest book says; an unknown word stays itself and is never counted", () => {
    expect(['not adopted', 'ADOPTED', 'NO SIZE', 'rung ok, direction failed', 'n/a', 'PASS', 'odd'].map(v => gateWord(g(v)))).toEqual(['INFO', 'PASS', 'INFO', 'INFO', 'N/A', 'PASS', 'odd'])
    expect(gateCounts([g('PASS'), g('ADOPTED'), g('FAIL'), g('FLAG'), g('not adopted'), g('odd')])).toEqual({ pass: 2, fail: 1, flag: 1 })
  })
  it('a row reads its label; a manifest from before the fixed card falls back to id + name, never an invented label', () => {
    expect(gateText(g('PASS', { label: 'Beats T-bill' }))).toBe('Beats T-bill')
    expect(gateText(g('PASS'))).toBe('G1 funding-only above the T-bill')
  })
  it('directions become columns, a row per gate text inside its section, sections in S order', () => {
    const gates = [g('FAIL', { section: 'S4', label: 'OOS', direction: 'the book' }), g('FAIL', { label: 'Beats', direction: 'the book' }),
      g('PASS', { section: 'S4', label: 'OOS', direction: 'the control' }), g('FAIL', { label: 'Beats', direction: 'the control' })]
    const grid = gateGrid(gates)
    expect(grid.directions).toEqual(['the book', 'the control'])
    expect(grid.sections.map(s => s.id)).toEqual(['S3', 'S4'])
    expect(grid.sections[1].rows).toHaveLength(1)
    expect(gateWord(grid.sections[1].rows[0].by['the control'])).toBe('PASS')
    expect(gateGrid([g('PASS'), g('PASS')]).sections[0].rows).toHaveLength(2)    // no direction: two gates, two rows
    // a manifest from before the fixed card: no labels, ids differ per direction (B1 / C1), the name pairs them
    const old = gateGrid([g('FAIL', { id: 'B1', direction: 'the book' }), g('PASS', { id: 'C1', direction: 'the control' })])
    expect(old.sections[0].rows.map(r => [r.text, Object.keys(r.by)])).toEqual([['funding-only above the T-bill', ['the book', 'the control']]])
  })
})

describe('the card lays every metric out once', () => {
  for (const f of FORMAT_IDS) it(`${f}: METRICS groups + RESULT hold each key exactly once; the table's defaults are its own keys`, () => {
    const keys = metricsOf(f).map(x => x.key)
    const placed = [...METRIC_GROUPS[f].flatMap(([, ks]) => ks), ...RESULT_KEYS.filter(k => keys.includes(k))]
    expect([...placed].sort()).toEqual([...keys].sort())
    expect(METRIC_GROUPS[f]).toHaveLength(3)
    expect(TABLE_COLS[f]).toHaveLength(6)
    for (const k of TABLE_COLS[f]) expect(keys).toContain(k)
  })
  it('directional (B-0502): the EDGE block shows when tags.pace is intraday; at any other pace its keys join TRADES, none is dropped', () => {
    const keys = metricsOf('directional').map(x => x.key)
    const placed = (g: [string, string[]][]) => [...g.flatMap(([, ks]) => ks), ...RESULT_KEYS.filter(k => keys.includes(k))].sort()
    expect(metricGroups('directional', 'intraday').map(([n]) => n)).toEqual(['EDGE', 'TRADES', 'RISK'])
    for (const pace of ['swing', 'hold', null, undefined]) {
      const g = metricGroups('directional', pace)
      expect(g.map(([n]) => n)).toEqual(['TRADES', 'RISK'])
      expect(g[0][1].slice(0, 2)).toEqual(['expectancy_bps', 'gross_edge_bps'])
      expect(placed(g)).toEqual([...keys].sort())
    }
    expect(placed(metricGroups('directional', 'intraday'))).toEqual([...keys].sort())
    expect(metricGroups('carry', 'intraday')).toBe(METRIC_GROUPS.carry)      // the pace moves no other format's card
  })
})

describe('the studies list (B-0284)', () => {
  const pair = study('2026-09-22-equities-semis-perp-pair', ok({ format: 'carry', metrics: { ...full('carry'), funding_ann_pct: 9.01 } }), { labels: lab(['equities'], 'carry', 'discretionary', 'hold'), commit: { hash: 'a', date: '2026-09-28' } })
  const sofr = study('2026-09-27-rates-sofr-hike-tail', ok({ verdict: { word: 'NO SIZE' } }), { labels: lab(['rates', 'predmkts'], 'short_vol') })
  const event = study('2026-09-27-predmkts-event', ok({ verdict: { word: 'NOT SHOWN' } }), { labels: lab(['predmkts', 'rates'], 'evidence'), commit: { hash: 'k', date: '2026-09-26' } })
  const oldRates = study('2026-09-sofr-tail-thesis', { state: 'none' }, { labels: lab(['rates'], 'short_vol'), commit: { hash: 'b', date: '2026-09-28' } })
  const vol = study('2026-09-vol-premium', { state: 'none' }, { labels: lab(['crypto'], 'short_vol') })
  const bare = study('mystery', { state: 'none' })
  const all = [pair, sofr, event, oldRates, vol, bare]
  const O: ListOpts = { q: '', by: 'market', legacy: true, archive: false, sort: DEFAULT_SORT, folds: {} }
  const keys = (o: Partial<ListOpts>) => listGroups(all, { ...O, ...o }).map(g => g.key)
  it('the short name drops the date and a live market word (or xasset); a retired word that is the subject stays', () => {
    expect(shortName('2026-09-22-equities-semis-perp-pair')).toBe('semis perp pair')
    expect(shortName('2026-09-22-xasset-semis-pair-leg')).toBe('semis pair leg')
    expect(shortName('2026-09-vol-premium')).toBe('vol premium')
    expect(shortName('cashcarry_acme')).toBe('cashcarry acme')
  })
  it('Group: Market lists a study under its MAIN market only (markets[0]); every other grouping lists it once too (B-0502)', () => {
    const gs = listGroups(all, O)
    expect(gs.map(g => g.key)).toEqual(['market:crypto', 'market:equities', 'market:rates', 'market:predmkts', 'market:none'])
    expect(gs.filter(g => g.rows.includes(sofr)).map(g => g.key)).toEqual(['market:rates'])
    expect(gs.filter(g => g.rows.includes(event)).map(g => g.key)).toEqual(['market:predmkts'])   // the same two markets the other way round
    expect(gs.flatMap(g => g.rows)).toHaveLength(all.length)                                        // each study once, whatever its markets
    expect([mainMarket(sofr), otherMarkets(sofr), mainMarket(pair), otherMarkets(pair), mainMarket(bare)]).toEqual(['rates', ['predmkts'], 'equities', [], null])
    for (const by of ['format', 'result', 'none'] as const) expect(listGroups(all, { ...O, by }).flatMap(g => g.rows).filter(s => s === sofr)).toHaveLength(1)
    expect(keys({ by: 'format' })).toEqual(['format:carry', 'format:short_vol', 'format:evidence', 'format:none'])
    expect(keys({ by: 'result' })).toEqual(['result:sized', 'result:nosize', 'result:notshown', 'result:legacy'])
    const none = listGroups(all, { ...O, by: 'none' })
    expect(none[0]).toMatchObject({ key: 'none', label: null, folded: false })
    expect(none[0].rows).toHaveLength(6)
  })
  it('counts read "n + k legacy"', () => {
    const gs = listGroups(all, O)
    expect(gs.find(g => g.key === 'market:rates')!.count).toBe('1 + 1 legacy')
    expect(gs.find(g => g.key === 'market:crypto')!.count).toBe('1 legacy')
  })
  it('sort: newest first by default, legacy always last in its group; a header click sorts, a second reverses', () => {
    const rows = (sort = DEFAULT_SORT) => listGroups(all, { ...O, by: 'none', sort })[0].rows.map(s => s.name)
    expect(rows()).toEqual(['2026-09-22-equities-semis-perp-pair', '2026-09-27-rates-sofr-hike-tail', '2026-09-27-predmkts-event', '2026-09-sofr-tail-thesis', '2026-09-vol-premium', 'mystery'])   // legacy ones are newer, still last
    const byName = nextSort(DEFAULT_SORT, 'name')
    expect(byName).toEqual({ key: 'name', dir: 1 })
    expect(rows(byName).slice(0, 3)).toEqual(['2026-09-27-predmkts-event', '2026-09-22-equities-semis-perp-pair', '2026-09-27-rates-sofr-hike-tail'])
    expect(rows(nextSort(byName, 'name')).slice(0, 3)).toEqual(['2026-09-27-rates-sofr-hike-tail', '2026-09-22-equities-semis-perp-pair', '2026-09-27-predmkts-event'])
    // Style sorts systematic before discretionary, a pace after its style, and a study with no tags last
    const tagged = [study('a', ok({}), { labels: lab(['crypto'], null, 'discretionary', 'hold') }), study('b', ok({}), { labels: lab(['crypto'], null, 'systematic', 'swing') }),
      study('c', ok({}), { labels: lab(['crypto'], null, 'systematic', 'intraday') }), study('d', ok({}), { labels: lab(['crypto']) }), study('e', ok({}), { labels: lab(['crypto'], null, 'systematic') })]
    const byStyle = nextSort(DEFAULT_SORT, 'style')
    expect(byStyle).toEqual({ key: 'style', dir: 1 })
    expect(listGroups(tagged, { ...O, by: 'none', sort: byStyle })[0].rows.map(s => s.name)).toEqual(['e', 'c', 'b', 'a', 'd'])
    expect(listGroups(tagged, { ...O, by: 'none', sort: { key: 'style', dir: -1 } })[0].rows.map(s => s.name)).toEqual(['a', 'b', 'c', 'e', 'd'])
    expect(nextSort(byName, 'date')).toEqual({ key: 'date', dir: -1 })
    expect(compareStudies(vol, pair, { key: 'name', dir: -1 })).toBeGreaterThan(0)     // legacy last even reversed
  })
  it('the Legacy toggle hides the studies with no manifest; a search narrows', () => {
    const shown = listGroups(all, { ...O, legacy: false })
    expect(new Set(shown.flatMap(g => g.rows).filter(s => s.group === 'studies'))).toEqual(new Set([pair, sofr, event]))
    expect(keys({ q: 'event' })).toEqual(['market:predmkts'])
    expect(keys({ q: 'pred markets', legacy: false })).toEqual(['market:rates', 'market:predmkts'])    // the market's word finds it
  })
  it('the archive is one last group behind its toggle, in every grouping, never mixed into the others (B-0728)', () => {
    const draft = study('2026-09-crypto-draft', ok({}), { id: 'archive/2026-09-crypto-draft.ipynb', group: 'archive', labels: lab(['crypto']) })
    const bare2 = study('old-draft', { state: 'none' }, { id: 'archive/old-draft.ipynb', group: 'archive' })
    const withArch = [...all, draft, bare2]
    const k = (o: Partial<ListOpts>) => listGroups(withArch, { ...O, ...o }).map(g => g.key)
    expect(k({})).toEqual(['market:crypto', 'market:equities', 'market:rates', 'market:predmkts', 'market:none'])   // hidden by default
    expect(k({ archive: true })).toEqual(['market:crypto', 'market:equities', 'market:rates', 'market:predmkts', 'market:none', 'group:archive'])
    expect(k({ archive: true, by: 'none' })).toEqual(['none', 'group:archive'])
    const g = listGroups(withArch, { ...O, archive: true }).at(-1)!
    expect(g).toMatchObject({ label: 'Archive', count: '2' })       // a plain count: a bare draft is not "legacy"
    expect(g.rows).toEqual([draft, bare2])
    expect(listGroups(withArch, { ...O, archive: true }).slice(0, -1).flatMap(x => x.rows)).toHaveLength(all.length)
    expect(k({ archive: true, legacy: false })).toContain('group:archive')
    expect(k({ archive: true, q: 'draft' })).toEqual(['group:archive'])
    expect(listGroups(withArch, { ...O, archive: true, folds: { 'group:archive': true } }).at(-1)!.folded).toBe(true)
    expect(isArchived(draft) && !isArchived(pair)).toBe(true)
  })
  it('a search ranks a name match first, in its group and among the groups (B-0514)', () => {
    const four = study('2026-09-22-rates-semis-pair-leg-discretionary', ok({ title: 'Four legs' }), { labels: lab(['rates']), commit: { hash: 'a', date: '2026-09-01' } })
    const perp = study('2026-09-30-equities-perp-pair', ok({ title: 'x', question: 'semis pair leg spread?' }), { labels: lab(['equities']), commit: { hash: 'b', date: '2026-09-30' } })
    const rows = (q: string, by: ListOpts['by']) => listGroups([perp, four], { ...O, q, by })
    expect(rows('semis pair leg', 'none')[0].rows).toEqual([four, perp])          // the manifest text matches both; the name only one
    expect(rows('semis pair leg', 'market').map(g => g.key)).toEqual(['market:rates', 'market:equities'])   // equities comes first without a query
    expect(rows('', 'market').map(g => g.key)).toEqual(['market:equities', 'market:rates'])
    expect(rows('semis pair leg', 'none')[0].rows[0]).toBe(four)
  })
  it('a verdict word is not good or bad: 3x and NO SIZE are faint, never green or amber (B-0514)', () => {
    expect(['3x', 'SIZE 1x', 'NO SIZE', 'NOT SHOWN'].map(verdictTone)).toEqual(['faint', 'faint', 'faint', 'faint'])
    expect(['PASS', 'FAIL', 'KILL'].map(verdictTone)).toEqual(['ok', 'fail', 'warn'])
    expect([pair, sofr].map(s => resultCell(s).tone)).toEqual(['faint', 'faint'])
  })
  it('fold all: collapses every group when any is open, else expands them all; a fold is kept per group', () => {
    const gs = listGroups(all, O)
    expect(anyOpen(gs)).toBe(true)
    const shut = foldAll(gs, {})
    const closed = listGroups(all, { ...O, folds: shut })
    expect(closed.every(g => g.folded)).toBe(true)
    expect(anyOpen(closed)).toBe(false)
    expect(listGroups(all, { ...O, folds: foldAll(closed, shut) }).every(g => !g.folded)).toBe(true)
    expect(listGroups(all, { ...O, folds: { 'market:rates': true } }).filter(g => g.folded).map(g => g.key)).toEqual(['market:rates'])
    // Group: None: the headless list has no fold of its own, so there is nothing to fold
    expect(foldAll(listGroups(all, { ...O, by: 'none' }), {})).toEqual({})
  })
  it('the result and the headline a row shows', () => {
    expect([pair, sofr, event, oldRates, bare].map(resultOf)).toEqual(['sized', 'nosize', 'notshown', 'legacy', 'legacy'])
    expect(resultOf(study('broken', { state: 'invalid', cell: 1, problems: ['x'] }))).toBe('other')
    expect(headlineOf(pair)?.text).toBe('+9.01%')     // the value alone: the column title and the tooltip carry the name
    expect(headlineOf(pair)?.title).toMatch(/^Funding /)
    expect(headlineOf(sofr)).toBeNull()      // a manifest with no format block has no lead metric
  })
  it("the Headline cell reads the manifest's own headline first (B-0519); its tone is its named gate's verdict, never guessed from the hurdle", () => {
    const gate = (id: string, verdict: string) => ({ id, section: 'S3', name: id, verdict })
    const hl = { metric: 'funding net of all stock carry, ann % on equity', label: 'Net carry', value: 3.0704, unit: 'pct_ann', hurdle: 4.11 }
    const four = (h: typeof hl & { gate?: string }) => study('four', ok({ format: 'carry', metrics: { ...full('carry'), funding_ann_pct: 5.15 }, headline: h, gates: [gate('G1', 'FAIL')] }))
    expect(headlineOf(four(hl))).toMatchObject({ text: '3.07% ann', value: 3.0704, tone: '' })     // not the lead metric's +5.15%
    expect(headlineOf(four(hl))?.title).toMatch(/^Net carry /)
    expect(headlineOf(four(hl))?.title).toContain('hurdle 4.11% ann')
    expect(headlineOf(four({ ...hl, gate: 'G1' }))).toMatchObject({ tone: 'fail' })
    expect(headlineOf(four({ ...hl, value: 0.942 }))?.text).toBe('0.942% ann')     // the card's decimals, not two
    expect(headlineOf(four({ ...hl, gate: 'G9' }))).toMatchObject({ tone: '' })       // names a gate the manifest lacks: no tone
    expect(headlineOf(study('none', ok({ format: 'carry', metrics: { ...full('carry'), funding_ann_pct: 9.01 }, headline: null })))?.text).toBe('+9.01%')
  })
  it('the columns (B-0502): Study, Market, Style, Format, Result, Headline, Date; Format is hidden when grouped by Format; a narrow list drops Format, Headline, Result in that order', () => {
    expect(COLUMNS.map(c => c[0])).toEqual(['name', 'market', 'style', 'format', 'result', 'lead', 'date'])
    expect(visibleColumns(0, 'market')).toEqual(['name', 'market', 'style', 'format', 'result', 'lead', 'date'])    // not measured yet: all
    expect(visibleColumns(900, 'market')).toEqual(['name', 'market', 'style', 'format', 'result', 'lead', 'date'])
    expect(visibleColumns(900, 'format')).toEqual(['name', 'market', 'style', 'result', 'lead', 'date'])
    expect(visibleColumns(660, 'market')).toEqual(['name', 'market', 'style', 'format', 'result', 'lead', 'date'])
    expect(visibleColumns(600, 'market')).toEqual(['name', 'market', 'style', 'result', 'lead', 'date'])      // Result and Headline fit the 720px cap's list
    expect(visibleColumns(500, 'market')).toEqual(['name', 'market', 'style', 'result', 'date'])
    expect(visibleColumns(400, 'market')).toEqual(['name', 'market', 'style', 'date'])
    expect(visibleColumns(100, 'format')).toEqual(['name', 'market', 'style', 'date'])        // Study, Market, Style and Date always stay
    expect(trackList(['name', 'market', 'style', 'date'])).toBe('minmax(0, 1fr) 44px 84px 36px')
  })
  it('the group row of a format is its name alone; the hint stays the tooltip (B-0502)', () => {
    const g = listGroups(all, { ...O, by: 'format' })[0]
    expect(g).toMatchObject({ key: 'format:carry', label: 'Carry' })
    expect(g.title).toMatch(/^hold a funding, basis or rate differential/)
  })
  it('the tags are two closed lists, in platform report.STYLES / PACES order', () => {
    expect([...STYLES]).toEqual(['systematic', 'discretionary'])
    expect([...PACES]).toEqual(['intraday', 'swing', 'hold'])
  })
  it('the verdict kinds: a leverage word or SIZE is sized; NO SIZE and NOT SHOWN are their own', () => {
    expect(['3x', '1.5x', 'SIZE 1x', 'NO SIZE', 'NOT SHOWN', 'KILL'].map(verdictKind)).toEqual(['sized', 'sized', 'sized', 'nosize', 'notshown', 'other'])
  })
  it('pins: at most two, a third refused (never a silent swap); unpinning always works', () => {
    expect(togglePin([], 'a')).toEqual(['a'])
    expect(togglePin(['a', 'b'], 'c')).toBeNull()
    expect(togglePin(['a', 'b'], 'a')).toEqual(['b'])
  })
  it('compare is refused across formats, and for a study with no manifest', () => {
    const pair2 = study('pair2', ok({ format: 'carry', metrics: full('carry') }))
    const ev = study('ev', ok({ format: 'evidence', metrics: full('evidence') }))
    expect(compareRefusal(pair, pair2)).toBeNull()
    expect(compareRefusal(pair, ev)).toMatch(/Carry.*Evidence.*never compared/)
    expect(compareRefusal(pair, vol)).toMatch(/no fund.study\/1 manifest/)
    expect(compareRefusal(pair, null)).toMatch(/Pin two/)
  })
})
