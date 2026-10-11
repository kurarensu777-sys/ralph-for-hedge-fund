// WHAT AN AGENT LOADS BEFORE IT SAYS A WORD, layer by layer, the way `python app/tools/context.py --table`
// counts it: the base (the fund's CLAUDE.md), the workspace (every CLAUDE.md from the repo down to its cwd), the
// agent's own two-line prompt, and its boot list. The boot list is the one layer an agent's roster edits;
// its cap (context-caps.json "boot") is the meter's. The rest ride beside it so a row reads "all in X".
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Caps } from './caps.ts'
import type { AgentLayers } from './types.ts'

const tok = (s: string) => Math.round(s.length / 4)

/** every CLAUDE.md from the fund root's child down to the cwd (the root's own is the base, not a workspace) */
export function workspaceChain(cwd: string, exists: (rel: string) => boolean): string[] {
  const parts = !cwd || cwd === '.' ? [] : cwd.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').split('/')
  const out: string[] = []
  let cur = ''
  for (const p of parts) {
    cur = cur ? `${cur}/${p}` : p
    if (exists(`${cur}/CLAUDE.md`)) out.push(`${cur}/CLAUDE.md`)
  }
  return out
}

/** tokens of one fund-relative file; null = unreadable (the layer is then unknown, never a zero) */
export type Reader = (rel: string) => string | null

export const readerAt = (fundRoot: string): Reader => rel => { try { return readFileSync(join(fundRoot, rel), 'utf8') } catch { return null } }

/** pure over the reader: the layers of one agent. A layer that cannot be read is null and the total is null with it */
export function layersOf(a: { cwd: string }, boot: number, agentTokens: number | null, read: Reader, c: Pick<Caps, 'base' | 'agent' | 'boot'>): AgentLayers {
  const baseText = read('CLAUDE.md')
  const base = baseText === null ? null : tok(baseText)
  const files = workspaceChain(a.cwd, rel => read(rel) !== null)
  const ws = files.map(f => ({ file: f, tokens: tok(read(f) ?? '') }))
  const workspace = ws.reduce((n, f) => n + f.tokens, 0)
  const parts = [base, agentTokens]
  const total = parts.some(p => p === null) ? null : (base as number) + workspace + (agentTokens as number) + boot
  return { base, workspace, workspaceFiles: ws, agent: agentTokens, boot, total, caps: { base: c.base, agent: c.agent, boot: c.boot } }
}
