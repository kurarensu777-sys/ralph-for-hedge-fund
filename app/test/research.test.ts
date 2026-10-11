import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { FORMATS, FORMAT_IDS, KINDS, STUDY_MIME, isFormat, manifestProblems, metricsOf, type Manifest, type Study } from '../shared/research.ts'
import { fmtMetric, toneOf } from '../src/rooms/research/format.ts'
import { lastCommits, listNotebooks, manifestOf, nameOf, notebookOfCmd, readStudy, renameMap, resolveId, runsByNotebook, studies } from '../server/research/scan.ts'
import { groupRuns } from '../server/lab/runs.ts'
import { prepare } from '../src/rooms/research/prepare.ts'

// the manifest shape the template's last S7 cell builds (platform/research/studies/_template-study.ipynb)
const M: Manifest = {
  schema: 'fund.study/1', id: '2026-09-a', kind: 'strategy', desk: 'lab/research', title: 'Sell the hike tail', question: 'is the tail overpriced?',
  status: 'draft', run: { executed: '2026-09-27T15:00Z', kernel: 'ccvenv' },
  window: { from: '1990-06-15T00:00:00Z', to: '2026-09-11T00:00:00Z', hours: 322056, regimes: 12 },
  verify: { suite: 'study_checks', passed: 11, total: 11 }, headline: null, components: [],
  gates: [{ id: 'g1', section: 'S3', name: 'volatility term above 0', reading: '+0.15%', threshold: '> 0', verdict: 'FAIL' }],
  sections: [{ id: 'S0', status: 'ok' }], figures: [{ id: 'fig:s3-pnl', section: 'S3' }],
  verdict: { word: 'NO SIZE', why: 'gates 1-2 fail', next_bet: 'none' }, caveats: ['one window'],
}
const full = (f: keyof typeof FORMATS) => Object.fromEntries(metricsOf(f).map(x => [x.key, 1])) as Record<string, number | null>
const metrics = full('carry')
const code = (outputs: unknown[] = [], n: number | null = 1) => ({ cell_type: 'code', execution_count: n, source: ['x'], outputs })
const md = (s: string) => ({ cell_type: 'markdown', source: [s] })
const out = (m: unknown) => ({ output_type: 'display_data', data: { [STUDY_MIME]: m, 'text/plain': ['study manifest fund.study/1'] }, metadata: {} })

describe('the fund.study/1 manifest', () => {
  it('the template\'s shape is valid', () => expect(manifestProblems(M)).toEqual([]))
  it('refuses a wrong schema, an unknown kind, a gate outside S0-S7 and a bad figure id', () => {
    expect(manifestProblems({ ...M, schema: 'fund.study/0' })[0]).toMatch(/schema/)
    expect(manifestProblems({ ...M, kind: 'backtest' })[0]).toMatch(/kind/)
    expect(manifestProblems({ ...M, gates: [{ ...M.gates[0], section: 'S9' }] })[0]).toMatch(/S0-S7/)
    expect(manifestProblems({ ...M, figures: [{ id: 'pnl', section: 'S3' }] })).toContain('a figure id is not fig:s<n>-<name>')
    expect(manifestProblems({ ...M, figures: [{ id: 'fig:s3-a', section: 'S3' }, { id: 'fig:s3-a', section: 'S3' }] })).toContain('figure ids repeat')
  })
  it('refuses no window, no verdict word, and verify above its total', () => {
    expect(manifestProblems({ ...M, window: undefined })).toContain('window needs from and to')
    expect(manifestProblems({ ...M, verdict: { word: '' } })).toContain('verdict needs a word')
    expect(manifestProblems({ ...M, verify: { passed: 12, total: 11 } })[0]).toMatch(/above total/)
  })
  it('a format is optional, but it comes with its metrics block, every key of it, a null carrying its reason', () => {
    expect(manifestProblems({ ...M, format: 'carry', metrics })).toEqual([])
    expect(manifestProblems({ ...M, metrics })).toContain('metrics without a format: name the format they follow')
    expect(manifestProblems({ ...M, format: 'carry' })).toContain('format carry without its metrics block')
    expect(manifestProblems({ ...M, format: 'momentum', metrics })[0]).toMatch(/format "momentum" is not/)
    const { funding_ann_pct: _, ...rest } = metrics
    expect(manifestProblems({ ...M, format: 'carry', metrics: rest })).toContain('metric funding_ann_pct missing')
    expect(manifestProblems({ ...M, format: 'carry', metrics: { ...metrics, dsr: null } })).toContain('metric dsr is null with no reason in na')
    expect(manifestProblems({ ...M, format: 'carry', metrics: { ...metrics, dsr: null }, na: { dsr: 'one trial' } })).toEqual([])
    expect(manifestProblems({ ...M, format: 'carry', metrics: { ...metrics, sharpe: 0 } })).toEqual([])
  })
  it('each format is checked against its OWN list: carry metrics do not satisfy evidence', () => {
    for (const f of FORMAT_IDS) expect(manifestProblems({ ...M, format: f, metrics: full(f) })).toEqual([])
    expect(manifestProblems({ ...M, format: 'evidence', metrics })).toContain('metric t_stat missing')
  })
  it('any study may take any format (B-0441): every kind validates under every format, and a P&L format carries the risk-adjusted set', () => {
    for (const kind of KINDS) for (const f of FORMAT_IDS) expect(manifestProblems({ ...M, kind, format: f, metrics: full(f) })).toEqual([])
    for (const f of ['carry', 'directional', 'short_vol'] as const) {
      const keys = metricsOf(f).map(x => x.key)
      for (const k of ['sortino', 'calmar', 'max_dd_pct', 'max_dd_days', 'psr', 'dsr']) expect(keys).toContain(k)
    }
    expect(metricsOf('directional').map(x => x.key)).toEqual(expect.arrayContaining(['hit_rate_pct', 'profit_factor', 'expectancy_bps', 'turnover_ann']))
  })
  it('mft is no format (B-0502): five formats, and directional takes its 29 keys in platform report.FORMATS order, sharpe the lead', () => {
    expect(FORMAT_IDS).toEqual(['carry', 'directional', 'short_vol', 'rel_value', 'evidence'])
    expect('mft' in FORMATS).toBe(false)
    expect(isFormat('mft')).toBe(false)
    expect(manifestProblems({ ...M, format: 'mft', metrics })[0]).toMatch(/format "mft" is not carry|directional|short_vol|rel_value|evidence/)
    const keys = metricsOf('directional').map(x => x.key)
    expect(keys).toHaveLength(29)
    expect(keys.slice(0, 12)).toEqual(['ann_return_pct', 'excess_vs_hurdle_pct', 'ann_vol_pct', 'sharpe', 'sortino', 'calmar', 'psr', 'dsr', 'max_dd_pct', 'max_dd_days', 'n_periods', 'periods_per_year'])
    expect(keys.slice(12)).toEqual(['total_return_pct', 'n_trades', 'trades_per_day', 'hit_rate_pct', 'profit_factor', 'expectancy_bps', 'win_loss_ratio', 'avg_hold_h', 'exposure_pct',
      'turnover_ann', 'fees_pct_of_gross', 'worst_period_pct', 'gross_edge_bps', 'cost_bps', 'breakeven_cost_bps', 'capacity_usd', 'beta_to_underlying'])
    expect(FORMATS.directional.lead).toBe('sharpe')
  })
  it('tags (B-0502): optional {style, pace}; the shape and the closed words are checked, a pace is never derived here', () => {
    expect(manifestProblems(M)).toEqual([])
    expect(manifestProblems({ ...M, tags: { style: 'systematic', pace: 'intraday' } })).toEqual([])
    expect(manifestProblems({ ...M, tags: { style: 'discretionary' } })).toEqual([])
    expect(manifestProblems({ ...M, tags: { pace: 'hold' } })).toEqual([])
    expect(manifestProblems({ ...M, tags: {} })).toEqual(['tags must be {style, pace}, not empty'])
    expect(manifestProblems({ ...M, tags: 'systematic' })).toEqual(['tags must be {style, pace}, not empty'])
    expect(manifestProblems({ ...M, tags: { style: 'mft' } })).toEqual(['tags.style "mft" is not systematic|discretionary'])
    expect(manifestProblems({ ...M, tags: { pace: 'fast' } })).toEqual(['tags.pace "fast" is not intraday|swing|hold'])
    expect(manifestProblems({ ...M, tags: { style: 'systematic', speed: 1, zed: 2 } })).toEqual(['tags keys the book does not define: speed, zed'])
    // pace is a reading, not a rule the room enforces: platform checks it against the metrics
    expect(manifestProblems({ ...M, format: 'directional', metrics: { ...full('directional'), avg_hold_h: 500 }, tags: { pace: 'intraday' } })).toEqual([])
  })
  it('every format has a lead metric of its own, and no key twice', () => {
    for (const f of FORMAT_IDS) {
      const keys = metricsOf(f).map(x => x.key)
      expect(keys).toContain(FORMATS[f].lead)
      expect(new Set(keys).size).toBe(keys.length)
    }
  })
})

describe('a metric as shown', () => {
  const get = (f: keyof typeof FORMATS, k: string) => metricsOf(f).find(x => x.key === k)!
  it('by unit: signed where higher is better, whole counts, dollars, basis points', () => {
    expect(fmtMetric(get('carry', 'ann_return_pct'), 25.4)).toBe('+25.40%')
    expect(fmtMetric(get('carry', 'ann_vol_pct'), 14.1)).toBe('14.10%')
    expect(fmtMetric(get('carry', 'max_dd_pct'), -6.8)).toBe('-6.80%')
    expect(fmtMetric(get('carry', 'n_periods'), 1786)).toBe('1,786')
    expect(fmtMetric(get('rel_value', 'capacity_usd'), 1_500_000)).toBe('USD 1.50M')
    expect(fmtMetric(get('rel_value', 'net_edge_bps'), 12.34)).toBe('+12.3 bp')
    expect(fmtMetric(get('carry', 'sharpe'), null)).toBeNull()
    expect(fmtMetric(get('directional', 'trades_per_day'), 1.2)).toBe('1.20')
    expect(fmtMetric(get('directional', 'n_trades'), 63)).toBe('63')
    expect(fmtMetric(get('directional', 'breakeven_cost_bps'), 2.7)).toBe('+2.7 bp')
    expect(fmtMetric(get('directional', 'capacity_usd'), 25000)).toBe('USD 25,000')
    // one decimal rule per unit: 126% and 92.22% side by side in Compare read alike
    expect(fmtMetric(get('carry', 'min_liq_distance_pct'), 126)).toBe('126.00%')
    expect(fmtMetric(get('carry', 'min_liq_distance_pct'), 92.22)).toBe('92.22%')
    expect(fmtMetric(get('rel_value', 'net_edge_bps'), 123.45)).toBe('+123.5 bp')
  })
  it('colours only a metric where higher is better', () => {
    expect(toneOf(get('carry', 'sharpe'), -0.4)).toBe('fail')
    expect(toneOf(get('carry', 'ann_vol_pct'), 30)).toBe('')
  })
})

describe('finding the manifest in a notebook', () => {
  it('none (legacy), when no output carries it', () => expect(manifestOf({ cells: [md('# x'), code()] }).state).toBe('none'))
  it('ok wherever S7 put it: an Appendix code cell may follow', () => {
    const s = manifestOf({ cells: [code(), code([out(M)]), md('## A · Appendix'), code()] })
    expect(s.state).toBe('ok')
    expect(s.state === 'ok' && s.cell).toBe(1)
  })
  it('many, when two cells carry one (the book: exactly one)', () => expect(manifestOf({ cells: [code([out(M)]), code([out(M)])] }).state).toBe('many'))
  it('invalid, naming why', () => {
    const s = manifestOf({ cells: [code([out({ ...M, verdict: {} })])] })
    expect(s.state).toBe('invalid')
    expect(s.state === 'invalid' && s.problems).toContain('verdict needs a word')
  })
  it('a manifest a writer stringified is read the same', () => expect(manifestOf({ cells: [code([out(JSON.stringify(M))])] }).state).toBe('ok'))
})

describe('names, commands and paths', () => {
  it('a [tag] prefix is split off the name', () => {
    expect(nameOf('[latest] 2026-09-semis-pair-thesis.ipynb')).toEqual({ name: '2026-09-semis-pair-thesis', tag: 'latest' })
    expect(nameOf('cashcarry_acme.ipynb')).toEqual({ name: 'cashcarry_acme', tag: null })
  })
  it('the notebook a loop command ran, as the real ledgers spell it', () => {
    expect(notebookOfCmd('..\\..\\.venv\\Scripts\\python -m jupyter nbconvert --to notebook --execute --stdout --ExecutePreprocessor.kernel_name=ccvenv --ExecutePreprocessor.timeout=3600 2026-09-sofr-tail-thesis.ipynb')).toBe('2026-09-sofr-tail-thesis.ipynb')
    expect(notebookOfCmd('python -m jupyter nbconvert --to notebook --execute --stdout studies/2026-09-vol-premium.ipynb')).toBe('2026-09-vol-premium.ipynb')
    expect(notebookOfCmd('python -m fundplat.jobs.x')).toBeNull()
  })
  it('refuses an id outside the research folder', () => {
    const root = join(tmpdir(), 'research-root')
    expect(() => resolveId(root, '../app/secret.ipynb')).toThrow()
    expect(() => resolveId(root, 'studies/x.md')).toThrow()
    expect(resolveId(root, 'studies/x.ipynb')).toBe(join(root, 'studies', 'x.ipynb'))
  })
  it('the newest commit per file from one git log', () => {
    const log = '\x01aaa1111 2026-09-27\nresearch/studies/a.ipynb\n\n\x01bbb2222 2026-09-25\nresearch/studies/a.ipynb\nresearch/studies/b.ipynb\n'
    const m = lastCommits(log)
    expect(m.get('research/studies/a.ipynb')).toEqual({ hash: 'aaa1111', date: '2026-09-27' })
    expect(m.get('research/studies/b.ipynb')).toEqual({ hash: 'bbb2222', date: '2026-09-25' })
  })
})

describe('a research folder, end to end', () => {
  const root = mkdtempSync(join(tmpdir(), 'research-'))
  afterAll(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'studies'))
  mkdirSync(join(root, 'other'))
  mkdirSync(join(root, 'archive'))
  mkdirSync(join(root, '__pycache__'))
  writeFileSync(join(root, 'studies', '2026-09-a.ipynb'), JSON.stringify({ metadata: { kernelspec: { name: 'ccvenv' } }, cells: [md('# a'), code([{ output_type: 'display_data', data: { 'image/png': 'x' } }]), code([out(M)])] }))
  writeFileSync(join(root, 'studies', 'old.ipynb'), JSON.stringify({ metadata: { kernelspec: { name: 'python3' } }, cells: [code([], null)] }))
  writeFileSync(join(root, 'studies', 'broken.ipynb'), '{not json')
  writeFileSync(join(root, 'studies', '_template-study.ipynb'), JSON.stringify({ cells: [code([out(M)])] }))
  writeFileSync(join(root, 'studies', 'notes.md'), '# not a notebook')
  writeFileSync(join(root, 'other', 'acme.ipynb'), JSON.stringify({ cells: [] }))
  writeFileSync(join(root, 'archive', '2026-09-crypto-draft.ipynb'), JSON.stringify({ metadata: { kernelspec: { name: 'ccvenv' } }, cells: [md('# draft'), code([out(M)])] }))

  it('lists notebooks only, one folder deep, never a _template', () => expect(listNotebooks(root)).toEqual(['archive/2026-09-crypto-draft.ipynb', 'other/acme.ipynb', 'studies/2026-09-a.ipynb', 'studies/broken.ipynb', 'studies/old.ipynb']))
  it('reads counts, kernel and manifest; a broken file is named, never fatal', () => {
    const a = readStudy(root, 'studies/2026-09-a.ipynb')
    expect(a.cells).toEqual({ markdown: 1, code: 2, executed: 2, images: 1 })
    expect(a.manifest.state).toBe('ok')
    const old = readStudy(root, 'studies/old.ipynb')
    expect(old.kernel).toBe('python3')
    expect(old.cells.executed).toBe(0)
    expect(readStudy(root, 'studies/broken.ipynb').error).toMatch(/does not parse/)
  })
  it('joins a loop run to the notebook its command ran', () => {
    const rows = [{ run: 'research-001', stage: 'result', ts: '2026-09-27T13:17:36Z', cmd: 'python -m jupyter nbconvert --execute 2026-09-a.ipynb', headline: 'h', graded: { x: { actual: 1, band: '0..2', verdict: 'hit' } }, comparator: { name: 'T-bill', value: 4.11 } }]
    const runs = groupRuns('platform/lab/research', rows, Date.parse('2026-09-28T00:00:00Z'))
    const p = studies(root, runs, null, 'research/')
    const a = p.studies.find(s => s.id === 'studies/2026-09-a.ipynb')!
    expect(a.loop.map(l => l.run)).toEqual(['research-001'])
    expect(a.loop[0].graded.x.verdict).toBe('hit')
    expect(a.commit).toBeNull()
    expect(p.studies.find(s => s.id === 'studies/old.ipynb')!.loop).toEqual([])
    expect(runsByNotebook(runs).size).toBe(1)
  })
  it('an archived notebook is read like a study: its own group, its manifest and loop runs, no labels (B-0728)', () => {
    const rows = [{ run: 'research-002', stage: 'result', ts: '2026-09-27T13:17:36Z', cmd: 'python -m jupyter nbconvert --execute 2026-09-crypto-draft.ipynb', headline: 'h', graded: {} }]
    const p = studies(root, groupRuns('platform/lab/research', rows, Date.parse('2026-09-28T00:00:00Z')), null, 'research/')
    const d = p.studies.find(s => s.id === 'archive/2026-09-crypto-draft.ipynb')!
    expect([d.group, d.manifest.state, d.loop.map(l => l.run)]).toEqual(['archive', 'ok', ['research-002']])
    expect(d.labels.markets).toEqual([])      // the file name says crypto; an archived study carries no label
    expect(d.labels.format).toBeNull()
  })
  it('a missing folder reads as not there, not as empty', () => expect(studies(join(root, 'nope'), [], null, '').exists).toBe(false))
})

describe('the reader', () => {
  it('turns text/markdown outputs into HTML and drops the manifest JSON, keeping everything else', () => {
    const nb = prepare({ cells: [code([out(M), { output_type: 'display_data', data: { 'text/markdown': ['| a | b |\n|---|---|\n| 1 | 2 |'] } }, { output_type: 'stream', text: ['hi'] }])] })
    const [m, t, s] = nb.cells[0].outputs!
    expect(Object.keys(m.data!)).toEqual(['text/plain'])
    expect((t.data as any)['text/html'][0]).toContain('<table>')
    expect(s).toEqual({ output_type: 'stream', text: ['hi'] })
  })
})

describe('finding results', async () => {
  const { matches, matchesText, facet, verdictOf, NO_FILTER } = await import('../src/rooms/research/filter.ts')
  const study = (id: string, manifest: Study['manifest'], loop: Study['loop'] = []): Study => ({
    id: `studies/${id}.ipynb`, name: id, tag: null, group: 'studies', bytes: 1, mtime: 0,
    cells: { markdown: 0, code: 1, executed: 1, images: 0 }, kernel: 'ccvenv', error: null, manifest, loop, commit: null, labels: { markets: [], format: null, style: null, pace: null, from: { markets: null, format: null, style: null }, faults: [] },
  })
  const carry = study('pair', { state: 'ok', cell: 3, manifest: { ...M, title: 'Example pair', format: 'carry', metrics: { ...metrics, sharpe: 1.8 } } })
  const weak = study('weak', { state: 'ok', cell: 3, manifest: { ...M, title: 'Weak carry', desk: 'lab/vol', verdict: { word: 'SIZE 1x' }, format: 'carry', metrics: { ...metrics, sharpe: 0.4 } } })
  const legacy = study('sofr', { state: 'none' }, [{ key: 'k', desk: 'lab/research', run: 'research-001', kind: 'explore', stage: 'result', ts: null, headline: '+0.84% ann over the 3M bill', window: null, verify: null, graded: {}, comparator: null }])
  it('every word must appear, in any order, across title, verdict and the loop headline', () => {
    expect(matchesText(carry, 'example pair')).toBe(true)
    expect(matchesText(carry, 'pair example')).toBe(true)
    expect(matchesText(carry, 'example sofr')).toBe(false)
    expect(matchesText(legacy, '3m bill')).toBe(true)
    expect(matchesText(legacy, 'research-001')).toBe(true)
  })
  it('facets: a legacy study is found by its state word; desks and verdicts filter', () => {
    expect(verdictOf(legacy)).toBe('legacy')
    expect(facet([carry, weak, legacy], verdictOf).map(x => x.value).sort()).toEqual(['NO SIZE', 'SIZE 1x', 'legacy'])
    expect([carry, weak, legacy].filter(s => matches(s, { ...NO_FILTER, desks: ['lab/vol'] }))).toEqual([weak])
    expect([carry, weak, legacy].filter(s => matches(s, { ...NO_FILTER, verdicts: ['legacy'] }))).toEqual([legacy])
  })
  it('a metric threshold keeps only studies that carry the metric and clear it: an unknown is never a pass', () => {
    const f = { ...NO_FILTER, conds: [{ k: 'sharpe', op: '>=' as const, v: 1 }] }
    expect([carry, weak, legacy].filter(s => matches(s, f))).toEqual([carry])
    expect([carry, weak, legacy].filter(s => matches(s, { ...NO_FILTER, conds: [{ k: 'sharpe', op: '<=' as const, v: 1 }] }))).toEqual([weak])
    const nulled = study('n', { state: 'ok', cell: 1, manifest: { ...M, format: 'carry', metrics: { ...metrics, sharpe: null }, na: { sharpe: 'x' } } })
    expect(matches(nulled, f)).toBe(false)
  })
})

// the formats are filed twice: the research book (the Manifest and labels chapter names each format and
// its lead metric) and FORMATS (what the room reads). The book no longer lists every metric key (the
// 2026-10-03 fold kept the lead only), so this holds the ids and the leads; the keys are held by
// fundplat.quant.tests.test_report, which reads report.FORMATS against shared/research.ts.
describe('the formats: the book and the code agree', async () => {
  const { readFileSync } = await import('node:fs')
  const whole = readFileSync(join(__dirname, '..', 'library', 'research', 'research.md'), 'utf8')
  const at = whole.indexOf('## Manifest and labels')
  const end = whole.indexOf('\n## ', at + 1)
  const chapter = whole.slice(at, end < 0 ? undefined : end)
  const named = [...chapter.matchAll(/`([a-z_]+)` \((?:lead )?`([a-z0-9_]+)`\)/g)].map(m => [m[1], m[2]])
  it('the chapter is there', () => expect(at).toBeGreaterThan(-1))
  it('the book names exactly the code\'s formats, each with its lead', () => {
    expect(named.map(n => n[0]).sort()).toEqual([...FORMAT_IDS].sort())
    for (const [id, lead] of named) expect(lead, id).toBe(FORMATS[id as keyof typeof FORMATS].lead)
  })
})

describe('a ledger unit as a reader says it', async () => {
  const { unitText } = await import('../src/rooms/research/format.ts')
  it('pct_ann, pct and bp read as signs; anything unknown is shown as written', () => {
    expect(unitText(2.5, 'pct_ann')).toBe('2.5% ann')
    expect(unitText('4.11', 'pct')).toBe('4.11%')
    expect(unitText(12, 'bps')).toBe('12 bp')
    expect(unitText(3, 'rho')).toBe('3 rho')
    expect(unitText(3)).toBe('3')
  })
})

describe('a renamed notebook keeps its loop runs (B-0289)', () => {
  const run = (cmd: string) => ({ key: 'lab/research#research-001', desk: 'lab/research', run: 'research-001', kind: null, mechanic: null, preregistered: true, predicted: {}, window: null, verify: null, headline: '', metrics: {}, ts: 1, stage: 'result', rows: [{ cmd }] }) as any
  const doc = { renames: [{ old: 'a.ipynb', new: 'b.ipynb' }, { old: 'b.ipynb', new: 'c.ipynb' }, { old: 'x.ipynb', new: 'y.ipynb' }, { old: 'y.ipynb', new: 'x.ipynb' }] }
  it('follows a rename of a rename to its end, and stops a cycle', () => {
    const m = renameMap([doc, null, { renames: 'no' }, { renames: [{ old: 3, new: 'z' }, { old: 'same.ipynb', new: 'same.ipynb' }] }])
    expect(m.get('a.ipynb')).toBe('c.ipynb')
    expect(m.get('b.ipynb')).toBe('c.ipynb')
    expect(m.has('same.ipynb')).toBe(false)
    expect([m.get('x.ipynb'), m.get('y.ipynb')].every(v => v === 'x.ipynb' || v === 'y.ipynb')).toBe(true)
  })
  it('joins a run whose command names the OLD stem to the new notebook', () => {
    const cmd = 'python -m jupyter nbconvert --to notebook --execute --stdout studies/a.ipynb'
    expect(runsByNotebook([run(cmd)]).has('a.ipynb')).toBe(true)
    const withMap = runsByNotebook([run(cmd)], renameMap([doc]))
    expect(withMap.has('c.ipynb')).toBe(true)
    expect(withMap.has('a.ipynb')).toBe(false)
  })
  it('the check can fail: without the map the run stays on the dead stem', () => {
    const cmd = 'python -m jupyter nbconvert --to notebook --execute --stdout studies/a.ipynb'
    expect(runsByNotebook([run(cmd)], new Map()).has('c.ipynb')).toBe(false)
  })
})
