import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CATEGORIES, categoryOf } from '../src/ui/categories.ts'

// src/ui/categories.ts is the ONE source of the agent-category colours. styles.css mirrors them as
// --c-<id> tokens for CSS that has no inline --c, and nothing else may carry the hex.

const SRC = resolve(__dirname, '../src')
const files = (d: string): string[] => readdirSync(d).flatMap(f => {
  const p = join(d, f)
  return statSync(p).isDirectory() ? files(p) : /\.(tsx?|css)$/.test(f) ? [p] : []
})

describe('agent categories: one colour source', () => {
  it('styles.css --c-<id> tokens equal categories.ts', () => {
    const css = readFileSync(join(SRC, 'styles.css'), 'utf8')
    for (const c of Object.values(CATEGORIES)) {
      const m = css.match(new RegExp(`--c-${c.id}:\\s*(#[0-9a-f]{6})`, 'i'))
      expect(m?.[1]?.toLowerCase(), `--c-${c.id}`).toBe(c.color.toLowerCase())
    }
  })

  it('no other file hard-codes a category colour', () => {
    // fund's gold is also the app --accent, so it is exempt; the others are category-only
    const hexes = Object.values(CATEGORIES).filter(c => c.id !== 'fund').map(c => c.color.toLowerCase())
    const bad: string[] = []
    for (const f of files(SRC)) {
      const rel = relative(SRC, f).replace(/\\/g, '/')
      if (rel === 'ui/categories.ts' || rel === 'styles.css') continue
      const s = readFileSync(f, 'utf8').toLowerCase()
      for (const h of hexes) if (s.includes(h)) bad.push(`${rel}: ${h}`)
    }
    expect(bad).toEqual([])
  })

  it('categoryOf routes dashboards and unknowns', () => {
    expect(categoryOf('dash:vol').id).toBe('dashboards')
    expect(categoryOf({ id: 'x', kind: 'dashboard' }).id).toBe('dashboards')
    expect(categoryOf('research').id).toBe('research')
    expect(categoryOf({ id: 'qa', dept: 'Execution' }).id).toBe('execution')
    expect(categoryOf('nobody').id).toBe('fund')
  })
})
