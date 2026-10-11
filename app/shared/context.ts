// THE CONTEXT ROOM's wire types (server/context/, src/rooms/context/): what each agent loads at boot, by type.
// Type-only and pure helpers, so the server and the UI share one reading. Tokens are chars / 4 (the estimate
// server/chat/law.ts and app/tools/context.py use); caps come from app/tools/context-caps.json, never from here.

/** the layers, in the order a boot meets them. `unknown` rows are never measured: system, skills, memory, mcp */
export const CTX_TYPES = [
  { id: 'system', label: 'System', title: "Claude Code's own system prompt and tool list: not measured" },
  { id: 'base', label: 'Base', title: "the fund root's CLAUDE.md, loaded by Claude Code from the cwd up" },
  { id: 'user', label: 'User', title: "the owner's own ~/.claude/CLAUDE.md, outside the fund" },
  { id: 'workspace', label: 'Workspace', title: 'every CLAUDE.md from the repo down to the agent\'s cwd, and what they @import' },
  { id: 'agent', label: 'Agent', title: 'the identity line and the brief: the first two parts of the appended system prompt' },
  { id: 'boot', label: 'Booted chapters', title: 'the books and chapters in the agent\'s boot list, appended in full' },
  { id: 'mcp', label: 'MCP', title: 'the servers every seat carries; their tool lists are not measured' },
  { id: 'skills', label: 'Skills', title: 'what skills and plugins reach the seat: not measured' },
  { id: 'memory', label: 'Memory', title: "the owner's auto-memory for this folder: not measured" },
] as const
export type CtxType = typeof CTX_TYPES[number]['id']

/** ok = read and counted · missing = the file or chapter is not on disk (the append says so) · unknown = never measured */
export type CtxState = 'ok' | 'missing' | 'unknown'

export type CtxRow = {
  type: CtxType
  key: string                  // the same file or chapter has the same key for every agent
  label: string
  tokens: number | null        // null = unknown, never a zero
  cap: number | null           // the cap that applies to this one row; null = none
  warn?: number                // a softer line under the cap (chapterTarget)
  state: CtxState
  note?: string
}

export type CtxBudget = { type: 'base' | 'workspace' | 'agent' | 'boot'; tokens: number; cap: number | null }

export type CtxAgent = {
  id: string; name: string; kind: string; mode: 'active' | 'dormant'; dept: string; cwd: string
  rows: CtxRow[]
  budgets: CtxBudget[]         // each layer against its cap(s)
  appendTokens: number         // the whole systemPrompt.append, separators included
  known: number                // base + user + workspace + append: what was measured; the unknown rows are not in it
  error?: string               // the agent could not be read at all (its cwd escapes the fund, ...)
}

export type CtxCaps = { base: number; agent: number; boot: number; chapter: number; chapterTarget: number; workspace: number; screen: number; book: number }

export type CtxAll = {
  caps: CtxCaps | null         // null = context-caps.json could not be read: no cap is drawn, none is invented
  capsError?: string
  agents: CtxAgent[]
  problems: { path: string; error: string }[]   // roster files that did not parse
  mcp: { servers: string[]; problems: string[] }
  at: number
}

/** one agent in full: the prompt as launched, the brief and header to edit, and the hash the editor builds on */
export type CtxDetail = {
  id: string; name: string; mode: 'active' | 'dormant'
  prompt: string               // exactly systemAppend(): what buildLaunch appends on main
  promptTokens: number
  brief: { path: string; text: string | null; tokens: number; editable: boolean; why?: string }
  header: { model: string; effort: string }
  boot: { ref: string; tokens: number | null; state: CtxState; title: string }[]
  hash: string                 // of the roster file as read; the save sends it back as `base`
  file: string                 // the roster file, fund-relative
}

/** the open conversations still running on a prompt older than the file on disk */
export type CtxDrift = {
  open: number                 // conversations with a live process (live, waiting or idle)
  stale: number                // of those, on an old prompt (a changed or removed brief or boot book, or a different boot list)
  unknown: number              // of those, with no manifest to compare (booted before the manifest existed)
  ids: string[]                // the stale ones
}

export type CtxSaved = { written: boolean; committed: boolean; sha?: string; hash: string; paths: string[]; note?: string; changed: string[]; drift: CtxDrift | null; driftError?: string }

/** pure: a row shown in the matrix's Shared filter is one every agent has, with the same count */
export function sharedRow(cells: (CtxRow | undefined)[]): boolean {
  if (cells.some(c => !c)) return false
  const t = (cells[0] as CtxRow).tokens
  return cells.every(c => (c as CtxRow).tokens === t)
}

/** 1234 -> "1.2k", 842 -> "842"; null stays a question mark */
export const fmtTokens = (n: number | null): string => (n === null ? '?' : n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n))
