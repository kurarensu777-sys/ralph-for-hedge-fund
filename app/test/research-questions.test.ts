import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { firstRow, questionsFor, questionsOf } from '../server/research/questions.ts'
import { blocksOf, countsOf, spansOf } from '../src/rooms/research/qmd.ts'

// The Research room's Questions block (B-0524): a nine-section notebook read into each section's question, figures
// and tables, and its S7 gates table; a notebook without the sections reads null (a legacy study draws nothing).

const md = (source: string) => ({ cell_type: 'markdown', source: source.split(/(?<=\n)/) })
const head = (id: string, name: string, q?: string) => md(`## ${id} · ${name}\n\n${q ? `| question | gate |\n|---|---|\n| ${q} | the rule to the next |\n` : ''}`)
const fig = (tag: string, png: string | null = 'AAAA') => ({
  cell_type: 'code', source: [], metadata: { tags: [tag] },
  outputs: png ? [{ output_type: 'display_data', data: { 'image/png': png, 'text/plain': '<Figure>' } }] : [],
})
const table = (text: string) => ({ cell_type: 'code', source: [], metadata: {}, outputs: [{ output_type: 'display_data', data: { 'text/markdown': text.split(/(?<=\n)/), 'text/plain': 'x' } }] })

/** S0..S7 and the appendix; S2 has a figure, S3 two figures and a table, S4 no figure at all, S5 a table, S6 one figure */
function nine() {
  return {
    cells: [
      md('# Title\n\n## S0 · Summary\n\nthe card'),
      md('## S1 · Setup\n\n### S1.1 · Parameters'),
      table('| a | b |\n|---|---|\n| 1 | 2 |\n'),            // an S1 table: not shown
      head('S2', 'Data checks', 'Do the books reconcile?'),
      fig('fig:s2-quarters'),
      head('S3', 'Core result', 'Does the chosen rule beat a T-bill after costs?'),
      fig('fig:s3-select'),
      fig('fig:s3-equity'),
      table('| Rule | Net |\n|---|---|\n| hold | **+5.5%** |\n'),
      head('S4', 'Robustness', 'Does the choice survive more cost?'),
      head('S5', 'Risk and diagnostics', 'How bad can a bad stretch be?'),
      table('| Day | Loss |\n|---|---|\n| `2026-01-02` | -3% |\n'),
      head('S6', 'Decision', 'What clip does the rule allow?'),
      fig('fig:s6-ladder'),
      md('## S7 · Verdict\n\nThe gates.'),
      table('The conclusion is below.\n'),
      table('| Gate | Section | Reading | Verdict |\n|---|---|---|---|\n| G0 Books verified | S2 | 13/13 | **PASS** |\n| G1 Beats T-bill | S3 | +5% | **FAIL** |\n'),
      md('## A · Appendix\n\nbooks'),
      table('| not | shown |\n|---|---|\n| 1 | 2 |\n'),   // after S7's chapter closed: no section owns it
    ],
  }
}

describe('questionsOf: a nine-section notebook', () => {
  const q = questionsOf(nine())!
  it('reads S2 to S6 in order with the heading name and the heading table\'s first row', () => {
    expect(q.sections.map(s => s.id)).toEqual(['S2', 'S3', 'S4', 'S5', 'S6'])
    expect(q.sections[1]).toMatchObject({ name: 'Core result', question: 'Does the chosen rule beat a T-bill after costs?', ruleHead: 'gate', rule: 'the rule to the next' })
  })
  it('gives each figure its tag and cell, and a section with no figure an empty list', () => {
    expect(q.sections.map(s => s.figs.map(f => f.fig))).toEqual([['fig:s2-quarters'], ['fig:s3-select', 'fig:s3-equity'], [], [], ['fig:s6-ladder']])
    expect(q.sections[1].figs.map(f => f.cell)).toEqual([6, 7])
  })
  it('keeps each section\'s own text/markdown tables, none of S1\'s, the appendix\'s or S7\'s', () => {
    expect(q.sections.map(s => s.tables.length)).toEqual([0, 1, 0, 1, 0])
    expect(countsOf(q.sections)).toEqual({ questions: 5, figures: 4, tables: 2 })
  })
  it('takes the S7 gates table as the verdict', () => {
    expect(q.verdict?.md).toContain('G1 Beats T-bill')
    expect(q.verdict?.md).not.toContain('The conclusion')
  })
  it('skips a tagged cell with no PNG output, and a tag it has already drawn', () => {
    const nb = nine()
    nb.cells.splice(5, 0, fig('fig:s2-empty', null), fig('fig:s2-quarters'))
    expect(questionsOf(nb)!.sections[0].figs.map(f => f.fig)).toEqual(['fig:s2-quarters'])
  })
  it('a section heading with no table has no question, not a guess', () => {
    const nb = nine()
    nb.cells[3] = head('S2', 'Data checks')
    expect(questionsOf(nb)!.sections[0]).toMatchObject({ question: null, rule: null })
  })
})

describe('questionsOf: a notebook without the nine sections', () => {
  it('a legacy notebook reads null', () => {
    expect(questionsOf({ cells: [md('# Old study\n\nsome prose'), table('| a |\n|---|\n| 1 |\n')] })).toBeNull()
    expect(questionsOf({})).toBeNull()
  })
  it('one section missing reads null', () => {
    const nb = nine()
    nb.cells = nb.cells.filter(c => !(c.source as string[]).join('').startsWith('## S4'))
    expect(questionsOf(nb)).toBeNull()
  })
  it('a "### S2.1" subheading is no section', () => {
    expect(questionsOf({ cells: [md('### S2.1 x'), md('### S3 x')] })).toBeNull()
  })
})

describe('firstRow', () => {
  it('splits on an unescaped pipe only', () => {
    expect(firstRow('| question | gate |\n|---|---|\n| a \\| b | c |\n')).toEqual({ head: ['question', 'gate'], row: ['a | b', 'c'] })
  })
  it('a header with no data row is no row', () => {
    expect(firstRow('| question | gate |\n|---|---|\n')).toBeNull()
  })
})

describe('GET /api/research/questions: the file read', () => {
  const root = mkdtempSync(join(tmpdir(), 'fund-questions-'))
  mkdirSync(join(root, 'studies'))
  writeFileSync(join(root, 'studies', 'a.ipynb'), JSON.stringify(nine()))
  writeFileSync(join(root, 'studies', 'old.ipynb'), JSON.stringify({ cells: [md('# old')] }))
  afterAll(() => rmSync(root, { recursive: true, force: true }))
  it('reads a nine-section notebook and a legacy one, and refuses a path outside the folder', () => {
    expect(questionsFor(root, 'studies/a.ipynb').questions?.sections).toHaveLength(5)
    expect(questionsFor(root, 'studies/old.ipynb').questions).toBeNull()
    expect(() => questionsFor(root, '../x.ipynb')).toThrow()
    expect(() => questionsFor(root, 'studies/missing.ipynb')).toThrow(/ENOENT/)
  })
})

describe('qmd: a notebook\'s markdown as blocks, drawn as nodes', () => {
  it('a table, its caption line and a paragraph', () => {
    const b = blocksOf('A caption\nsecond line\n\n| Rule | Net |\n|:--|--:|\n| hold | **+5%** |\n| stop | `-1%` |\n')
    expect(b).toEqual([
      { kind: 'text', text: 'A caption second line' },
      { kind: 'table', head: ['Rule', 'Net'], rows: [['hold', '**+5%**'], ['stop', '`-1%`']] },
    ])
  })
  it('a pipe line with no separator row is text, never a table', () => {
    expect(blocksOf('| a | b |\n| 1 | 2 |\n')[0].kind).toBe('text')
  })
  it('bold and code marks, and the rest as text', () => {
    expect(spansOf('x **PASS** y `z`')).toEqual([{ kind: 'text', text: 'x ' }, { kind: 'b', text: 'PASS' }, { kind: 'text', text: ' y ' }, { kind: 'code', text: 'z' }])
  })
})
