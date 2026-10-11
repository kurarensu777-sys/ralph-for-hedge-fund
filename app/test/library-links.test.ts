import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { audit, citations, importLines, importTarget, recallCitations } from '../server/library/links.ts'

// The link audit on temp trees: one fixture with exactly one of each fault, a clean one that must
// return [], and a mutation (a listed file deleted) that must turn into a dead-row.

const roots: string[] = []
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }) })

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'lib-links-'))
  roots.push(root)
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(root, rel, '..'), { recursive: true })
    writeFileSync(join(root, rel), text)
  }
  return root
}

const SHELVES = [
  { id: 'fund', title: 'Fund', dept: 'HQ', roots: ['lib/fund'] },
  { id: 'app', title: 'App', dept: 'Build', roots: ['app/library'] },
]
const idx = (...names: string[]) => `# S\n\n| Book | Read when |\n|---|---|\n${names.map(n => `| \`${n}\` | about to do ${n} |`).join('\n')}\n`
const recall = (...cites: string[]) => `# Law\n\n## Recall\n\n| The moment | Read |\n|---|---|\n${cites.map(c => `| before x | \`${c}\` |`).join('\n')}\n\n## After\n\n`

/** a tree with no faults: every book listed and reached, every row and citation resolves */
const CLEAN: Record<string, string> = {
  'CLAUDE.md': recall('lib/fund/craft/alpha.md', 'lib/fund/craft/law.md', 'memory/<series>/<book>.md') + 'not recall: `lib/missing.md`\n',
  'app/CLAUDE.md': recall('library/one.md'),
  'lib/fund/craft/law.md': '# Law',
  'lib/fund/craft/_series.md': idx('alpha.md', 'beta.md', 'law.md'),
  'lib/fund/craft/alpha.md': '# Alpha\n\nsee `beta.md`',
  'lib/fund/craft/beta.md': '# Beta\n\nsee `beta.md` (itself) and [alpha](alpha.md)',
  'app/library/_series.md': idx('one.md'),
  'app/library/one.md': '# One',
}
const AGENTS = [{ id: 'fund', boot: ['lib/fund/craft/alpha.md'] }]

describe('link audit', () => {
  it('finds exactly one of each fault', () => {
    const root = tree({
      ...CLAUDE_FAULTY(),
      'lib/fund/craft/law.md': '# Law',
      'lib/fund/craft/_series.md': idx('alpha.md', 'beta.md', 'law.md', 'omega.md', 'ghost.md'),
      'lib/fund/craft/alpha.md': '# Alpha\n\nsee `beta.md`',
      'lib/fund/craft/beta.md': '# Beta',
      'lib/fund/craft/gamma.md': '# Gamma, on no row',
      'lib/fund/craft/omega.md': '# Omega, listed and cited by nothing but itself: `omega.md`',
      'lib/fund/loose/delta.md': '# Delta, in a folder with no index',
      'app/library/_series.md': idx('one.md'),
      'app/library/one.md': '# One',
    })
    const agents = [{ id: 'fund', boot: ['lib/fund/craft/gamma.md', 'lib/fund/gone.md'] }]
    const rows = audit(root, SHELVES, agents)
    expect(rows.map(r => [r.fault, r.path, r.target])).toEqual([
      ['dead-boot', 'app/agents/fund.md', 'lib/fund/gone.md'],   // the roster file that boots it
      ['dead-recall', 'CLAUDE.md', 'lib/fund/nope.md'],
      ['dead-row', 'lib/fund/craft/_series.md', 'ghost.md'],
      ['no-index', 'lib/fund/loose/', null],
      ['unlisted', 'lib/fund/craft/gamma.md', null],
      ['unreached', 'lib/fund/craft/omega.md', null],
    ])
    expect(rows.find(r => r.fault === 'dead-boot')?.agent).toBe('fund')
    expect(rows.find(r => r.fault === 'unreached')).toMatchObject({ shelf: 'fund', book: 'lib/fund/craft/omega.md' })
    expect(rows.find(r => r.fault === 'no-index')?.shelf).toBe('fund')
  })

  it('a clean tree returns []', () => {
    expect(audit(tree(CLEAN), SHELVES, AGENTS)).toEqual([])
  })

  it('a boot entry naming a real series index is no fault; a missing one is dead-boot (B-0080)', () => {
    const agents = [{ id: 'dash:x', boot: ['lib/fund/craft/_series.md', 'lib/fund/craft/alpha.md', 'lib/fund/nothing/_series.md'] }]
    const rows = audit(tree(CLEAN), SHELVES, agents)
    expect(rows.map(r => [r.fault, r.target, r.agent])).toEqual([['dead-boot', 'lib/fund/nothing/_series.md', 'dash:x']])
  })

  it('a booted series index reaches the books it lists, as a Recall citation of it would', () => {
    const root = tree({ ...CLEAN, 'lib/fund/solo/_series.md': idx('only.md'), 'lib/fund/solo/only.md': '# Only, cited by nothing' })
    expect(audit(root, SHELVES, AGENTS).map(r => [r.fault, r.path])).toEqual([['unreached', 'lib/fund/solo/only.md']])
    expect(audit(root, SHELVES, [...AGENTS, { id: 'dash:x', boot: ['lib/fund/solo/_series.md'] }])).toEqual([])
  })

  it('mutation: delete a listed file and a dead-row appears', () => {
    const root = tree(CLEAN)
    expect(audit(root, SHELVES, AGENTS)).toEqual([])
    unlinkSync(join(root, 'lib/fund/craft/beta.md'))
    const rows = audit(root, SHELVES, AGENTS)
    expect(rows).toContainEqual({ fault: 'dead-row', path: 'lib/fund/craft/_series.md', target: 'beta.md', shelf: 'fund', book: null })
  })

  it('a folder citation or a <placeholder> reaches the books under it', () => {
    const root = tree({ ...CLEAN, 'CLAUDE.md': recall('lib/fund/craft/alpha.md', 'lib/<shelf>/', 'app/library/_series.md') })
    // law.md is reached through lib/<shelf>/ and one.md through its series index
    expect(audit(root, SHELVES, AGENTS)).toEqual([])
  })

  it('an @import that loads nothing is a dead-import; one that resolves from the importing file is not', () => {
    // the 2026-09-25 relayout moved files one folder deeper and left their @imports dangling
    const root = tree({
      ...CLEAN,
      'app/CLAUDE.md': recall('library/one.md') + '@library/one.md\n',
      'lib/fund/craft/law.md': '# Law\n\n@../../../app/library/one.md\n@../../../platform/gone/CLAUDE.md\n\n```\n@fenced/is/not/an/import.md\n```\n',
      'lib/fund/craft/beta.md': '# Beta\n\nsee `beta.md` and [alpha](alpha.md)\n@alpha.md\n@<template>/x.md\n',
    })
    expect(audit(root, SHELVES, AGENTS).map(r => [r.fault, r.path, r.target])).toEqual([
      ['dead-import', 'lib/fund/craft/law.md', '../../../platform/gone/CLAUDE.md'],
    ])
  })

  it('mutation: a CLAUDE.md whose @import target is deleted turns into a dead-import', () => {
    const root = tree({ ...CLEAN, 'app/CLAUDE.md': recall('library/one.md') + '@library/one.md\n' })
    expect(audit(root, SHELVES, AGENTS)).toEqual([])
    unlinkSync(join(root, 'app/library/one.md'))
    expect(audit(root, SHELVES, AGENTS).map(r => [r.fault, r.path, r.target])).toContainEqual(['dead-import', 'app/CLAUDE.md', 'library/one.md'])
  })

  it('import lines: only a line starting with @, outside a fence; ~/ resolves from home', () => {
    expect(importLines('x @not\n@a.md\n  @indented\n```\n@b.md\n```\n~~~\n@c.md\n~~~\n@d/e.md trailing')).toEqual([[2, 'a.md'], [10, 'd/e.md']])
    expect(importTarget('R', 'x/y/CLAUDE.md', '~/n.md', 'H')).toBe(join('H', 'n.md'))
    expect(importTarget('R', 'x/y/CLAUDE.md', '../z.md', 'H')).toBe(join('R', 'x', 'z.md'))
  })

  it('reads only the Recall section, and only its table rows', () => {
    const text = '# X\n`a.md`\n## Recall\n\nprose `b.md`\n| m | `c.md` + `d/e.md` |\n### Recall sub\n| m | [f](f.md) |\n## Next\n| m | `g.md` |\n'
    expect(recallCitations(text)).toEqual(['c.md', 'd/e.md', 'f.md'])
    expect(citations('see `x.md`, `https://h/y.md` and `lib/<v>/`')).toEqual(['x.md', 'lib/<v>/'])
  })
})

function CLAUDE_FAULTY(): Record<string, string> {
  return {
    'CLAUDE.md': recall('lib/fund/craft/alpha.md', 'lib/fund/nope.md', 'lib/fund/loose/delta.md', 'lib/fund/craft/law.md', 'memory/<series>/<book>.md')
      + 'outside Recall: `lib/fund/craft/omega.md` does not reach it\n',
    'app/CLAUDE.md': recall('library/one.md'),
  }
}
