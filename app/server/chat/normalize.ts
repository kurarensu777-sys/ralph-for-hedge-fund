import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { FUND_ROOT } from '../paths.ts'
import type { Action, Entry, ChatMeta, Todo, ToolRes } from './types.ts'

// NORMALIZE BEFORE YOU RENDER (ported from machine/server/normalize.ts). The SDK's message union
// has 40+ members and its tool names grow every release; the UI must never switch on "Grep" vs
// "Glob". Everything collapses HERE into one small closed model with a SEMANTIC action type above
// the tool name. Unknown types are dropped in silence by construction.

export type Emit =
  | { t: 'entry'; e: Entry }
  | { t: 'meta'; m: Partial<ChatMeta> }
  | { t: 'usage'; u: Usage }
  | { t: 'head'; uuid: string }            // the session id moved (a fork / compaction)

/** turn = this turn's main loop (per-turn); total = modelUsage + total_cost_usd, CUMULATIVE per process */
export type Tok = { tokensIn: number; tokensOut: number; cacheRead: number; cacheWrite: number; costUsd: number }
export type Usage = { model?: string; turn: Tok; total: Tok }

export type NormState = {
  calls: Map<string, { name: string; action: Action }>
  msgId: string
  blocks: Map<number, { kind: 'text' | 'thinking'; ord: number; text: string }>
  ord: { text: number; thinking: number }
  /** the uuid of the last transcript chain entry seen - a send records it as its rewind point */
  lastUuid: string
}

export const newNormState = (): NormState => ({ calls: new Map(), msgId: '', blocks: new Map(), ord: { text: 0, thinking: 0 }, lastUuid: '' })

// Blocks are keyed by their ORDINAL WITHIN THEIR OWN KIND, so a streamed delta and the final
// message name the same block (keying on the raw index rendered every thinking-led answer twice).
const blockId = (kind: 'text' | 'thinking', msgId: string, ord: number) => `${kind === 'text' ? 'a' : 'k'}:${msgId}:${ord}`
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + `\n... +${s.length - n} more chars` : s)
const base = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p
const str = (v: unknown) => (typeof v === 'string' ? v : '')
const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim()

function cmdSummary(command: string): string {
  const parts = command.replace(/\\\s*\n\s*/g, ' ').split(/\s*(?:&&|\|\||;|\|)\s*/)
  const words = parts.map(p => p.trim().split(/\s+/)[0]).filter(Boolean)
  return words.slice(0, 4).join(', ') + (words.length > 4 ? '...' : '')
}

/** an absolute path -> fund-relative, but only for markdown inside the fund (a book) */
export function bookRel(path: string): string | undefined {
  if (!/\.md$/i.test(path)) return undefined
  const norm = (s: string) => s.replace(/\\/g, '/').toLowerCase()
  const root = norm(FUND_ROOT).replace(/\/?$/, '/')
  if (!norm(path).startsWith(root)) return undefined
  const rel = path.replace(/\\/g, '/').slice(root.length)
  return rel && !rel.includes('..') ? rel : undefined
}

export function actionFor(name: string, input: Record<string, unknown>): Action {
  const path = str(input.file_path) || str(input.path) || str(input.notebook_path)
  const rel = (p: string) => { const r = bookRel(p); return r ? { rel: r } : {} }
  switch (name) {
    case 'Read': case 'NotebookRead':
      return { type: 'read', verb: 'Read', target: base(path), detail: path, ...rel(path) }
    case 'Edit': case 'MultiEdit': case 'NotebookEdit': {
      const old = str(input.old_string), neu = str(input.new_string)
      return { type: 'edit', verb: 'Edit', target: base(path), detail: path, ...rel(path), ...(old || neu ? { diff: { old: clip(old, 8000), new: clip(neu, 8000) } } : {}) }
    }
    case 'Write': {
      const content = str(input.content)
      return { type: 'edit', verb: 'Write', target: base(path), detail: path, ...rel(path), ...(content ? { diff: { old: '', new: clip(content, 8000) } } : {}) }
    }
    case 'Bash': case 'PowerShell': case 'BashOutput': case 'KillShell': {
      const cmd = str(input.command)
      const desc = str(input.description)
      return { type: 'command', verb: name === 'PowerShell' ? 'PowerShell' : 'Bash', target: desc || (cmd ? cmdSummary(cmd) : ''), detail: oneLine(cmd) || desc, ...(cmd ? { cmd: clip(cmd, 6000) } : {}) }
    }
    case 'Grep': {
      const q = oneLine(str(input.pattern) || str(input.query))
      return { type: 'search', verb: 'Search', target: clip(q, 60), detail: str(input.path) || q }
    }
    case 'Glob': case 'LS': {
      const q = oneLine(str(input.pattern) || str(input.path))
      return { type: 'search', verb: name === 'LS' ? 'List' : 'Find', target: clip(q, 60), detail: q }
    }
    case 'WebFetch': case 'WebSearch': {
      const u = str(input.url) || str(input.query)
      let host = u
      try { host = new URL(u).host } catch { /* a query, not a url */ }
      return { type: 'webfetch', verb: name === 'WebSearch' ? 'Search web' : 'Fetch', target: clip(host, 60), detail: u }
    }
    case 'Skill':
      return { type: 'skill', verb: 'Skill', target: str(input.command) || str(input.skill) || str(input.name), detail: oneLine(str(input.args)) }
    case 'Task': case 'Agent':
      return { type: 'task', verb: 'Task', target: str(input.description) || str(input.subagent_type) || 'subagent', detail: oneLine(str(input.prompt)).slice(0, 200) }
    case 'TodoWrite': {
      const raw = Array.isArray(input.todos) ? input.todos : []
      const todos: Todo[] = raw.map((t: any): Todo => ({
        text: str(t?.content) || str(t?.subject) || str(t?.text) || str(t?.activeForm),
        status: t?.status === 'completed' ? 'completed' : t?.status === 'in_progress' ? 'in_progress' : 'pending',
        ...(str(t?.activeForm) ? { active: str(t?.activeForm) } : {}),
      })).filter((t: Todo) => t.text)
      const done = todos.filter(t => t.status === 'completed').length
      return { type: 'todo', verb: 'Todos', target: todos.length ? `${done}/${todos.length}` : '', todos }
    }
  }
  const mcp = name.match(/^mcp__([^_]+(?:_[^_]+)*)__(.+)$/)
  if (mcp) return { type: 'other', verb: mcp[1], target: mcp[2], detail: oneLine(JSON.stringify(input ?? {})).slice(0, 200) }
  return { type: 'other', verb: name, detail: oneLine(JSON.stringify(input ?? {})).slice(0, 200) }
}

function resFor(structured: unknown): ToolRes | undefined {
  const o = structured as Record<string, any> | undefined
  if (!o || typeof o !== 'object') return undefined
  const res: ToolRes = {}
  if (typeof o.stdout === 'string' && o.stdout) res.stdout = clip(o.stdout, 6000)
  if (typeof o.stderr === 'string' && o.stderr) res.stderr = clip(o.stderr, 3000)
  if (Array.isArray(o.structuredPatch) && o.structuredPatch.every((h: any) => Array.isArray(h?.lines)))
    res.patch = o.structuredPatch.slice(0, 40).map((h: any) => ({ oldStart: Number(h.oldStart) || 0, newStart: Number(h.newStart) || 0, lines: h.lines.slice(0, 400).map((l: unknown) => String(l)) }))
  if (o.file && typeof o.file.numLines === 'number') res.lines = o.file.numLines
  return Object.keys(res).length ? res : undefined
}

function resultBody(structured: unknown, text: string): string {
  const o = structured as Record<string, any> | undefined
  if (o && typeof o === 'object') {
    if (typeof o.stdout === 'string' || typeof o.stderr === 'string') return [o.stdout, o.stderr].filter(Boolean).join('\n')
    if (o.file && typeof o.file.content === 'string') return o.file.content
    if (typeof o.content === 'string') return o.content
    if (Array.isArray(o.filenames)) return o.filenames.join('\n')
  }
  return text
}

export const textOf = (content: unknown): string => {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map((b: any) => (typeof b === 'string' ? b : b?.type === 'text' ? b.text : '')).filter(Boolean).join('\n')
}

/** one SDK message in, zero or more emissions out */
export function normalize(m: SDKMessage, st: NormState, ts = Date.now()): Emit[] {
  const out: Emit[] = []
  const anyM = m as any
  const nested = !!anyM.parent_tool_use_id

  switch (m.type) {
    case 'system': {
      if (m.subtype === 'init') {
        out.push({ t: 'meta', m: { model: anyM.model } })
        if (anyM.session_id) out.push({ t: 'head', uuid: String(anyM.session_id) })
        return out
      }
      if (m.subtype === 'compact_boundary') {
        const pre = anyM.compact_metadata?.pre_tokens
        // ONE divider; the runner rewrites its content with the books it restored (reread.ts)
        out.push({ t: 'entry', e: { id: `s:${m.uuid}`, ts, kind: 'system', content: `Context compacted${pre ? ` (was ${Math.round(pre / 1000)}k tokens)` : ''}`, meta: { compact: true, ...(pre ? { pre: Number(pre) } : {}) } } })
        return out
      }
      // PHASE, NEVER BUSY: a null status means "not calling the API", which is every turn that is
      // running a tool. The turn's ONLY boundary is `result`.
      if (m.subtype === 'status') {
        const s = anyM.status
        out.push({ t: 'meta', m: { phase: s === 'requesting' || s === 'compacting' ? s : 'working' } })
        return out
      }
      return out
    }

    case 'stream_event': {
      const ev: any = anyM.event
      if (ev?.type === 'message_start') {
        st.msgId = ev.message?.id ?? ''
        st.blocks.clear()
        st.ord = { text: 0, thinking: 0 }
        return out
      }
      if (ev?.type === 'content_block_start') {
        const k = ev.content_block?.type
        if (k === 'text' || k === 'thinking') st.blocks.set(ev.index, { kind: k, ord: st.ord[k as 'text' | 'thinking']++, text: '' })
        return out
      }
      if (ev?.type === 'content_block_delta') {
        const b = st.blocks.get(ev.index)
        if (!b) return out
        const d = ev.delta
        const add = d?.type === 'text_delta' ? d.text : d?.type === 'thinking_delta' ? d.thinking : ''
        if (!add) return out
        b.text += add
        out.push({ t: 'entry', e: { id: blockId(b.kind, st.msgId, b.ord), ts, kind: b.kind === 'text' ? 'assistant' : 'thinking', content: b.text, streaming: true, nested } })
      }
      return out
    }

    case 'assistant': {
      const msg: any = anyM.message
      const id = msg?.id ?? m.uuid
      if (m.uuid && !nested) st.lastUuid = m.uuid
      const ord = { text: 0, thinking: 0 }
      for (const b of msg?.content ?? []) {
        if (b.type === 'text' && b.text?.trim())
          out.push({ t: 'entry', e: { id: blockId('text', id, ord.text++), ts, kind: 'assistant', content: b.text, nested } })
        else if (b.type === 'thinking' && b.thinking?.trim())
          out.push({ t: 'entry', e: { id: blockId('thinking', id, ord.thinking++), ts, kind: 'thinking', content: b.thinking, nested } })
        else if (b.type === 'tool_use') {
          const action = actionFor(b.name, b.input ?? {})
          st.calls.set(b.id, { name: b.name, action })
          out.push({ t: 'entry', e: { id: `t:${b.id}`, ts, kind: 'tool', toolUseId: b.id, status: 'created', action, nested, content: '' } })
        }
      }
      if (anyM.error) out.push({ t: 'entry', e: { id: `e:${m.uuid}`, ts, kind: 'error', content: String(anyM.error?.message ?? anyM.error) } })
      return out
    }

    // A `user` event is never the owner: the SDK does not replay our own input, so the owner's
    // bubble is minted at send time and this branch is a tool RESULT coming home to its call.
    case 'user': {
      if (anyM.isReplay) return out
      if (m.uuid && !nested) st.lastUuid = m.uuid
      const content = anyM.message?.content
      if (!Array.isArray(content)) return out
      for (const b of content) {
        if (b?.type !== 'tool_result') continue
        const call = st.calls.get(b.tool_use_id)
        const action = call?.action ?? { type: 'other' as const, verb: 'Tool' }
        const structured = anyM.tool_use_result
        const body = resultBody(structured, textOf(b.content))
        out.push({ t: 'entry', e: {
          id: `t:${b.tool_use_id}`, ts, kind: 'tool', toolUseId: b.tool_use_id,
          status: b.is_error ? 'failed' : 'success', action, nested, res: resFor(structured), content: clip(body ?? '', 6000),
        } })
        st.calls.delete(b.tool_use_id)
      }
      return out
    }

    // Turn close. modelUsage + total_cost_usd are CUMULATIVE per process, usage is per turn - the runner diffs.
    case 'result': {
      const r = anyM
      const models = Object.keys(r.modelUsage ?? {})
      const main = models.find(k => !/haiku/i.test(k)) ?? models[0]
      out.push({ t: 'meta', m: { busy: false, phase: undefined, ...(main ? { model: main } : {}) } })
      const u = r.usage ?? {}
      const total: Tok = { tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheWrite: 0, costUsd: Number(r.total_cost_usd) || 0 }
      for (const mu of Object.values<any>(r.modelUsage ?? {})) {
        total.tokensIn += Number(mu?.inputTokens) || 0
        total.tokensOut += Number(mu?.outputTokens) || 0
        total.cacheRead += Number(mu?.cacheReadInputTokens) || 0
        total.cacheWrite += Number(mu?.cacheCreationInputTokens) || 0
      }
      out.push({ t: 'usage', u: {
        model: main, total,
        turn: { tokensIn: Number(u.input_tokens) || 0, tokensOut: Number(u.output_tokens) || 0, cacheRead: Number(u.cache_read_input_tokens) || 0, cacheWrite: Number(u.cache_creation_input_tokens) || 0, costUsd: 0 },
      } })
      if (r.subtype !== 'success' || r.is_error)
        out.push({ t: 'entry', e: { id: `e:${m.uuid}`, ts, kind: 'error', content: String(r.result ?? (Array.isArray(r.errors) ? r.errors.join('\n') : '') ?? r.subtype) || r.subtype } })
      for (const d of r.permission_denials ?? []) {
        const action = st.calls.get(d.tool_use_id)?.action ?? actionFor(d.tool_name, d.tool_input ?? {})
        out.push({ t: 'entry', e: { id: `t:${d.tool_use_id}`, ts, kind: 'tool', toolUseId: d.tool_use_id, status: 'denied', action, content: 'denied by the settings rules' } })
      }
      return out
    }
  }
  return out
}
