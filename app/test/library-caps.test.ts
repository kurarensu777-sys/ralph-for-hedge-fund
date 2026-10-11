import { readFileSync } from 'node:fs'
import { basename, dirname } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CAPS_FILE, caps, parseCaps } from '../server/library/caps.ts'
import { layersOf, workspaceChain } from '../server/library/layers.ts'

// B-0372 item 5: app/tools/context-caps.json is the ONE source of every cap; the cockpit reads it, never a copy.

describe('the caps', () => {
  it('read the live file: the cockpit and app/tools/context.py share one JSON', () => {
    expect(caps()).toMatchObject({ base: 6000, agent: 2000, boot: 375000, chapter: 4500, chapterTarget: 3750, book: 40000 })
    expect([basename(dirname(dirname(CAPS_FILE))), basename(dirname(CAPS_FILE)), basename(CAPS_FILE)]).toEqual(['app', 'tools', 'context-caps.json'])
    expect(JSON.parse(readFileSync(CAPS_FILE, 'utf8')).boot).toBe(caps().boot)
  })
  it('the layers an agent can load add up to the share of the context circle the owner set (40% of 1M)', () => {
    const j = JSON.parse(readFileSync(CAPS_FILE, 'utf8')), c = caps()
    // the longest chain: platform/, then platform/dashboards/, then a screen's runbook; a CLAUDE.md with no cap of its own takes `workspace`
    const ws = (f: string) => c.workspaceNamed[f] ?? c.workspace
    const chain = ws('platform/CLAUDE.md') + ws('platform/dashboards/CLAUDE.md') + c.screen
    expect(c.base + c.agent + c.boot + chain).toBeLessThanOrEqual(j.window * j.share)
    expect(j.window * j.share).toBe(400000)
  })
  it('a missing or non-numeric cap throws, never defaults', () => {
    const j = JSON.parse(readFileSync(CAPS_FILE, 'utf8'))
    for (const k of ['base', 'agent', 'boot', 'chapter', 'chapterTarget', 'book', 'workspace', 'screen']) {
      expect(() => parseCaps(JSON.stringify({ ...j, [k]: undefined }))).toThrow(k)
      expect(() => parseCaps(JSON.stringify({ ...j, [k]: '12' }))).toThrow(k)
      expect(() => parseCaps(JSON.stringify({ ...j, [k]: 0 }))).toThrow(k)
    }
    expect(() => parseCaps('{ not json')).toThrow()
  })
})

describe('the layers an agent loads before its first word', () => {
  const files: Record<string, string> = { 'CLAUDE.md': 'b'.repeat(400), 'platform/CLAUDE.md': 'w'.repeat(200), 'platform/dashboards/CLAUDE.md': 'd'.repeat(120) }
  const read = (rel: string) => files[rel] ?? null
  const c = { base: 6000, agent: 2000, boot: 375000 }
  it('the workspace is every CLAUDE.md from the repo down to the cwd, not the root\'s own', () => {
    expect(workspaceChain('platform/dashboards/vol', rel => rel in files)).toEqual(['platform/CLAUDE.md', 'platform/dashboards/CLAUDE.md'])
    expect(workspaceChain('.', rel => rel in files)).toEqual([])
    expect(workspaceChain('', rel => rel in files)).toEqual([])
  })
  it('sums to "all in" the way `context.py --table` does: base + workspace + prompt + boot (tokens = chars / 4, rounded)', () => {
    const L = layersOf({ cwd: 'platform/dashboards/vol' }, 1800, 70, read, c)
    expect(L).toMatchObject({ base: 100, workspace: 80, agent: 70, boot: 1800, total: 100 + 50 + 30 + 70 + 1800, caps: c })
    expect(L.workspaceFiles).toEqual([{ file: 'platform/CLAUDE.md', tokens: 50 }, { file: 'platform/dashboards/CLAUDE.md', tokens: 30 }])
  })
  it('a boot list is read against the boot cap, not the old 12k budget', () => {
    expect(1800 / caps().boot).toBeCloseTo(1800 / 375_000)
  })
  it('a layer that cannot be read is null and all-in is null with it: unknown, never a sum of what was read', () => {
    expect(layersOf({ cwd: '.' }, 100, null, read, c)).toMatchObject({ agent: null, total: null })
    expect(layersOf({ cwd: '.' }, 100, 70, () => null, c)).toMatchObject({ base: null, total: null })
  })
})
