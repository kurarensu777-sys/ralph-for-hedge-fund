import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { Agent } from '../shared/types.ts'
import { sharedRow, type CtxAgent, type CtxRow } from '../shared/context.ts'
import { agentFileName, serializeAgentFile } from '../shared/agentfile.ts'
import { AGENTS_DIR, FUND_ROOT } from '../server/paths.ts'
import { readRoster } from '../server/roster.ts'
import { agentBrief, bootBooks, buildLaunch, systemAppend } from '../server/chat/launch.ts'
import { parseCaps, caps as readCaps } from '../server/library/caps.ts'
import { hashOf } from '../server/library/edit.ts'
import { predict, workspaceCap } from '../server/context/predict.ts'
import { applyEdit, saveAgent } from '../server/context/save.ts'
import { judge } from '../server/context/drift.ts'
import { buildMatrix, budgetTone, cellTone } from '../src/rooms/context/matrix.ts'
import { lineDiff, trimDiff } from '../src/rooms/context/linediff.ts'

// THE CONTEXT ROOM, pinned. The gate is the first block: the room's predicted prompt is byte-for-byte what a
// boot appends, for every agent on the roster. The rest is the pure parts (rows, caps, the matrix filters, the
// diff, the save, the drift judgement), each broken once on purpose when it was written.

const caps = readCaps()
const roster = readRoster(AGENTS_DIR).agents
const launchAppend = (a: Agent) => ((buildLaunch({ agent: { ...a, mode: 'active' }, conversationId: 'c-ctx-test', uuid: '00000000-0000-4000-8000-000000000000', resume: false, env: { PATH: 'x' } }).options.systemPrompt as { append: string }).append)

describe('the predicted prompt is the launched prompt', () => {
  it('the roster is not empty (an empty loop would pass for nothing)', () => { expect(roster.length).toBeGreaterThan(0) })

  it.each(roster.map(a => [a.id, a] as const))('%s: predict().append equals buildLaunch().options.systemPrompt.append', (_id, a) => {
    expect(predict(a, caps).append).toBe(launchAppend(a))
  })

  it('would catch a prediction that is off: a dropped boot book, or a brief the launch did not read, differ', () => {
    const a = roster.find(x => (x.boot ?? []).length > 1) as Agent
    expect(a).toBeTruthy()
    const dropped = systemAppend(a, bootBooks({ ...a, boot: a.boot.slice(1) }), agentBrief(a))
    expect(dropped).not.toBe(launchAppend(a))
    expect(systemAppend(a, bootBooks(a), null)).not.toBe(launchAppend(a))
  })

  it('a dormant agent is predicted too (the room shows it greyed)', () => {
    const a = { ...roster[0], mode: 'dormant' as const }
    expect(predict(a, caps).ctx.mode).toBe('dormant')
    expect(predict(a, caps).append).toBe(launchAppend(roster[0]))
  })
})

describe('the rows', () => {
  const a = roster.find(x => x.id === 'app') as Agent
  const p = predict(a, caps)
  const row = (k: string) => p.ctx.rows.find(r => r.key === k) as CtxRow

  it('the base row is the root CLAUDE.md at chars / 4 against the base cap', () => {
    const text = readFileSync(join(FUND_ROOT, 'CLAUDE.md'), 'utf8')
    expect(row('base:CLAUDE.md')).toMatchObject({ type: 'base', tokens: Math.round(text.length / 4), cap: caps.base, state: 'ok' })
  })
  it('app/CLAUDE.md is a workspace row and the root one is not', () => {
    expect(p.ctx.rows.filter(r => r.type === 'workspace').map(r => r.label)).toContain('app/CLAUDE.md')
    expect(p.ctx.rows.filter(r => r.type === 'workspace').map(r => r.label)).not.toContain('CLAUDE.md')
  })
  it('every booted chapter is one row at its chapter cap, sized like its text', () => {
    const books = bootBooks(a)
    const rows = p.ctx.rows.filter(r => r.type === 'boot')
    expect(rows.length).toBe(books.length)
    books.forEach((b, i) => {
      expect(rows[i].key).toBe(`boot:${b.path}`)
      expect(rows[i].tokens).toBe(b.text === null ? null : Math.round(b.text.length / 4))
      expect(rows[i].cap).toBe(caps.chapter)
    })
  })
  it('the brief is the agent cap and the identity has none', () => {
    expect(row('agent:brief').cap).toBe(caps.agent)
    expect(row('agent:identity').cap).toBeNull()
  })
  it('what is never measured has null tokens and state unknown, never a zero', () => {
    const unk = p.ctx.rows.filter(r => ['system', 'mcp', 'skills', 'memory'].includes(r.type))
    expect(unk.map(r => r.type)).toEqual(expect.arrayContaining(['system', 'skills', 'memory']))
    for (const r of unk) expect(r).toMatchObject({ tokens: null, state: 'unknown' })
  })
  it('a missing chapter is a missing row with no size, named', () => {
    const q = predict({ ...a, boot: ['app/library/app/does-not-exist.md#nope'] }, caps)
    expect(q.ctx.rows.find(r => r.key === 'boot:app/library/app/does-not-exist.md#nope')).toMatchObject({ state: 'missing', tokens: null })
  })
  it('a cwd that escapes the fund is an error on the agent, not a thrown route', () => {
    const q = predict({ ...a, cwd: '../../elsewhere' }, caps)
    expect(q.ctx.error).toMatch(/escapes/)
  })
  it('the budgets read each layer against its cap', () => {
    const b = Object.fromEntries(p.ctx.budgets.map(x => [x.type, x]))
    expect(b.base.cap).toBe(caps.base)
    expect(b.agent.cap).toBe(caps.agent)
    expect(b.boot.cap).toBe(caps.boot)
    expect(b.boot.tokens).toBe(p.ctx.rows.filter(r => r.type === 'boot').reduce((n, r) => n + (r.tokens ?? 0), 0))
  })
  it('unreadable caps draw no cap, never an invented one', () => {
    const q = predict(a, null)
    expect(q.ctx.rows.filter(r => r.type !== 'system').every(r => r.cap === null)).toBe(true)
    expect(q.ctx.budgets.every(x => x.cap === null)).toBe(true)
  })
})

describe('the caps', () => {
  it('read from the one file: a named file keeps its own cap, a dashboard runbook the screen cap, the rest workspace', () => {
    const c = parseCaps(readFileSync(join(FUND_ROOT, 'app', 'tools', 'context-caps.json'), 'utf8'))
    expect(workspaceCap('platform/CLAUDE.md', c)).toBe(c.workspaceNamed['platform/CLAUDE.md'])
    expect(workspaceCap('platform/dashboards/vol/CLAUDE.md', c)).toBe(c.screen)
    expect(workspaceCap('app/CLAUDE.md', c)).toBe(c.workspace)
  })
  it('the room holds no cap constants of its own', () => {
    for (const f of ['server/context/predict.ts', 'server/rooms/context.ts', 'src/rooms/context/Matrix.tsx', 'src/rooms/context/Panel.tsx', 'src/rooms/context/matrix.ts']) {
      const t = readFileSync(join(FUND_ROOT, 'app', f), 'utf8')
      expect(t, f).not.toMatch(/\b(1500|2500|900|750)\b/)
    }
  })
})

const cell = (tokens: number | null, o: Partial<CtxRow> = {}): CtxRow => ({ type: 'boot', key: 'k', label: 'k', tokens, cap: null, state: tokens === null ? 'unknown' : 'ok', ...o })
const ag = (id: string, rows: CtxRow[], mode: 'active' | 'dormant' = 'active'): CtxAgent => ({ id, name: id, kind: 'standing', mode, dept: 'd', cwd: '.', rows, budgets: [], appendTokens: 0, known: 0 })

describe('the matrix', () => {
  const base = (t: number): CtxRow => ({ type: 'base', key: 'base:CLAUDE.md', label: 'CLAUDE.md', tokens: t, cap: 1500, state: 'ok' })
  const only = { type: 'boot', key: 'boot:a.md#x', label: 'a.md#x', tokens: 100, cap: 900, state: 'ok' } as CtxRow
  const agents = [ag('a', [base(1000), only]), ag('b', [base(1000)]), ag('c', [base(1000)], 'dormant')]
  const keys = (f: 'all' | 'shared' | 'differs') => buildMatrix(agents, f).flatMap(g => g.rows.map(r => r.key))

  it('Shared is the rows every agent loads at one size, a dormant one included', () => { expect(keys('shared')).toEqual(['base:CLAUDE.md']) })
  it('Differs is the rest, and the two never overlap', () => {
    expect(keys('differs')).toEqual(['boot:a.md#x'])
    expect(keys('all').sort()).toEqual([...keys('shared'), ...keys('differs')].sort())
  })
  it('a row loaded by all at different sizes differs', () => {
    expect(sharedRow([cell(10), cell(11)])).toBe(false)
    expect(sharedRow([cell(10), cell(10)])).toBe(true)
    expect(sharedRow([cell(10), undefined])).toBe(false)
  })
  it('an agent that does not load a row has no cell for it (a blank, not a zero)', () => {
    const r = buildMatrix(agents, 'all').flatMap(g => g.rows).find(x => x.key === 'boot:a.md#x') as { cells: (CtxRow | undefined)[] }
    expect(r.cells.map(c => c?.tokens ?? null)).toEqual([100, null, null])
  })
  it('groups come in the order a boot meets them and empty ones are left out', () => {
    expect(buildMatrix(agents, 'all').map(g => g.type)).toEqual(['base', 'boot'])
  })
  it('tones: over the cap is fail, over the target warn, unknown stays unknown, missing is fail', () => {
    expect(cellTone(cell(901, { cap: 900 }))).toBe('fail')
    expect(cellTone(cell(800, { cap: 900, warn: 750 }))).toBe('warn')
    expect(cellTone(cell(700, { cap: 900, warn: 750 }))).toBe('ok')
    expect(cellTone(cell(null))).toBe('unknown')
    expect(cellTone(cell(null, { state: 'missing' }))).toBe('fail')
    expect(budgetTone(10, null)).toBe('unknown')
    expect(budgetTone(2501, 2500)).toBe('fail')
    expect(budgetTone(2300, 2500)).toBe('warn')
  })
})

describe('the brief diff', () => {
  it('marks what was added and removed, and nothing for an unchanged text', () => {
    expect(lineDiff('a\nb\nc\n', 'a\nB\nc\n')).toEqual([{ t: 'ctx', s: 'a' }, { t: 'del', s: 'b' }, { t: 'add', s: 'B' }, { t: 'ctx', s: 'c' }])
    expect(lineDiff('a\nb\n', 'a\nb\n')!.every(r => r.t === 'ctx')).toBe(true)
  })
  it('folds distant context into one gap', () => {
    const before = Array.from({ length: 20 }, (_, i) => `l${i}`).join('\n')
    const after = before.replace('l10', 'X')
    const rows = trimDiff(lineDiff(before, after)!, 1)
    expect(rows.filter(r => r.t === 'gap').length).toBe(2)
    expect(rows.length).toBeLessThan(10)
  })
})

describe('the room is reached', () => {
  it('the route is registered in the shell, the server and the standing sweep', () => {
    const t = (f: string) => readFileSync(join(FUND_ROOT, 'app', f), 'utf8')
    expect(t('src/shell/route.ts')).toContain("'context'")
    expect(t('server/fundd.ts')).toMatch(/ROOMS = [{][^}]*context/)
    expect(t('src/rooms/registry.ts')).toContain('context')
    expect(t('scripts/e2e-rooms.mjs')).toContain('#/context')
    expect(t('src/rooms/map/Drawer.tsx')).toContain("nav.go('context'")
  })
})

describe('the save', () => {
  const FILE = 'agents/test-hand.md'
  const header = { id: 'test-hand', name: 'Test', kind: 'standing', mode: 'active', dept: 'Build', role: 'tests', cwd: 'app', model: 'claude-sonnet-5-5', effort: 'medium', writes: ['app/'], boot: ['app/library/app/a.md#one'] }
  const raw = serializeAgentFile(header, 'first line\nsecond line\n')
  const known = (r: string) => r.startsWith('app/library/')

  it('a brief-only edit leaves every byte of the header alone', () => {
    const r = applyEdit(raw, FILE, { brief: 'first line\nSECOND line' }, known)
    expect(r.changed).toEqual(['brief'])
    const head = (t: string) => t.slice(0, t.indexOf('\n---\n', 3))
    expect(head(r.text)).toBe(head(raw))
    expect(r.text.endsWith('first line\nSECOND line\n')).toBe(true)
  })
  it('an identical brief, boot, model and effort change nothing', () => {
    expect(applyEdit(raw, FILE, { brief: 'first line\nsecond line\n', boot: header.boot, model: header.model, effort: header.effort }, known).changed).toEqual([])
  })
  it('a boot ref that names nothing is refused, an existing stale one is kept', () => {
    expect(() => applyEdit(raw, FILE, { boot: [...header.boot, 'nowhere.md'] }, known)).toThrow(/not a book/)
    expect(applyEdit(raw, FILE, { boot: [...header.boot, 'app/library/app/b.md#two'] }, known).changed).toEqual(['boot'])
    expect(applyEdit(raw, FILE, { boot: header.boot }, () => false).changed).toEqual([])
  })
  it('a boot list change rewrites the header, keeping the brief and any key it does not know', () => {
    const r = applyEdit(serializeAgentFile({ ...header, budgetTokensPerDay: 5 }, 'body\n'), FILE, { boot: [] }, known)
    expect(r.text).toContain('boot: []')
    expect(r.text).toContain('budgetTokensPerDay: 5')
    expect(r.text.endsWith('\n---\n\nbody\n')).toBe(true)
  })
  it('an empty brief is refused', () => { expect(() => applyEdit(raw, FILE, { brief: '  \n' }, known)).toThrow(/empty/) })
  it('a brief kept in another file is not edited here', () => {
    expect(() => applyEdit(serializeAgentFile({ ...header, brief: 'app/library/x.md' }, 'b\n'), FILE, { brief: 'new' }, known)).toThrow(/Library/)
  })

  const ROOT = mkdtempSync(join(tmpdir(), 'ctxsave-'))
  afterAll(() => { rmSync(ROOT, { recursive: true, force: true }) })
  const g = (...a: string[]) => execFileSync('git', ['-c', 'core.autocrlf=false', '-c', 'user.name=Test Hand', '-c', 'user.email=t@t', ...a], { cwd: ROOT, encoding: 'utf8' })
  mkdirSync(join(ROOT, 'agents'), { recursive: true })
  writeFileSync(join(ROOT, FILE), raw)
  g('init', '-q'); g('add', '--', FILE); g('commit', '-q', '-m', 'seed')
  const deps = { known, checkModel: async (m: string) => { if (m !== 'claude-sonnet-5-5') throw new Error(`${m} is not on Claude Code's permitted list`) }, dir: join(ROOT, 'agents'), rel: 'agents', fundRoot: ROOT }

  it('commits exactly the roster file as the owner, one commit', async () => {
    const r = await saveAgent({ agent: 'test-hand', base: hashOf(raw), brief: 'a new brief' }, deps)
    expect(r).toMatchObject({ written: true, committed: true, changed: ['brief'], paths: [FILE] })
    expect(readFileSync(join(ROOT, FILE), 'utf8')).toContain('a new brief')
    expect(g('log', '-1', '--format=%s%n%b')).toMatch(/context: test-hand brief[\s\S]*Agent: you/)
    expect(g('show', '--name-only', '--format=', 'HEAD').trim()).toBe(FILE)
    expect(g('status', '--porcelain').trim()).toBe('')
  })
  it('refuses with 409 a base that is no longer the file, and writes nothing', async () => {
    const before = readFileSync(join(ROOT, FILE), 'utf8')
    await expect(saveAgent({ agent: 'test-hand', base: hashOf(raw), brief: 'stale edit' }, deps)).rejects.toMatchObject({ status: 409 })
    expect(readFileSync(join(ROOT, FILE), 'utf8')).toBe(before)
  })
  it('refuses a model Claude Code does not permit (400) and writes nothing', async () => {
    const before = readFileSync(join(ROOT, FILE), 'utf8')
    await expect(saveAgent({ agent: 'test-hand', base: hashOf(before), model: 'gpt-9' }, deps)).rejects.toMatchObject({ status: 400 })
    expect(readFileSync(join(ROOT, FILE), 'utf8')).toBe(before)
  })
  it('a save that changes nothing writes and commits nothing', async () => {
    const cur = readFileSync(join(ROOT, FILE), 'utf8')
    const head = g('rev-parse', 'HEAD')
    expect(await saveAgent({ agent: 'test-hand', base: hashOf(cur), effort: 'medium' }, deps)).toMatchObject({ written: false, committed: false })
    expect(g('rev-parse', 'HEAD')).toBe(head)
  })
  it('needs an agent, a base and something to save; an unknown agent is 404', async () => {
    await expect(saveAgent({ base: 'x', brief: 'y' }, deps)).rejects.toMatchObject({ status: 400 })
    await expect(saveAgent({ agent: 'test-hand', brief: 'y' }, deps)).rejects.toMatchObject({ status: 400 })
    await expect(saveAgent({ agent: 'test-hand', base: 'x' }, deps)).rejects.toMatchObject({ status: 400 })
    await expect(saveAgent({ agent: 'nobody', base: 'x', brief: 'y' }, deps)).rejects.toMatchObject({ status: 404 })
    expect(agentFileName('test-hand')).toBe('test-hand.md')
  })
})

describe('which open conversations are on the old prompt', () => {
  const rows = (...r: [string, 'changed' | null][]) => r.map(([path, drift]) => ({ path, reason: 'boot', drift }))
  const now = ['app/agents/a.md', 'app/library/x.md#one']
  it('current when every row is unchanged and the set is the agent\'s now', () => { expect(judge(rows([now[0], null], [now[1], null]), now)).toBe('current') })
  it('stale when the brief or a chapter changed since the boot', () => { expect(judge(rows([now[0], 'changed'], [now[1], null]), now)).toBe('stale') })
  it('stale when a chapter was added or removed, though every row it had is unchanged', () => {
    expect(judge(rows([now[0], null]), now)).toBe('stale')
    expect(judge(rows([now[0], null], [now[1], null], ['app/library/y.md#two', null]), now)).toBe('stale')
  })
  it('unknown with no boot rows to compare, never counted as current', () => { expect(judge([], now)).toBe('unknown') })
})
