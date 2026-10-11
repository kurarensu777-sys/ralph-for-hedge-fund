import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { CHART_CATEGORIES, CHART_KINDS, RETIRED_CHART_KINDS, STUDY_MIME, manifestProblems, type ChartType } from '../shared/research.ts'
import { categoryOf, chartBooks, charts, chartSlug, chaptersOf, exemplarOf, fieldOf, figurePng, parseBook, parseChapter, readBook } from '../server/research/charts.ts'
import { NO_CHART_FILTER, chartCounts, chartGroups, chartMatches, usedBy } from '../src/rooms/research/chartfilter.ts'

// The Research room's Charts view (B-0505): the chart bank's chapters read as cards, the exemplar's
// picture, the manifest's figure kind, and the drawn / not drawn yet filter. Pinned with literals.

const FENCE = '```'
const chapter = (over: { exemplar?: string | null; question?: string; category?: string | null } = {}) => [
  '## Significance test', '',
  'Read when: you must say whether a result is luck: a permutation null against the observed value.',
  ...(over.category === null ? [] : [`Category: ${over.category ?? 'The luck'}`]), '',
  `- **Question:** ${over.question ?? 'Is the result more than luck?'}`,
  '- **Inputs:** `null` (1-D array), `observed`',
  '- **How to draw:**',
  '  - One axes: the null as a histogram.',
  '  - One table of four columns under the chart,',
  '    one row per test.',
  '- **How to read it:** Pass: the line sits beyond the far tail.',
  '- **Pairs with:** gate 2',
  ...(over.exemplar === null ? [] : [`- **Exemplar:** ${over.exemplar ?? '`2026-01-01-example-spread-study` `fig:s4-luck`'}`]),
  '- **Code:**', '',
  `${FENCE}python`, '## a comment that looks like a heading', 'def draw_significance_test(x):', '    return x', FENCE, '',
].join('\n')

describe('one chapter of the bank', () => {
  it('reads the read-when line, every framework line (sub-bullets and wrapped lines joined) and the code', () => {
    const t = parseChapter('Significance test', chapter().split('\n').slice(1).join('\n'))
    expect(t.id).toBe('significance-test')
    expect(t.readWhen).toBe('you must say whether a result is luck: a permutation null against the observed value.')
    expect(t.question).toBe('Is the result more than luck?')
    expect(t.inputs).toEqual(['`null` (1-D array), `observed`'])
    expect(t.draw).toEqual(['One axes: the null as a histogram.', 'One table of four columns under the chart, one row per test.'])
    expect(t.read).toEqual(['Pass: the line sits beyond the far tail.'])
    expect(t.pairs).toEqual(['gate 2'])
    expect(t.code).toBe('## a comment that looks like a heading\ndef draw_significance_test(x):\n    return x')
    expect(t.exemplar).toEqual({ state: 'named', study: '2026-01-01-example-spread-study', fig: 'fig:s4-luck', note: null })
    expect([t.category, t.categoryWhy]).toEqual(['luck', null])
  })
  it('strips the backticks the book wraps a Question in, and keeps one it does not', () => {
    expect(parseChapter('X', '- **Question:** `How has <series> moved?`\n').question).toBe('How has <series> moved?')
    expect(parseChapter('X', '- **Question:** Does the rule work out of sample?\n').question).toBe('Does the rule work out of sample?')
  })
  it('a chapter with no Exemplar line is a fault, never "not drawn yet"', () => {
    const t = parseChapter('Significance test', chapter({ exemplar: null }))
    expect(t.exemplar).toEqual({ state: 'bad', line: '', why: 'the chapter has no Exemplar line' })
  })
  it('`none yet` is the one honest "not drawn yet", with or without backticks', () => {
    expect(exemplarOf(['none yet'])).toEqual({ state: 'none' })
    expect(exemplarOf(['`none yet`'])).toEqual({ state: 'none' })
  })
  it('a bad figure id is named, not guessed at', () => {
    expect(exemplarOf(['`2026-10-04-a` `fig:luck`'])).toEqual({ state: 'bad', line: '`2026-10-04-a` `fig:luck`', why: '"fig:luck" is not a figure id (fig:s<n>-<name>)' })
    expect(exemplarOf(['2026-10-04-a fig:s4-luck'])).toEqual({ state: 'bad', line: '2026-10-04-a fig:s4-luck', why: 'the Exemplar is neither `none yet` nor `study` `fig:id`' })
  })
  it('keeps a trailing note on a named exemplar', () => {
    expect(exemplarOf(['`s1` `fig:s4-rules` (the exemplar is the table alone)'])).toEqual({ state: 'named', study: 's1', fig: 'fig:s4-rules', note: 'the exemplar is the table alone' })
  })
  it('the eight categories are the owner names, in order, each with the question a reader arrives with', () => {
    expect(CHART_CATEGORIES.map(c => c.name)).toEqual(['The run', 'The edge', 'The luck', 'The choice', 'The trade', 'Size and cost', 'The book', 'The data'])
    expect(new Set(CHART_CATEGORIES.map(c => c.id)).size).toBe(8)
    for (const c of CHART_CATEGORIES) expect(c.asks, c.name).toBeTruthy()
  })
  it('a Category line reads each of the eight, with a trailing full stop or backticks tolerated', () => {
    for (const c of CHART_CATEGORIES) expect(categoryOf(`Category: ${c.name}\n`), c.name).toEqual({ category: c.id, categoryWhy: null })
    expect(categoryOf('Category: `The run`.\n').category).toBe('run')
  })
  it('a missing or unknown Category is a fault with its reason, never a default bucket', () => {
    expect(categoryOf('Read when: x.\n')).toEqual({ category: null, categoryWhy: 'the chapter has no Category line' })
    expect(categoryOf('Category:\n').category).toBeNull()
    for (const bad of ['The Run', 'the luck', 'Luck', 'The risk', 'run']) {
      const r = categoryOf(`Category: ${bad}\n`)
      expect(r.category, bad).toBeNull()
      expect(r.categoryWhy, bad).toContain(`${JSON.stringify(bad)} is not a category (The run, The edge, The luck, The choice, The trade, Size and cost, The book, The data)`)
    }
  })
  it('a Category line inside the code block is code, not the header', () => {
    expect(categoryOf('Read when: x.\n\n```python\nCategory: The run\n```\n').category).toBeNull()
  })
  it('missing lines read as empty, never invented', () => {
    const t = parseChapter('Capacity curve', '- **Question:** How large can we trade?\n')
    expect([t.readWhen, t.code, t.inputs, t.draw, t.read, t.pairs, t.category]).toEqual([null, null, [], [], [], [], null])
    expect(fieldOf('- **Inputs:** x\n', 'Pairs with')).toBeNull()
  })
})

describe('the book', () => {
  const book = `# The chart bank\n\n## How the bank works\n\nx\n\n## The types\n\n| a |\n\n${chapter()}\n${chapter().replace('Significance test', 'Out-of-sample test')}`
  it('every `## ` chapter is a type except the two that are not, and a heading inside a code fence is code', () => {
    expect(chaptersOf(book).map(c => c.heading)).toEqual(['Significance test', 'Out-of-sample test'])
    expect(parseBook(book).map(t => t.id)).toEqual(['significance-test', 'out-of-sample-test'])
  })
  it('the kind id is the heading slug', () => {
    expect(chartSlug('Out-of-sample test')).toBe('out-of-sample-test')
    expect(chartSlug('Monte Carlo and ruin')).toBe('monte-carlo-and-ruin')
    expect(chartSlug('Fund-book correlation')).toBe('fund-book-correlation')
  })
  const shelf = join(__dirname, '..', 'library', 'research')
  const real = chartBooks(shelf).flatMap(p => readBook(p) ?? [])
  it('the committed books are there, and their chapters are exactly the kinds a manifest may carry, none twice', () => {
    expect(chartBooks(shelf).map(p => basename(p))).toEqual(['charts-describe.md', 'charts-test.md', 'charts-trade.md', 'charts.md'])
    expect(real.map(t => t.id).sort()).toEqual([...CHART_KINDS].sort())
    expect(CHART_KINDS).toHaveLength(51)
  })
  // Research adds `Category:` to every chapter in B-0673. Until a single chapter carries one, nothing is asserted
  // here (the view shows the fault); once any does, every chapter must, and each must be one of the eight.
  const filed = real.some(t => t.category !== null)
  it.skipIf(!filed)('every chapter of the committed book names one of the eight categories', () => {
    for (const t of real) expect([t.id, t.category, t.categoryWhy], t.id).toEqual([t.id, expect.stringMatching(/./), null])
    const ids = new Set<string>(CHART_CATEGORIES.map(c => c.id))
    expect(real.every(t => ids.has(t.category!))).toBe(true)
  })
  it('every chapter of the committed book reads: a question, the read-when line, code, a readable Exemplar', () => {
    for (const t of real) {
      expect(t.question, t.id).toMatch(/\?$/)
      expect(t.readWhen, t.id).toBeTruthy()
      expect(t.code, t.id).toMatch(/def draw_/)
      expect(t.exemplar.state, t.id).not.toBe('bad')
    }
  })
  it('is parsed once per file mtime: the same objects until the file changes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'charts-book-'))
    try {
      const p = join(dir, 'charts.md')
      writeFileSync(p, book)
      const a = readBook(p)!
      expect(readBook(p)).toBe(a)
      writeFileSync(p, book.replace('Is the result more than luck?', 'Is it luck?'))
      utimesSync(p, new Date(Date.now() + 5000), new Date(Date.now() + 5000))
      expect(readBook(p)).not.toBe(a)
      expect(readBook(p)![0].question).toBe('Is it luck?')
      expect(readBook(join(dir, 'none.md'))).toBeNull()
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})

describe('the figure kind in a manifest', () => {
  const M = {
    schema: 'fund.study/1', id: 'a', kind: 'strategy', desk: 'lab/research', title: 't', question: 'q', status: 'draft', run: {},
    window: { from: '2026-01-01', to: '2026-02-01' }, verify: { passed: 1, total: 1 }, gates: [], sections: [],
    figures: [{ id: 'fig:s4-luck', section: 'S4' }], verdict: { word: 'NO SIZE' }, caveats: [],
  }
  const kind = (k: unknown) => ({ ...M, figures: [{ id: 'fig:s4-luck', section: 'S4', kind: k }] })
  it('a missing kind is not a fault: an older notebook has none until its next re-run', () => expect(manifestProblems(M)).toEqual([]))
  it('a chapter slug is a valid kind', () => {
    expect(manifestProblems(kind('significance-test'))).toEqual([])
    for (const k of CHART_KINDS) expect(manifestProblems(kind(k)), k).toEqual([])
  })
  it('a type cut from the bank is no chapter and no kind, yet a notebook stamped before the cut still reads', () => {
    expect(RETIRED_CHART_KINDS).toEqual(['rolling-win-rate', 'per-trade-pnl-over-time', 'path-fan', 'assumption-sensitivity', 'trade-marks'])
    for (const k of RETIRED_CHART_KINDS) {
      expect(CHART_KINDS as readonly string[], k).not.toContain(k)
      expect(manifestProblems(kind(k)), k).toEqual([])
    }
  })
  it('anything else is a manifest problem, named: a word, the heading, a near miss, empty, a non-string', () => {
    const why = (k: unknown) => `figure fig:s4-luck kind ${JSON.stringify(k)} is not a chart type (a chapter slug of charts.md)`
    expect(manifestProblems(kind('luck'))).toEqual([why('luck')])
    expect(manifestProblems(kind('Significance test'))).toEqual([why('Significance test')])
    expect(manifestProblems(kind('significance_test'))).toEqual([why('significance_test')])
    expect(manifestProblems(kind(''))).toEqual([why('')])
    expect(manifestProblems(kind(7))).toEqual([why(7)])
    expect(manifestProblems(kind(null))).toEqual([why(null)])
  })
})

describe('the filter', () => {
  const t = (id: string, question: string, readWhen: string, exemplar: ChartType['exemplar']): ChartType =>
    ({ id, heading: id, question, readWhen, category: 'luck', categoryWhy: null, inputs: [], draw: [], read: [], pairs: [], code: null, exemplar, picture: null, fault: null, used: [] })
  const named = { state: 'named', study: 's', fig: 'fig:s1-a', note: null } as const
  const types = [
    t('a', 'Is the result more than luck?', 'you must say whether a result is luck', named),
    t('b', 'How large can we trade before the edge is gone?', 'a strategy has a positive edge at a small size', { state: 'none' }),
    t('c', 'How much cost can the rule take?', 'a rule nets above the hurdle', { state: 'none' }),
    t('d', 'Does the rule work out of sample?', 'you must show it holds on days the rule was not set on', { state: 'bad', line: '', why: 'x' }),
  ]
  const ids = (f: Partial<typeof NO_CHART_FILTER>) => types.filter(x => chartMatches(x, { ...NO_CHART_FILTER, ...f })).map(x => x.id).join('')
  it('counts: every type, those with an exemplar, those with none yet, and those with an unreadable line, which are neither', () => {
    expect(chartCounts(types)).toEqual({ all: 4, drawn: 1, undrawn: 2, unreadable: 1, uncategorised: 0 })
    expect(chartCounts([])).toEqual({ all: 0, drawn: 0, undrawn: 0, unreadable: 0, uncategorised: 0 })
  })
  it('the split: all, drawn, not drawn yet; a bad Exemplar is in all and in neither', () => {
    expect(ids({})).toBe('abcd')
    expect(ids({ show: 'drawn' })).toBe('a')
    expect(ids({ show: 'undrawn' })).toBe('bc')
  })
  it('the search reads the question and the read-when line, every word, any order, any case', () => {
    expect(ids({ q: 'LUCK' })).toBe('a')
    expect(ids({ q: 'rule' })).toBe('cd')
    expect(ids({ q: 'edge size' })).toBe('b')
    expect(ids({ q: 'rule hurdle' })).toBe('c')
    expect(ids({ q: 'nothing like this' })).toBe('')
    expect(ids({ q: '   ' })).toBe('abcd')
  })
  it('the search and the split together', () => {
    expect(ids({ q: 'rule', show: 'undrawn' })).toBe('c')
    expect(ids({ q: 'luck', show: 'undrawn' })).toBe('')
  })
  it('does not search the rest of the chapter: only the question and the read-when line', () => {
    expect(chartMatches({ ...types[0], inputs: ['quartz'], draw: ['quartz'] }, { q: 'quartz', show: 'all' })).toBe(false)
  })
})

describe('the grouping', () => {
  const t = (id: string, category: ChartType['category']): ChartType =>
    ({ id, heading: id, question: id, readWhen: null, category, categoryWhy: category ? null : 'the chapter has no Category line', inputs: [], draw: [], read: [], pairs: [], code: null, exemplar: { state: 'none' }, picture: null, fault: null, used: [] })
  it('groups in the closed list order, book order inside, and leaves out a category with nothing to show', () => {
    const g = chartGroups([t('a', 'data'), t('b', 'run'), t('c', 'data'), t('d', 'luck')])
    expect(g.map(x => [x.name, x.types.map(y => y.id).join('')])).toEqual([['The run', 'b'], ['The luck', 'd'], ['The data', 'ac']])
    expect(g[0].asks).toBe('Did it make money, and how did it arrive')
    expect(chartGroups([])).toEqual([])
  })
  it('a type with no readable category is a last group of its own, never one of the eight', () => {
    const g = chartGroups([t('a', null), t('b', 'edge'), t('c', null)])
    expect(g.map(x => [x.id, x.types.map(y => y.id).join('')])).toEqual([['edge', 'b'], [null, 'ac']])
    expect(chartCounts([t('a', null), t('b', 'edge')]).uncategorised).toBe(1)
    // an older fundd sends no category field at all: still a card under No category, never a vanished one
    const old = { ...t('o', null), category: undefined } as unknown as ChartType
    expect(chartGroups([old]).map(x => [x.id, x.types.length])).toEqual([[null, 1]])
    expect(chartCounts([old]).uncategorised).toBe(1)
  })
})

describe('the exemplar picture, end to end', () => {
  const root = mkdtempSync(join(tmpdir(), 'charts-'))
  afterAll(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'studies'))
  const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
  const manifest = {
    schema: 'fund.study/1', id: 'a', kind: 'strategy', desk: 'lab/research', title: 'Spread', question: 'q', status: 'run', run: {},
    window: { from: '2026-01-01', to: '2026-02-01' }, verify: { passed: 1, total: 1 }, gates: [], sections: [],
    figures: [{ id: 'fig:s4-luck', section: 'S4', title: 'luck', kind: 'significance-test' }, { id: 'fig:s2-plain', section: 'S2' }], verdict: { word: 'NO SIZE' }, caveats: [],
  }
  const cell = (tag: string, png: string[] | string) => ({ cell_type: 'code', execution_count: 1, source: ['x'], metadata: { tags: [tag] }, outputs: [{ output_type: 'display_data', data: { 'image/png': png, 'text/plain': ['<Figure>'] }, metadata: {} }] })
  writeFileSync(join(root, 'studies', '2026-10-04-a.ipynb'), JSON.stringify({ cells: [
    cell('fig:s4-luck', [PNG.slice(0, 30) + '\n', PNG.slice(30)]), cell('fig:s2-plain', PNG),
    { cell_type: 'code', execution_count: 2, source: ['m'], metadata: { tags: ['manifest'] }, outputs: [{ output_type: 'display_data', data: { [STUDY_MIME]: manifest }, metadata: {} }] },
  ] }))
  const book = join(root, 'charts.md')
  const ch = (h: string, ex: string) => `## ${h}\n\nRead when: x.\n\n- **Question:** How does ${h} look?\n- **Exemplar:** ${ex}\n- **Code:**\n\n${FENCE}python\ndef draw_x(): pass\n${FENCE}\n`
  writeFileSync(book, ['# bank', ch('Significance test', '`2026-10-04-a` `fig:s4-luck`'), ch('Equity curve', '`none yet`'), ch('Calibration', '`2026-10-04-nope` `fig:s3-x`'),
    ch('Cost sensitivity', '`2026-10-04-a` `fig:s9-missing`'), ch('Rolling statistics', '`2026-10-04-a` `fig:oops`')].join('\n'))

  it('a named exemplar gets its PNG url, keyed by the notebook mtime; none yet gets no picture', () => {
    const p = charts(root, [book])
    expect(p.exists).toBe(true)
    const by = Object.fromEntries(p.types.map(t => [t.id, t]))
    expect(by['significance-test'].picture).toMatchObject({ study: 'studies/2026-10-04-a.ipynb', fig: 'fig:s4-luck' })
    expect(by['significance-test'].picture!.src).toMatch(/^\/api\/research\/chart-fig\?id=studies%2F2026-10-04-a\.ipynb&fig=fig%3As4-luck&v=\d+$/)
    expect(by['significance-test'].fault).toBeNull()
    expect(by['equity-curve']).toMatchObject({ picture: null, fault: null, exemplar: { state: 'none' } })
  })
  it('names why a named exemplar has no picture: no such notebook, a figure the manifest does not list, a bad id', () => {
    const by = Object.fromEntries(charts(root, [book]).types.map(t => [t.id, t]))
    expect(by['calibration']).toMatchObject({ picture: null, fault: 'no notebook named 2026-10-04-nope in studies/' })
    expect(by['cost-sensitivity']).toMatchObject({ picture: null, fault: '2026-10-04-a does not list fig:s9-missing' })
    expect(by['rolling-statistics'].picture).toBeNull()
    expect(by['rolling-statistics'].exemplar.state).toBe('bad')
  })
  it('counts figures and studies apart: a study that draws a type many times is named once', () => {
    const u = (id: string, fig: string) => ({ id, name: id, fig, title: null })
    expect(usedBy([u('a', 'f1'), u('a', 'f2'), u('b', 'f3'), u('a', 'f4')])).toEqual({ studies: [{ id: 'a', name: 'a' }, { id: 'b', name: 'b' }], figures: 4 })
    expect(usedBy([])).toEqual({ studies: [], figures: 0 })
  })
  it('says which studies use a type, by the kind their manifest figures carry', () => {
    const by = Object.fromEntries(charts(root, [book]).types.map(t => [t.id, t]))
    expect(by['significance-test'].used).toEqual([{ id: 'studies/2026-10-04-a.ipynb', name: '2026-10-04-a', fig: 'fig:s4-luck', title: 'luck' }])
    expect(by['equity-curve'].used).toEqual([])
  })
  it('the payload carries each chapter category, and a chapter without a readable one has none', () => {
    const f = join(root, 'cat', 'charts.md')
    mkdirSync(join(root, 'cat'), { recursive: true })
    const at = (h: string, cat: string | null) => ch(h, '`none yet`').replace('Read when: x.', cat ? `Read when: x.\nCategory: ${cat}` : 'Read when: x.')
    writeFileSync(f, ['# c', at('Equity curve', 'The run'), at('Calibration', 'The risk'), at('Autocorrelation', null)].join('\n'))
    const by = Object.fromEntries(charts(root, [f]).types.map(x => [x.id, x]))
    expect(by['equity-curve']).toMatchObject({ category: 'run', categoryWhy: null })
    expect(by['calibration'].category).toBeNull()
    expect(by['calibration'].categoryWhy).toMatch(/"The risk" is not a category/)
    expect(by['autocorrelation']).toMatchObject({ category: null, categoryWhy: 'the chapter has no Category line' })
  })
  it('a missing book is "not there", not an empty bank', () => expect(charts(root, [join(root, 'gone.md')])).toMatchObject({ exists: false, types: [] }))
  it('reads every family book in the order given, the guide (no types) adding none, a missing one skipped', () => {
    const fam = join(root, 'charts-more.md')
    writeFileSync(fam, ['# more', ch('Factor regression', '`none yet`')].join('\n'))
    expect(charts(root, [book, fam, join(root, 'gone.md')]).types.map(t => t.id)).toEqual(['significance-test', 'equity-curve', 'calibration', 'cost-sensitivity', 'rolling-statistics', 'factor-regression'])
    writeFileSync(join(root, 'charts-b.md'), '# b'); writeFileSync(join(root, 'charts-a.md'), '# a'); writeFileSync(join(root, 'chartsx.md'), '# x'); writeFileSync(join(root, 'charts-x_y.md'), '# x')
    expect(chartBooks(root).map(p => basename(p))).toEqual(['charts-a.md', 'charts-b.md', 'charts-more.md', 'charts.md'])
    expect(chartBooks(join(root, 'nowhere'))).toEqual([])
  })
  it('serves the PNG of the cell tagged with the figure id, joined across a split base64 string', () => {
    const png = figurePng(root, 'studies/2026-10-04-a.ipynb', 'fig:s4-luck')!
    expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
    expect(png.length).toBe(Buffer.from(PNG, 'base64').length)
    expect(figurePng(root, 'studies/2026-10-04-a.ipynb', 'fig:s2-plain')!.equals(png)).toBe(true)
  })
  it('a figure with no tagged PNG, a malformed id and a path outside the folder serve nothing', () => {
    expect(figurePng(root, 'studies/2026-10-04-a.ipynb', 'fig:s7-none')).toBeNull()
    expect(figurePng(root, 'studies/2026-10-04-a.ipynb', '../x')).toBeNull()
    expect(() => figurePng(root, '../secret.ipynb', 'fig:s4-luck')).toThrow(/outside the research folder/)
    expect(() => figurePng(root, 'studies/2026-10-04-a.txt', 'fig:s4-luck')).toThrow(/not a notebook id/)
  })
})

describe('the room reads the book, not a copy of it', () => {
  it('the view and the route are wired to the book and the figure viewer', () => {
    const view = readFileSync(join(__dirname, '..', 'src', 'rooms', 'research', 'Charts.tsx'), 'utf8')
    expect(view).toMatch(/FigViewer/)
    expect(view).toMatch(/\/api\/research\/charts/)
    const room = readFileSync(join(__dirname, '..', 'server', 'rooms', 'research.ts'), 'utf8')
    expect(room).toMatch(/chartBooks\(CHARTS\)/)
  })
})
