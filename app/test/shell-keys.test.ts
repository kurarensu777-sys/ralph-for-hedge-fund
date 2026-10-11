import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { KEYS } from '../src/shell/command.ts'

// The cockpit binds only a few keys, and the command bar lists them. This holds the two
// together: a key bound in the shell's handler that the Keys section does not list (or a listed
// key nobody binds) fails here.
const src = readFileSync(new URL('../src/shell/Shell.tsx', import.meta.url), 'utf8')
const handler = src.slice(src.indexOf('const onKey'), src.indexOf("window.addEventListener('keydown'"))

describe('the keys', () => {
  it('the shell has one key handler', () => {
    expect(src.match(/addEventListener\('keydown'/g)?.length).toBe(1)
    expect(handler.length).toBeGreaterThan(0)
  })

  it('every bound key is listed in the command bar, and every listed key is bound', () => {
    const bound = new Set([...handler.matchAll(/k === '([a-z]+)'/g)].map(m => (m[1] === 'escape' ? 'Esc' : `Ctrl ${m[1].toUpperCase()}`)))
    const listed = new Set(KEYS.flatMap(k => k.keys.split(' · ')))
    expect([...bound].sort()).toEqual([...listed].sort())
  })

  it('no Alt or Shift chord hides in the handler', () => {
    expect(handler).not.toMatch(/(?<!!)e\.altKey|e\.shiftKey|e\.metaKey/)
  })
})
