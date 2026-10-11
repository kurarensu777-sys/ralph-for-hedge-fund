import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { Agent } from '../shared/types.ts'
import { AgentFileError, agentFileName, briefBody, headerErrors, parseAgentFile, parseHeader, serializeAgentFile } from '../shared/agentfile.ts'
import { addAgentFile, readRoster, removeAgentFile, saveAgentFiles } from '../server/roster.ts'
import { RETIRED_AGENTS, currentAgentId } from '../server/paths.ts'

// THE ROSTER, one file per agent (app/agents/<id>.md): the header grammar both languages read,
// the reader that leaves a bad file out and names it, and the writer that changes a header and
// never the brief under it.

const TMP = mkdtempSync(join(tmpdir(), 'roster-'))
afterAll(() => rmSync(TMP, { recursive: true, force: true }))

const row = (over: Partial<Agent> = {}): Agent => ({
  id: 'dash:vol', name: 'Vol', kind: 'dashboard', mode: 'active', dept: 'Dashboards', dashboard: 'vol',
  role: 'The VOL screen: term structure, smile', cwd: 'platform/dashboards/vol', model: 'sonnet', effort: 'medium', order: 9,
  writes: ['platform/dashboards/vol/'], boot: ['app/library/law/a.md', 'platform/dashboards/vol/library/_series.md'], ...over,
})

describe('the header grammar', () => {
  it('reads plain, JSON-quoted and single-quoted scalars, typed booleans, nulls and numbers', () => {
    expect(parseHeader('a: plain words\nb: "x: y # z"\nc: \'it\'\'s\'\nd: true\ne: null\nf: 12\ng: -1.5\nh: 007x')).toEqual(
      { a: 'plain words', b: 'x: y # z', c: "it's", d: true, e: null, f: 12, g: -1.5, h: '007x' })
  })
  it('reads block lists, flow lists, empty lists, and drops a trailing comment on a plain value', () => {
    expect(parseHeader('w:\n  - a/\n  - "b: c"\nx: []\ny: [p, "q, r", \'s\']\nz: value # a comment')).toEqual(
      { w: ['a/', 'b: c'], x: [], y: ['p', 'q, r', 's'], z: 'value' })
  })
  it('refuses what it cannot read the same way everywhere', () => {
    for (const bad of ['a: "unterminated', 'no colon here', 'a: 1\na: 2', '  - an item before any list', 'l: [a, b']) {
      expect(() => parseHeader(bad), bad).toThrow(AgentFileError)
    }
  })
  it('a file needs its --- lines; the body is everything under the closing one', () => {
    expect(() => parseAgentFile('id: x\n')).toThrow(/no header/)
    expect(() => parseAgentFile('---\nid: x\n')).toThrow(/closing/)
    expect(parseAgentFile('\uFEFF---\r\nid: x\r\n---\r\n\r\n# brief\r\nline\r\n')).toEqual({ header: { id: 'x' }, body: '# brief\nline\n' })
    expect(briefBody('---\nid: x\n---\n\n# the brief\n')).toBe('# the brief\n')
    expect(briefBody('# a brief with no header\n')).toBe('# a brief with no header\n')
    expect(briefBody('---\nid: "broken\n---\nbody')).toMatch(/^---/)   // shown whole, never silently emptied
  })
  it('round-trips every row the cockpit writes, quoting only what a YAML reader could misread', () => {
    const tricky = row({ role: 'yes', name: 'true', dept: '12', writes: ['- lead', 'a: b', 'x #y', 'ok/'], boot: [] })
    for (const r of [row(), tricky]) {
      const text = serializeAgentFile(r as unknown as Record<string, unknown>, '# brief\n')
      expect(parseAgentFile(text)).toEqual({ header: r, body: '# brief\n' })
    }
    const text = serializeAgentFile(row() as unknown as Record<string, unknown>, 'b')
    expect(text).toMatch(/^---\nid: "dash:vol"\n|^---\nid: dash:vol\n/)
    expect(text).toContain('\nrole: "The VOL screen: term structure, smile"\n')   // ': ' forces quotes
    expect(text).toContain('\norder: 9\n')
    expect(text).toContain('\nwrites:\n  - platform/dashboards/vol/\n')
    expect(text.indexOf('\nwrites:')).toBeLessThan(text.indexOf('\nboot:'))       // the fixed key order
    expect(text).not.toMatch(/\r/)
  })
  it('names what a header lacks, and a file that carries another agent', () => {
    const h = parseAgentFile(serializeAgentFile(row() as unknown as Record<string, unknown>, '')).header
    expect(headerErrors(h, 'dash-vol.md')).toEqual([])
    expect(headerErrors({ ...h, kind: 'robot', writes: 'x' }, 'dash-vol.md')).toEqual(['writes must be a list', 'kind robot is not standing or dashboard'])
    expect(headerErrors(h, 'vol.md')).toEqual(['id dash:vol belongs in dash-vol.md, not vol.md'])
    const { dashboard: _d, ...noDash } = h
    expect(headerErrors(noDash)).toEqual(['a dashboard agent names its dashboard'])
    expect(agentFileName('dash:vol')).toBe('dash-vol.md')
  })
})

describe('the reader and the writer', () => {
  const dir = join(TMP, 'agents')
  mkdirSync(dir, { recursive: true })
  const put = (name: string, text: string) => writeFileSync(join(dir, name), text)
  put('dash-vol.md', serializeAgentFile({ ...row(), budgetTokensPerDay: 5000 }, '# vol - the brief\n\nkeep this text\n'))
  put('fund.md', serializeAgentFile(row({ id: 'fund', name: 'fund', kind: 'standing', dashboard: undefined, order: 1, cwd: '.' }) as unknown as Record<string, unknown>, '# fund\n'))
  put('broken.md', '---\nid: broken\nwrites: [a\n---\n')
  put('twin.md', serializeAgentFile(row({ id: 'fund', name: 'twin', kind: 'standing', dashboard: undefined }) as unknown as Record<string, unknown>, ''))
  put('README.md', '# not an agent\n')
  put('notes.txt', 'not an agent')

  it('loads every good file sorted by order, and names every file it left out', () => {
    const r = readRoster(dir, 'app/agents')
    expect(r.agents.map(a => a.id)).toEqual(['fund', 'dash:vol'])
    expect(r.problems.map(p => p.path).sort()).toEqual(['app/agents/broken.md', 'app/agents/twin.md'])
    expect(r.problems.find(p => p.path.endsWith('twin.md'))!.error).toMatch(/belongs in fund\.md/)
    expect(r.headers.find(h => h.id === 'dash:vol')!.budgetTokensPerDay).toBe(5000)   // unknown keys reach the raw document
    expect(readRoster(join(TMP, 'nowhere'))).toEqual({ agents: [], headers: [], problems: [] })
  })
  it('saves a header change in place: the brief and every unknown key kept, an unchanged file untouched', () => {
    const before = readFileSync(join(dir, 'dash-vol.md'), 'utf8')
    const vol = readRoster(dir).agents.find(a => a.id === 'dash:vol')!
    expect(saveAgentFiles(dir, [vol], 'app/agents')).toEqual([])                 // nothing changed: nothing written
    expect(readFileSync(join(dir, 'dash-vol.md'), 'utf8')).toBe(before)
    expect(saveAgentFiles(dir, [{ ...vol, model: 'opus', boot: [...vol.boot, 'x.md'] }], 'app/agents')).toEqual(['app/agents/dash-vol.md'])
    const after = parseAgentFile(readFileSync(join(dir, 'dash-vol.md'), 'utf8'))
    expect(after.header).toMatchObject({ model: 'opus', budgetTokensPerDay: 5000 })
    expect(after.header.boot).toEqual([...vol.boot, 'x.md'])
    expect(after.body).toBe('# vol - the brief\n\nkeep this text\n')
    saveAgentFiles(dir, [vol], 'app/agents')
    expect(readFileSync(join(dir, 'dash-vol.md'), 'utf8')).toBe(before)          // and back, byte for byte
  })
  it('refuses to save an agent with no file, or a header that would not load', () => {
    expect(() => saveAgentFiles(dir, [row({ id: 'ghost' })], 'app/agents')).toThrow(/no roster file app\/agents\/ghost\.md/)
    const vol = readRoster(dir).agents.find(a => a.id === 'dash:vol')!
    expect(() => saveAgentFiles(dir, [{ ...vol, kind: 'robot' as any }], 'app/agents')).toThrow(/kind robot/)
  })
  it('adds a new agent as its own file, never over another, and removes exactly that one', () => {
    const p = addAgentFile(dir, row({ id: 'dash:odds', dashboard: 'odds', order: 10 }), '# odds\n')
    expect(p).toBe(join(dir, 'dash-odds.md'))
    expect(readRoster(dir).agents.map(a => a.id)).toContain('dash:odds')
    expect(() => addAgentFile(dir, row({ id: 'dash:odds', dashboard: 'odds' }), '')).toThrow(/refusing to overwrite/)
    removeAgentFile(dir, 'dash:odds')
    expect(readRoster(dir).agents.map(a => a.id)).not.toContain('dash:odds')
  })
})

describe('retired agents', () => {
  it('the terminal views answer as dash:terminal; any other id as itself', () => {
    for (const old of ['dash:trade', 'dash:sellvol', 'dash:datactl']) expect(currentAgentId(old)).toBe('dash:terminal')
    expect(RETIRED_AGENTS.map(([o]) => o).sort()).toEqual(['dash:datactl', 'dash:sellvol', 'dash:trade'])
    expect(currentAgentId('dash:vol')).toBe('dash:vol')
  })
})

describe('the writer is the reader inverted', () => {
  it('a role with an apostrophe stays plain, and every live roster file round-trips byte for byte', () => {
    const role = "Order path code and docs. Arming is the owner's alone"
    expect(parseAgentFile(serializeAgentFile({ ...row(), role }, 'b')).header.role).toBe(role)
    expect(serializeAgentFile({ id: 'x', role }, '')).toContain(`role: ${role}\n`)
    const dir = join(__dirname, '..', 'agents')
    for (const f of readdirSync(dir).filter(n => n.endsWith('.md'))) {
      const raw = readFileSync(join(dir, f), 'utf8')
      const p = parseAgentFile(raw)
      expect(serializeAgentFile(p.header, p.body), f).toBe(raw)
    }
  })
})
