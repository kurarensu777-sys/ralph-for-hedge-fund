import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Agent } from '../../shared/types.ts'
import type { CtxAgent, CtxBudget, CtxRow } from '../../shared/context.ts'
import { FUND_ROOT } from '../paths.ts'
import { agentBrief, agentCwd, bootBooks, mcpServers, systemAppend, type BootBook } from '../chat/launch.ts'
import { startChain } from '../chat/law.ts'
import { type Caps } from '../library/caps.ts'

// WHAT AN AGENT LOADS, PREDICTED. One pure function over the same helpers buildLaunch uses (startChain,
// bootBooks, agentBrief, systemAppend, mcpServers), so the Context room and a real boot cannot read the
// layers two ways. `append` is exactly the systemPrompt.append a conversation on main gets
// (test/context-predict.test.ts pins that against buildLaunch for every agent); a build branch adds one
// paragraph after it (branchNote), which is not part of an agent's standing context.

const tok = (s: string) => Math.round(s.length / 4)
const SCREEN_RE = /^platform\/dashboards\/[^/]+\/CLAUDE\.md$/
const rel = (p: string, root: string) => { const r = p.slice(root.length).replace(/\\/g, '/').replace(/^\/+/, ''); return r }

/** the cap on one workspace file: its own named cap, else the screen cap for a dashboard's runbook, else the workspace cap */
export function workspaceCap(path: string, c: Pick<Caps, 'workspace' | 'screen' | 'workspaceNamed'>): number {
  return c.workspaceNamed[path] ?? (SCREEN_RE.test(path) ? c.screen : c.workspace)
}

/** the rows that are the same for every agent and are not measured (a probe replaces one when it exists) */
export function unmeasured(servers: string[]): CtxRow[] {
  return [
    { type: 'system', key: 'system:claude-code', label: 'Claude Code preset', tokens: null, cap: null, state: 'unknown', note: 'the preset system prompt and the tool list are not measured' },
    ...servers.map((s): CtxRow => ({ type: 'mcp', key: `mcp:${s}`, label: s, tokens: null, cap: null, state: 'unknown', note: 'the server\'s tool list is not measured' })),
    { type: 'skills', key: 'skills:reach', label: 'Skills and plugins', tokens: null, cap: null, state: 'unknown', note: 'what skills reach this seat is not measured' },
    { type: 'memory', key: 'memory:auto', label: 'Auto-memory', tokens: null, cap: null, state: 'unknown', note: 'MEMORY.md for this folder is not measured' },
  ]
}

const bookRow = (b: BootBook, c: Caps | null): CtxRow => ({
  type: 'boot', key: `boot:${b.path}`, label: b.path.split('/').slice(-1)[0],
  tokens: b.text === null ? null : tok(b.text), cap: c?.chapter ?? null, ...(c ? { warn: c.chapterTarget } : {}),
  state: b.text === null ? 'missing' : 'ok',
  ...(b.text === null ? { note: `${b.path}: ${b.missing === 'chapter' ? 'no such chapter' : 'not on disk'}` } : { note: b.path }),
})

/** the agent's whole predicted context: its rows, its budgets and the exact append */
export function predict(a: Agent, c: Caps | null, servers: string[] = Object.keys(mcpServers().servers), fundRoot: string = FUND_ROOT): { ctx: CtxAgent; append: string } {
  const books = bootBooks(a)
  const brief = agentBrief(a)
  const append = systemAppend(a, books, brief)
  const head: Pick<CtxAgent, 'id' | 'name' | 'kind' | 'mode' | 'dept' | 'cwd'> = { id: a.id, name: a.name, kind: a.kind, mode: a.mode, dept: a.dept, cwd: a.cwd }
  const rows: CtxRow[] = [...unmeasured(servers).filter(r => r.type === 'system')]
  let chain: ReturnType<typeof startChain>
  try { chain = startChain(agentCwd(a), fundRoot) } catch (e) {
    return { ctx: { ...head, rows: [], budgets: [], appendTokens: tok(append), known: tok(append), error: (e as Error).message }, append }
  }
  const root = join(fundRoot, 'CLAUDE.md').toLowerCase()
  for (const f of chain) {
    let text: string | null = null
    try { text = readFileSync(f.path, 'utf8') } catch { text = null }
    const path = f.memoryType === 'User' ? f.path.replace(/\\/g, '/') : rel(f.path, fundRoot)
    if (f.memoryType === 'User') rows.push({ type: 'user', key: 'user:CLAUDE.md', label: '~/.claude/CLAUDE.md', tokens: text === null ? null : tok(text), cap: null, state: text === null ? 'missing' : 'ok', note: path })
    else if (f.path.toLowerCase() === root) rows.push({ type: 'base', key: 'base:CLAUDE.md', label: 'CLAUDE.md', tokens: text === null ? null : tok(text), cap: c?.base ?? null, state: text === null ? 'missing' : 'ok', note: path })
    else rows.push({ type: 'workspace', key: `workspace:${path}`, label: path, tokens: text === null ? null : tok(text), cap: c ? workspaceCap(path, c) : null, state: text === null ? 'missing' : 'ok', note: f.reason === 'include' ? `@imported by ${f.trigger ? rel(f.trigger, fundRoot) : 'a CLAUDE.md'}` : f.memoryType === 'Local' ? 'CLAUDE.local.md' : path })
  }
  const id = append.split('\n\n---\n\n')[0]
  rows.push({ type: 'agent', key: 'agent:identity', label: 'Identity', tokens: tok(id), cap: null, state: 'ok', note: 'name, role, department and what it may commit under' })
  rows.push({ type: 'agent', key: 'agent:brief', label: 'Brief', tokens: brief.text === null ? null : tok(brief.text), cap: c?.agent ?? null, state: brief.text === null ? 'missing' : 'ok', note: brief.path })
  for (const b of books) rows.push(bookRow(b, c))
  rows.push(...unmeasured(servers).filter(r => r.type === 'mcp' || r.type === 'skills' || r.type === 'memory'))
  const sum = (t: CtxRow['type']) => rows.filter(r => r.type === t).reduce((n, r) => n + (r.tokens ?? 0), 0)
  const capOf = (t: CtxRow['type']) => (c && rows.some(r => r.type === t) ? rows.filter(r => r.type === t).reduce((n, r) => n + (r.cap ?? 0), 0) : null)
  const budgets: CtxBudget[] = [
    { type: 'base', tokens: sum('base'), cap: c?.base ?? null },
    { type: 'workspace', tokens: sum('workspace'), cap: capOf('workspace') },
    { type: 'agent', tokens: rows.find(r => r.key === 'agent:brief')?.tokens ?? 0, cap: c?.agent ?? null },
    { type: 'boot', tokens: sum('boot'), cap: c?.boot ?? null },
  ]
  const appendTokens = tok(append)
  return { ctx: { ...head, rows, budgets, appendTokens, known: sum('base') + sum('user') + sum('workspace') + appendTokens }, append }
}
