import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Agent } from '../shared/types.ts'
import { AGENTS_DIR, FUND_ROOT } from '../server/paths.ts'
import { readRoster } from '../server/roster.ts'
import { parseAgentFile } from '../shared/agentfile.ts'
import { chapterOf, splitRef } from '../shared/bookmeta.ts'
import { agentBrief, buildLaunch, isLegacyCwd, legacyCwds, mcpServers, pathDirs, projectSlug, SETTINGS_FILE, transcriptFile } from '../server/chat/launch.ts'
import { EXACT_ID } from '../shared/models.ts'
import { setPermitted } from '../server/chat/models.ts'

// THE LAUNCH CONTRACT, pinned (ported from machine/test/launch-contract.test.ts). Does the law
// actually REACH the agent: the settings file passed explicitly, the fund root readable, the
// books in the system prompt, the env scrubbed and stamped, dormant refused.

const agent = (over: Partial<Agent> = {}): Agent => ({
  id: 'research', name: 'research', kind: 'standing', mode: 'active', dept: 'Research', role: 'Runs studies',
  cwd: 'platform/research', writes: ['platform/research/'], model: 'opus', effort: 'high',
  boot: ['app/library/law/how-we-know.md#a-shared-window-is-one-result', 'app/library/does-not-exist.md'], ...over,
})
const env = { PATH: 'C:\\bin', EXCHANGE_API_KEY: 's', BROKER_PASSWORD: 'p', ANTHROPIC_API_KEY: 'k', NODE_ENV: 'development', HOME: 'C:\\h' }
const launch = (a = agent(), over = {}) => buildLaunch({ agent: a, conversationId: 'c-test-1', uuid: '00000000-0000-4000-8000-000000000000', resume: false, env, ...over })

describe('the launch contract', () => {
  it('passes the fund settings FILE explicitly, and that file carries the allow + deny lists', () => {
    const o = launch().options as any
    expect(o.settings).toBe(join(FUND_ROOT, '.claude', 'settings.json'))
    expect(SETTINGS_FILE).toBe(o.settings)
    expect(existsSync(SETTINGS_FILE), `${SETTINGS_FILE} is not on disk`).toBe(true)
    const s = JSON.parse(readFileSync(SETTINGS_FILE, 'utf8'))
    expect(Array.isArray(s?.permissions?.allow)).toBe(true)
    expect(Array.isArray(s?.permissions?.deny) && s.permissions.deny.length > 0, 'under bypass the deny list is the whole gate').toBe(true)
  })

  it('runs in the agent cwd resolved under FUND_ROOT, with the fund root as an additional dir', () => {
    const l = launch()
    expect(l.cwd).toBe(join(FUND_ROOT, 'platform', 'research'))
    expect(l.options.cwd).toBe(l.cwd)
    expect(l.options.additionalDirectories).toContain(FUND_ROOT)
  })

  it('does not add the fund root twice when the agent already sits at it', () => {
    const l = launch(agent({ id: 'fund', cwd: '.', boot: [] }))
    expect(l.cwd).toBe(FUND_ROOT)
    expect(l.options.additionalDirectories).not.toContain(FUND_ROOT)
  })

  it('refuses a cwd that escapes the fund', () => {
    expect(() => launch(agent({ cwd: '../../elsewhere' }))).toThrow(/escapes/)
  })

  it('appends the role and the FULL text of every boot book, naming a missing one', () => {
    const l = launch()
    const sp = l.options.systemPrompt as any
    expect(sp.type).toBe('preset')
    expect(sp.preset).toBe('claude_code')
    expect(sp.append).toContain('Runs studies')
    // an entry `<book>.md#<slug>` boots that one chapter (B-0345), not the whole book
    const whole = readFileSync(join(FUND_ROOT, 'app/library/law/how-we-know.md'), 'utf8')
    const chapter = chapterOf(whole, 'a-shared-window-is-one-result')!.text.replace(/\s+$/, '')
    expect(sp.append).toContain(`# Boot book app/library/law/how-we-know.md#a-shared-window-is-one-result\n\n${chapter}`)
    expect(sp.append).not.toContain('## What would it print if false')
    expect(sp.append).toMatch(/app\/library\/does-not-exist\.md\n\n\(missing on disk\)/)
    expect(l.books.map(b => b.text === null)).toEqual([false, true])
  })

  it("appends the agent's BRIEF - the body of its roster file, never the header - after the identity and BEFORE the boot books", () => {
    const l = launch()
    const sp = (l.options.systemPrompt as any).append as string
    expect(l.brief.path).toBe('app/agents/research.md')
    const { body } = parseAgentFile(readFileSync(join(FUND_ROOT, 'app/agents/research.md'), 'utf8'))
    expect(body).toMatch(/^You run studies in any market/)   // two lines: what it owns, then its one rule
    expect(l.brief.text).toBe(body)
    expect(sp).toContain(`# Your brief app/agents/research.md\n\n${body}`)
    expect(sp).not.toMatch(/^id: research$/m)   // the YAML header is the row, not the brief
    const at = (s: string) => sp.indexOf(s)
    expect(at('# You are research')).toBeLessThan(at('# Your brief'))
    expect(at('# Your brief')).toBeLessThan(at('# Boot book app/library/law/how-we-know.md#a-shared-window-is-one-result'))
  })

  it('maps a dashboard id to its roster file, honours a brief override, and names a missing brief', () => {
    // a dashboard id maps to its file by the colon rule, whether or not one is on disk
    expect(launch(agent({ id: 'dash:terminal', boot: [] })).brief.path).toBe('app/agents/dash-terminal.md')
    const over = launch(agent({ brief: 'app/agents/platform.md', boot: [] }))
    expect(over.brief.path).toBe('app/agents/platform.md')
    const { body } = parseAgentFile(readFileSync(join(FUND_ROOT, 'app/agents/platform.md'), 'utf8'))
    expect(body.trim().length).toBeGreaterThan(40)
    expect((over.options.systemPrompt as any).append).toContain(body.trim().slice(0, 40))
    const gone = launch(agent({ id: 'ghost', boot: [] }))
    expect(gone.brief.text).toBeNull()
    expect((gone.options.systemPrompt as any).append).toMatch(/# Your brief app\/agents\/ghost\.md\n\n\(missing on disk\)/)
  })

  it('every agent in the roster loads, and carries a brief of its own under its header', () => {
    const r = readRoster(AGENTS_DIR)
    expect(r.problems).toEqual([])
    expect(r.agents.length).toBeGreaterThan(0)
    for (const a of r.agents as Agent[]) {
      const b = agentBrief(a)
      expect(b.text, `${a.id} has no brief at ${b.path}`).not.toBeNull()
      expect(b.text!.trim().length, `${a.id}: an empty brief`).toBeGreaterThan(100)
      expect(b.text, `${a.id}: the brief still carries a header`).not.toMatch(/^---\n/)
    }
  })

  it('every roster agent boots books that exist and works in a folder that exists', () => {
    for (const a of readRoster(AGENTS_DIR).agents) {
      expect(existsSync(join(FUND_ROOT, a.cwd)), `${a.id}: cwd ${a.cwd}`).toBe(true)
      // an entry is a book, or `<book>.md#<slug>`: the book is on disk AND holds that chapter
      for (const b of a.boot) {
        const { path, slug } = splitRef(b)
        expect(existsSync(join(FUND_ROOT, path)), `${a.id}: boot ${b}`).toBe(true)
        if (slug) expect(chapterOf(readFileSync(join(FUND_ROOT, path), 'utf8'), slug), `${a.id}: boot ${b} has no such chapter`).not.toBeNull()
      }
    }
  })

  it("runs under the owner's standing permission mode, with no skip flag of its own", () => {
    const o = launch().options as any
    expect(o.permissionMode).toBe('bypassPermissions')
    expect(o.allowDangerouslySkipPermissions).toBeUndefined()
    expect(o.settingSources).toEqual(['user', 'project', 'local'])
  })

  it('scrubs the env and stamps FUND_AGENT / FUND_CONVERSATION / FUND_ROOT, with the fund root on PATH', () => {
    const e = launch().options.env as Record<string, string>
    expect(e.EXCHANGE_API_KEY).toBeUndefined()
    expect(e.BROKER_PASSWORD).toBeUndefined()
    expect(e.NODE_ENV).toBeUndefined()
    expect(e.ANTHROPIC_API_KEY).toBe('k')
    expect(e.FUND_AGENT).toBe('research')
    expect(e.FUND_CONVERSATION).toBe('c-test-1')
    expect(e.FUND_ROOT).toBe(FUND_ROOT)
    expect(e.PATH.split(process.platform === 'win32' ? ';' : ':')[0]).toBe(FUND_ROOT)
  })

  it('takes model/effort from config unless the conversation overrides them', () => {
    expect(launch(agent({ model: 'claude-opus-5-5[1m]' })).options.model).toBe('claude-opus-5-5[1m]')
    expect(launch().options.effort).toBe('high')
    const o = launch(agent(), { model: 'claude-sonnet-5', effort: 'low' }).options
    expect(o.model).toBe('claude-sonnet-5')
    expect(o.effort).toBe('low')
  })

  it("boots an alias on the exact id Claude Code's permitted list resolves it to, and sends no effort a model does not take", () => {
    setPermitted({ at: 1, error: null, models: [
      { id: 'claude-opus-5-5[1m]', aliases: ['default', 'opus[1m]'], name: 'Opus 5.5 with 1M context', description: '', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
      { id: 'claude-haiku-4-5-20251001', aliases: ['haiku'], name: 'Haiku 4.5', description: '', efforts: [] },
    ] })
    try {
      expect(launch(agent(), { model: 'opus[1m]' }).options.model).toBe('claude-opus-5-5[1m]')
      expect(launch(agent(), { model: 'claude-opus-5-5[1m]', effort: 'max' }).options.effort).toBe('max')
      const h = launch(agent(), { model: 'haiku', effort: 'high' }).options
      expect(h.model).toBe('claude-haiku-4-5-20251001')
      expect(h.effort).toBeUndefined()
      expect(launch(agent(), { model: 'claude-sonnet-5' }).options.model).toBe('claude-sonnet-5')   // off the list: as written
    } finally { setPermitted({ models: [], at: null, error: null }) }
  })

  it('every roster file names an EXACT model id, never an alias', () => {
    const r = readRoster(AGENTS_DIR)
    expect(r.agents.length).toBeGreaterThan(0)
    for (const a of r.agents) expect(EXACT_ID.test(a.model), `${a.id}: model ${a.model}`).toBe(true)
  })

  it('starts a new transcript under its uuid, resumes an existing one, and forks on a rewind', () => {
    const fresh = launch().options as any
    expect(fresh.sessionId).toBe('00000000-0000-4000-8000-000000000000')
    expect(fresh.resume).toBeUndefined()
    const resumed = launch(agent(), { resume: true }).options as any
    expect(resumed.resume).toBe('00000000-0000-4000-8000-000000000000')
    expect(resumed.sessionId).toBeUndefined()
    const rewound = launch(agent(), { resume: true, resumeAt: 'abc' }).options as any
    expect(rewound.resumeSessionAt).toBe('abc')
    expect(rewound.forkSession).toBe(true)
  })

  it('mcpServers: the root file first, then app/.mcp.json; relative commands resolved against their file; credentials never ride', () => {
    const R = mkdtempSync(join(tmpdir(), 'mcp-'))
    const put = (rel: string, doc: unknown) => { mkdirSync(join(R, rel, '..'), { recursive: true }); writeFileSync(join(R, rel), typeof doc === 'string' ? doc : JSON.stringify(doc)) }
    try {
      expect(mcpServers(R)).toEqual({ servers: {}, from: [], problems: [] })
      put('app/.mcp.json', { mcpServers: {
        docs: { command: '../.venv/Scripts/python.exe', args: ['-m', 'docs.mcp'], env: { PYTHONUTF8: 1, EXCHANGE_API_KEY: 's', DATA_API_TOKEN: 't' } },
        bare: { command: 'python', args: ['-m', 'x'] },
        web: { type: 'http', url: 'http://127.0.0.1:1/mcp' },
        broken: { args: [] },
      } })
      const a = mcpServers(R)
      expect(a.from).toEqual(['app/.mcp.json'])
      expect(a.servers.docs).toEqual({ type: 'stdio', command: join(R, '.venv', 'Scripts', 'python.exe'), args: ['-m', 'docs.mcp'], env: { PYTHONUTF8: '1' } })
      expect(a.servers.bare).toEqual({ type: 'stdio', command: 'python', args: ['-m', 'x'] })   // a bare command is left to PATH
      expect(a.servers.web).toEqual({ type: 'http', url: 'http://127.0.0.1:1/mcp' })
      expect(a.servers.broken).toBeUndefined()
      expect(a.problems.some(p => /broken has neither/.test(p))).toBe(true)
      expect(a.problems.some(p => /docs command .* is not on disk/.test(p))).toBe(true)
      // the root's file wins a name it gives; its relative command resolves against the root
      put('.mcp.json', { mcpServers: { docs: { command: '.venv/Scripts/python.exe', args: ['-m', 'docs.mcp'], env: { PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' } } } })
      mkdirSync(join(R, '.venv', 'Scripts'), { recursive: true }); writeFileSync(join(R, '.venv', 'Scripts', 'python.exe'), '')
      const b = mcpServers(R)
      expect(b.from).toEqual(['.mcp.json', 'app/.mcp.json'])
      expect(b.servers.docs).toEqual({ type: 'stdio', command: join(R, '.venv', 'Scripts', 'python.exe'), args: ['-m', 'docs.mcp'], env: { PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' } })
      expect(b.problems.some(p => /not on disk/.test(p))).toBe(false)
      expect(Object.keys(b.servers)).toEqual(['docs', 'bare', 'web'])
      // a file that does not parse is named; the other still loads
      put('.mcp.json', '{ not json')
      const c = mcpServers(R)
      expect(c.problems[0]).toMatch(/^\.mcp\.json: unreadable/)
      expect(c.servers.docs?.type).toBe('stdio')
    } finally { rmSync(R, { recursive: true, force: true }) }
  })

  it('refuses a dormant agent', () => {
    expect(() => launch(agent({ mode: 'dormant' }))).toThrow(/dormant/)
  })

  it("slugs a cwd the way Claude Code does, so adopted transcripts are found", () => {
    expect(projectSlug('C:\\dev\\fund')).toBe('C--dev-fund')
    expect(projectSlug('C:\\dev\\fund\\platform\\app')).toBe('C--dev-fund-platform-app')
    expect(transcriptFile('C:\\dev\\fund', 'u')).toMatch(/projects[\\/]C--dev-fund[\\/]u\.jsonl$/)
  })

  it('finds history filed under the cwds the 2026-09-24 cut-over retired', () => {
    expect(legacyCwds('platform')).toEqual(['crypto', 'repos/platform'])
    expect(legacyCwds('platform/app')).toEqual(['crypto/app', 'repos/platform/app'])
    expect(legacyCwds('platform/api/execution')).toEqual(['crypto/api/execution', 'repos/platform/api/execution'])
    // research folded into platform on 2026-09-25: its history sits under every earlier home, once each
    expect(legacyCwds('platform/research')).toEqual(['crypto/research', 'repos/research', 'repos/platform/research', 'research'])
    expect(legacyCwds('platform/dashboards/vol')).toEqual(['platform/fundplat/dashboards/vol', 'crypto/dashboards/vol', 'repos/platform/dashboards/vol'])
    expect(legacyCwds('lab/platform/data')).toEqual(['lab/api/data', 'desks/api/data'])
    expect(legacyCwds('lab/dashboards/app')).toEqual(['lab/app', 'desks/app'])
    expect(legacyCwds('lab/research')).toEqual(['desks/research'])
    expect(legacyCwds('.')).toEqual([])
    expect(legacyCwds('app')).toEqual(['repos/app'])
    expect(isLegacyCwd(join(FUND_ROOT, 'crypto', 'app'))).toBe(true)
    expect(isLegacyCwd(join(FUND_ROOT, 'desks', 'app'))).toBe(true)
    expect(isLegacyCwd(join(FUND_ROOT, 'repos', 'platform'))).toBe(true)
    expect(isLegacyCwd(join(FUND_ROOT, 'platform'))).toBe(false)
    expect(isLegacyCwd(FUND_ROOT)).toBe(false)
  })

  it('puts the ONE fund venv on PATH, never the retired crypto/.venv', () => {
    const dirs = pathDirs()
    expect(dirs).toContain(FUND_ROOT)
    expect(dirs.some(d => /crypto/i.test(d))).toBe(false)
  })
})
