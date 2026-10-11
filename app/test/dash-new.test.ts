import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Agent, Dashboard } from '../shared/types.ts'
import { addDashboard, agentErrors, dashboardErrors, dashboardFileErrors, editJson, nextOrder, registryErrors } from '../server/proc/configwrite.ts'
import { readRoster } from '../server/roster.ts'
import { readDashboards } from '../server/config.ts'
import { serializeAgentFile } from '../shared/agentfile.ts'

/** the fund this checkout belongs to: its parent, or - for a build worktree outside the tree - the
 *  parent of the app repo's main checkout (git's common dir, <fund>/app/.git) */
function liveFund(): string {
  const up = resolve(__dirname, '..', '..')
  if (existsSync(join(up, 'repos.json'))) return up
  try {
    const app = resolve(__dirname, '..')
    const fund = resolve(app, execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd: app }).toString().trim(), '..', '..')
    return existsSync(join(fund, 'repos.json')) ? fund : up
  } catch { return up }
}
const FUND = liveFund()

const terminal: Dashboard = {
  id: 'trade', name: 'Trade', market: 'crypto', agent: 'dash:trade', kind: 'dashboard', open: 'http://127.0.0.1:8787/#trade',
  start: { cmd: '.venv/Scripts/python.exe -m trade_screen', cwd: 'platform', port: 8787, shared: 'terminal' },
  health: [{ id: 'port', check: 'port', port: 8787 }], every: '5m', on_fail: 'wake_agent', order: 1,
}
const tradeAgent: Agent = {
  id: 'dash:trade', name: 'trade', kind: 'dashboard', mode: 'active', dept: 'Dashboards', role: 'x', cwd: 'platform/app',
  writes: ['platform/app/static/'], model: 'sonnet', effort: 'medium', boot: [], dashboard: 'trade', order: 4,
}
const AGENTS = 'app/agents'

let root = ''
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dash-new-'))
  // one dashboard.json per dashboard, beside its code; the roster one file per agent in app/agents
  mkdirSync(join(root, DASH, 'trade'), { recursive: true })
  writeFileSync(join(root, DASH, 'trade', 'dashboard.json'), JSON.stringify(terminal, null, 2) + '\n')
  mkdirSync(join(root, AGENTS), { recursive: true })
  writeFileSync(join(root, AGENTS, 'dash-trade.md'), serializeAgentFile(tradeAgent as unknown as Record<string, unknown>, '# trade\n'))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const DASH = 'platform/dashboards'

describe('configuration writer', () => {
  it('validates rows before they land', () => {
    expect(dashboardErrors({ ...terminal, id: 'x', start: { ...terminal.start!, shared: undefined } }, [terminal])).toContain('port 8787 is taken by trade')
    expect(dashboardErrors({ ...terminal, id: 'x', health: [] }, [])).toContain('health needs at least one check')
    expect(agentErrors({ ...tradeAgent, id: 'dash:x', writes: ['.'] }, [])).toEqual(['writes: . is too wide'])
    expect(agentErrors({ ...tradeAgent, id: 'dash:x', cwd: 'C:/evil' }, [])).toContain('cwd must be fund-relative')
    expect(agentErrors(tradeAgent, [tradeAgent])).toContain('agent dash:trade already exists')
    expect(dashboardErrors({ ...terminal, id: 'x', agent: 'dash:x', start: { ...terminal.start! }, order: 1 }, [terminal])).toContain('order 1 is taken')
    expect(nextOrder([terminal, { ...terminal, id: 'y', order: 7 }])).toBe(8)
  })
  it('reads one dashboard.json by the platform registry rule: id is the folder, every key present', () => {
    expect(dashboardFileErrors(terminal, 'trade')).toEqual([])
    expect(dashboardFileErrors(terminal, 'other')).toEqual(['id trade is not its folder name other'])
    const { order: _o, ...noOrder } = terminal
    expect(dashboardFileErrors(noOrder, 'trade')).toEqual(['missing order'])
    expect(dashboardFileErrors({ ...terminal, order: '1' }, 'trade')).toEqual(['order is not an int'])
    expect(dashboardFileErrors([], 'trade')).toEqual(['not a JSON object'])
    expect(dashboardFileErrors({ ...terminal, health: [{ id: 'a', check: 'port', port: 1 }, { id: 'a', check: 'port', port: 2 }] }, 'trade')).toEqual(['health id a repeated'])
    // across files: one order twice, one agent twice, one port without one identical shared server
    const b = { ...terminal, id: 'b', agent: 'dash:trade', start: { cmd: 'y', cwd: 'platform', port: 8787 } }
    expect(registryErrors([terminal, b])).toEqual(['order 1 used twice', 'agent dash:trade owns two dashboards', 'port 8787 is claimed by trade, b without one identical start.shared server'])
    const view = { ...terminal, id: 'view', agent: 'dash:view', order: 2, start: { shared: 'terminal', port: 8787, cwd: 'platform', cmd: terminal.start!.cmd } }
    expect(registryErrors([terminal, view])).toEqual([])
  })
  it('collects every <id>/dashboard.json: a broken file is named and left out, the rest are served in order', () => {
    const dir = join(root, DASH)
    mkdirSync(join(dir, 'broken')); writeFileSync(join(dir, 'broken', 'dashboard.json'), '{ nope')
    mkdirSync(join(dir, 'wrong')); writeFileSync(join(dir, 'wrong', 'dashboard.json'), JSON.stringify({ ...terminal, id: 'other', order: 3 }))
    mkdirSync(join(dir, 'terminal'))   // a server folder with no dashboard.json is not a dashboard
    mkdirSync(join(dir, 'aaa')); writeFileSync(join(dir, 'aaa', 'dashboard.json'), JSON.stringify({ ...terminal, id: 'aaa', agent: 'dash:aaa', order: 2, start: { ...terminal.start! } }))
    const r = readDashboards(dir)
    expect(r.dashboards.map(d => d.id)).toEqual(['trade', 'aaa'])
    expect(r.problems.map(p => p.path.replace(/\\/g, '/').split('/').slice(-2).join('/'))).toEqual(['broken/dashboard.json', 'wrong/dashboard.json'])
    expect(r.problems[0].error).toMatch(/^unreadable/)
    expect(r.problems[1].error).toBe('id other is not its folder name wrong')
    expect(readDashboards(join(root, 'nowhere'))).toEqual({ dashboards: [], problems: [] })
  })
  it('a new dashboard lands as its own dashboard.json: 2-space JSON with LF, never over another', () => {
    const dir = join(root, DASH)
    const d: Dashboard = { ...terminal, id: 'odds', agent: 'dash:odds', open: 'http://127.0.0.1:8850/', start: { cmd: 'x', cwd: 'platform', port: 8850 }, health: [{ id: 'port', check: 'port', port: 8850 }], order: 2 }
    addDashboard(dir, d, [terminal])
    const text = readFileSync(join(dir, 'odds', 'dashboard.json'), 'utf8')
    expect(text).not.toMatch(/\r/)
    expect(text.endsWith('}\n')).toBe(true)
    expect(readDashboards(dir).dashboards.map(x => x.id)).toEqual(['trade', 'odds'])
    expect(() => addDashboard(dir, d, [terminal, d])).toThrow(/already exists/)
    expect(() => addDashboard(dir, d, [terminal])).toThrow(/refusing to overwrite/)
  })
  it('a JSON edit keeps unknown keys, lands LF, and a throwing mutation leaves the file untouched', () => {
    const file = join(root, DASH, 'trade', 'dashboard.json')
    writeFileSync(file, JSON.stringify({ $comment: 'keep me', ...terminal }, null, 2).replace(/\n/g, '\r\n'))
    editJson<Record<string, unknown>>(file, cur => ({ ...cur, every: '10m' }))
    const text = readFileSync(file, 'utf8')
    expect(text).not.toMatch(/\r/)
    expect(text).toMatch(/^\{\n {2}"\$comment": "keep me",/)
    expect(() => editJson(file, () => { throw new Error('no') })).toThrow('no')
    expect(readFileSync(file, 'utf8')).toBe(text)
  })
})

describe('the live registry and the live roster', () => {
  const LIVE = join(FUND, DASH)
  it.skipIf(!existsSync(LIVE))('every platform dashboard.json registers, with no problem named', () => {
    const r = readDashboards(LIVE)
    expect(r.problems).toEqual([])
    expect(r.dashboards.length).toBeGreaterThan(0)
    expect(r.dashboards.map(d => d.order)).toEqual([...r.dashboards.map(d => d.order)].sort((a, b) => a! - b!))
  })
  it.skipIf(!existsSync(LIVE))('every dashboard is owned by a roster agent, and every dash:<id> agent owns a dashboard that exists', () => {
    const dashboards = readDashboards(LIVE).dashboards
    const roster = readRoster(join(FUND, AGENTS))
    expect(roster.problems).toEqual([])
    const ids = new Set(roster.agents.map(a => a.id))
    for (const d of dashboards) expect(ids.has(d.agent), `${d.id} -> ${d.agent}`).toBe(true)
    for (const a of roster.agents.filter(x => x.kind === 'dashboard')) {
      expect(dashboards.some(d => d.id === a.dashboard && d.agent === a.id), a.id).toBe(true)
      expect(existsSync(join(FUND, a.cwd)), `${a.id} cwd ${a.cwd}`).toBe(true)
    }
  })
})
