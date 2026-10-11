// The chat wire model: what the server emits and the chats room renders. Type-only, so the UI
// imports it straight from here (src/rooms/chats/*). Ported from machine/server/normalize.ts.

export type ActionType = 'read' | 'edit' | 'command' | 'search' | 'webfetch' | 'skill' | 'task' | 'todo' | 'other'
export type EntryKind = 'user' | 'assistant' | 'thinking' | 'tool' | 'system' | 'error' | 'decision'
export type ToolStatus = 'created' | 'success' | 'failed' | 'denied'
export type Todo = { text: string; status: 'pending' | 'in_progress' | 'completed'; active?: string }   // active = the item's activeForm ("Rendering the bar")

export type DecisionQuestion = { question: string; header: string; multiSelect?: boolean; options: { label: string; description?: string }[] }
export type Decision = {
  kind: 'plan' | 'ask'
  toolUseId: string
  plan?: string
  questions?: DecisionQuestion[]
  settled?: { verdict: 'approved' | 'rejected' | 'answered' | 'lost'; answers?: Record<string, string>; note?: string }
}

export type Action = {
  type: ActionType
  verb: string
  target?: string
  detail?: string
  cmd?: string
  diff?: { old: string; new: string }
  todos?: Todo[]
  rel?: string             // a fund-relative .md path: this row touched a book
}

export type ToolRes = {
  stdout?: string
  stderr?: string
  patch?: { oldStart: number; newStart: number; lines: string[] }[]
  lines?: number
}

export type Entry = {
  id: string
  ts: number
  kind: EntryKind
  content: string
  action?: Action
  status?: ToolStatus
  toolUseId?: string
  res?: ToolRes
  nested?: boolean
  streaming?: boolean
  decision?: Decision
  images?: string[]
  /** user entries: the last transcript chain entry BEFORE this message - the rewind point */
  forkAt?: string
  /** a compaction divider: the pre-compaction size and the books put back (titles) */
  meta?: EntryMeta
}

export type EntryMeta = { compact?: boolean; pre?: number; books?: string[]; listed?: string[]; missing?: string[] }

export type ChatState = 'live' | 'waiting' | 'idle' | 'closed'

export type ChatMeta = {
  live: boolean            // a process is attached to this conversation
  busy: boolean            // a turn is open (set on send, cleared ONLY by `result`)
  waiting: boolean         // a decision is parked on the owner
  bg?: string[]            // the background commands and subagents its process holds, by label; absent when none (B-0609)
  model?: string
  engine?: 'claude' | 'codex' | 'deepseek' | 'grok'   // the provider this hand runs on: what it can and cannot do (shared/engines.ts CAPS)
  contextPct?: number
  contextTokens?: number
  maxTokens?: number
  phase?: 'requesting' | 'compacting' | 'working' | 'awaiting'
}

export type Conversation = {
  id: string
  agent: string
  title: string
  state: ChatState
  startedAt: number
  lastAt: number
  tokensIn: number
  tokensOut: number
  costUsd: number
  model: string | null     // override; null = the roster's default
  effort: string | null
  transcript: string | null
  /** the list only: the last turn ended on an error; absent when fundd holds no ring for it (unknown) */
  failed?: boolean
}

export type AgentRow = {
  id: string; name: string; kind: 'standing' | 'dashboard'; mode: 'active' | 'dormant'
  role: string; dept: string; cwd: string; model: string; effort: string
  working: number; waiting: number; open: number; total: number
}

export type TerminalInfo = { id: string; agent: string | null; cwd: string; title: string | null; alive: boolean; pid: number; createdAt: number }

/** a delta on topic chat:<id> */
export type ChatDelta =
  | { t: 'entry'; e: Entry }
  | { t: 'meta'; m: ChatMeta }
  | { t: 'reset'; entries: Entry[] }
