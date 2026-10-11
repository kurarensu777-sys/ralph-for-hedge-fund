import { closeSync, existsSync, openSync, readSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { CODEX_DEFAULT, CODEX_HOME } from './catalog.ts'
import { spawnForeign, type ForeignState } from './foreign.ts'
import type { ContextUse, ForeignHand } from './types.ts'

// CODEX (`codex exec --json`): a different vocabulary for the same story, so this is a translation table. Ported
// from the marketing studio's adapter (studio/server/engines/codex.ts) and NOT run against a live Codex here: the
// Codex CLI is not installed on this machine (2026-10-06), so the stream shapes below are the studio's record of
// them and test/chats-engines.test.ts feeds them from fixtures.
//
// `thread.started` carries the id resume takes, `turn.started`/`turn.completed` bracket a turn, and everything the
// agent DOES arrives as an `item`. A command is announced at `item.started` and answered at `item.completed`; a
// message or reasoning block only ever appears completed. So started ids are remembered, and an item that completes
// without having started emits its call and its result together (a result under no call is an anonymous blob).

let seq = 0
const uid = () => `cdx-${Date.now().toString(36)}-${(seq++).toString(36)}`

const TOOL_NAME: Record<string, string> = {
  command_execution: 'Bash', file_change: 'Edit', patch_apply: 'Edit', web_search: 'WebSearch', mcp_tool_call: 'Task', todo_list: 'TodoWrite',
}

/** Codex runs every command through a login shell (`/bin/zsh -lc "sed -n 2p x"`); the feed reads the inner command */
export function unwrapShell(command: string): string {
  const m = command.match(/^\s*(?:\/\S+\/)?(?:ba|z|da)?sh\s+(?:-[a-z]+\s+)*-(?:l?c)\s+(['"])([\s\S]*)\1\s*$/)
  return m ? m[2] : command
}

function toolInput(item: Record<string, unknown>): Record<string, unknown> {
  const type = String(item.type ?? '')
  if (type === 'command_execution') return { command: unwrapShell(String(item.command ?? '')) }
  if (type === 'file_change' || type === 'patch_apply') {
    const changes = (item.changes ?? item.files) as Array<Record<string, unknown>> | undefined
    const first = Array.isArray(changes) ? changes[0] : undefined
    return { file_path: String(first?.path ?? item.path ?? ''), content: String(first?.diff ?? '') }
  }
  if (type === 'web_search') return { query: String(item.query ?? '') }
  if (type === 'mcp_tool_call') return { description: `${item.server ?? ''} ${item.tool ?? ''}`.trim() }
  return {}
}

function itemResult(item: Record<string, unknown>): { text: string; failed: boolean } {
  if (String(item.type ?? '') === 'command_execution') {
    const code = item.exit_code
    return { text: String(item.aggregated_output ?? ''), failed: typeof code === 'number' && code !== 0 }
  }
  const status = String(item.status ?? '')
  return { text: String(item.output ?? item.result ?? item.summary ?? ''), failed: status === 'failed' || status === 'error' }
}

const toolUse = (id: string, name: string, input: Record<string, unknown>, sid: string): SDKMessage =>
  ({ type: 'assistant', uuid: uid(), session_id: sid, message: { id: uid(), content: [{ type: 'tool_use', id, name, input }] } }) as unknown as SDKMessage
const toolResult = (id: string, text: string, failed: boolean, sid: string): SDKMessage =>
  ({ type: 'user', uuid: uid(), session_id: sid, message: { content: [{ type: 'tool_result', tool_use_id: id, content: text, is_error: failed }] } }) as unknown as SDKMessage
const textBlock = (kind: 'text' | 'thinking', body: string, sid: string): SDKMessage =>
  ({ type: 'assistant', uuid: uid(), session_id: sid, message: { id: uid(), content: [kind === 'text' ? { type: 'text', text: body } : { type: 'thinking', thinking: body }] } }) as unknown as SDKMessage

// THE CONTEXT GAUGE reads Codex's own rollout, never the turn's usage line: `turn.completed.usage` is the SUM over
// every model request the turn made (a four-command turn on a 20k context reported 137,770 input tokens). The honest
// pair is in the rollout: last_token_usage.input_tokens over model_context_window.
const ROLLOUTS = new Map<string, string>()
export function rolloutFile(threadId: string, home = CODEX_HOME()): string | undefined {
  const known = ROLLOUTS.get(threadId)
  if (known && existsSync(known)) return known
  const sub = (p: string): string[] => { try { return readdirSync(p, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name).sort().reverse() } catch { return [] } }
  const root = join(home, 'sessions')
  for (const y of sub(root)) for (const m of sub(join(root, y))) for (const d of sub(join(root, y, m))) {
    const dir = join(root, y, m, d)
    let names: string[] = []
    try { names = readdirSync(dir) } catch { continue }
    const hit = names.find(n => n.endsWith(`-${threadId}.jsonl`))
    if (hit) { const full = join(dir, hit); ROLLOUTS.set(threadId, full); return full }
  }
  return undefined
}
function tail(file: string, bytes = 400_000): string {
  const size = statSync(file).size
  const take = Math.min(size, bytes)
  const fd = openSync(file, 'r')
  try {
    const buf = Buffer.alloc(take)
    readSync(fd, buf, 0, take, size - take)
    const txt = buf.toString('utf8')
    return take < size ? txt.slice(txt.indexOf('\n') + 1) : txt
  } finally { closeSync(fd) }
}
export function usageFromRollout(lines: string[]): ContextUse | undefined {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes('"token_count"')) continue
    try {
      const info = (JSON.parse(lines[i]) as any)?.payload?.info
      const used = info?.last_token_usage?.input_tokens, max = info?.model_context_window
      if (typeof used === 'number' && typeof max === 'number' && max > 0) return { percentage: Math.min(100, (used / max) * 100), totalTokens: used, maxTokens: max }
    } catch { /* a torn line at the window's edge: keep walking back */ }
  }
  return undefined   // no reading rather than a guess: the gauge does not draw
}
export function codexUsage(threadId: string): ContextUse | undefined {
  const file = threadId ? rolloutFile(threadId) : undefined
  if (!file) return undefined
  try { return usageFromRollout(tail(file).split('\n')) } catch { return undefined }
}

export function adapt(raw: Record<string, unknown>, st: ForeignState): SDKMessage[] {
  const t = String(raw.type ?? '')
  const sid = st.sessionId ?? ''

  if (t === 'thread.started') {
    st.sessionId = String(raw.thread_id ?? '')
    // no session_id on the message handed on (see grok.ts): a Codex thread is not a Claude transcript
    return [{ type: 'system', subtype: 'init', uuid: uid(), model: st.model ?? '' } as unknown as SDKMessage]
  }

  if (t === 'item.started' || t === 'item.completed') {
    const item = (raw.item ?? {}) as Record<string, unknown>
    const type = String(item.type ?? '')
    const id = String(item.id ?? uid())
    if (type === 'agent_message') { const body = String(item.text ?? '').trim(); return t === 'item.completed' && body ? [textBlock('text', body, sid)] : [] }
    if (type === 'reasoning') { const body = String(item.text ?? item.summary ?? '').trim(); return t === 'item.completed' && body ? [textBlock('thinking', body, sid)] : [] }
    if (type === 'error') return [{ type: 'result', subtype: 'error_during_execution', uuid: uid(), is_error: true, session_id: sid, result: String(item.message ?? item.text ?? 'error') } as unknown as SDKMessage]
    const name = TOOL_NAME[type] ?? type
    const input = toolInput(item)
    st.started ??= new Set<string>()
    if (t === 'item.started') { st.started.add(id); return [toolUse(id, name, input, sid)] }
    const { text, failed } = itemResult(item)
    if (!st.started.has(id)) return [toolUse(id, name, input, sid), toolResult(id, text, failed, sid)]
    st.started.delete(id)
    return [toolResult(id, text, failed, sid)]
  }

  if (t === 'turn.completed' || t === 'turn.failed') {
    const u = (raw.usage ?? {}) as Record<string, number>
    const measured = codexUsage(st.sessionId ?? '')
    if (measured) st.usage = measured
    // cumulative per hand, like the SDK's: the runner diffs each result against the last
    st.cum ??= { cost: 0, models: {} }
    const key = st.model || 'codex'
    const c = (st.cum.models[key] ??= { inputTokens: 0, outputTokens: 0 })
    c.inputTokens += u.input_tokens ?? 0
    c.outputTokens += u.output_tokens ?? 0
    const failed = t === 'turn.failed'
    return [{
      type: 'result', uuid: uid(), session_id: sid, subtype: failed ? 'error_during_execution' : 'success', is_error: failed,
      result: failed ? String((raw.error as Record<string, unknown>)?.message ?? 'the turn failed') : '',
      usage: { input_tokens: u.input_tokens ?? 0, output_tokens: u.output_tokens ?? 0 },
      modelUsage: st.cum.models,
    } as unknown as SDKMessage]
  }
  return []
}

export function codexArgv(o: { model: string; effort?: string; resumeId?: string; cwd: string }): string[] {
  return [
    'exec',
    // `resume` is a SUBCOMMAND of exec, directly after it with its id, before any option
    ...(o.resumeId ? ['resume', o.resumeId] : []),
    '--json', '--skip-git-repo-check',
    // writes confined to the agent's own folder, never `--dangerously-bypass-approvals-and-sandbox`: Codex has no
    // equivalent of the fund's deny list, so its sandbox is the one fence it carries (the trading guard: a Codex
    // hand never gets a folder it can write outside of, and runner.ts refuses it a seat whose folder is execution/)
    '--sandbox', 'workspace-write',
    ...(o.model && o.model !== CODEX_DEFAULT ? ['-m', o.model] : []),
    ...(o.effort ? ['-c', `model_reasoning_effort="${o.effort}"`] : []),
    // `-C` is exec-only: `codex exec resume` rejects it, and the process cwd is already the folder
    ...(o.resumeId ? [] : ['-C', o.cwd]),
    '-',   // the prompt comes from stdin, which keeps a long message off the argv length limit
  ]
}

export function spawnCodex(o: { bin: string; cwd: string; env: Record<string, string | undefined>; model: string; effort?: string; resumeId?: string; preamble?: string; signal: AbortSignal; prompts: AsyncIterable<SDKUserMessage> }): ForeignHand {
  return spawnForeign({
    label: 'Codex', bin: o.bin, cwd: o.cwd, env: o.env, model: o.model, preamble: o.preamble, signal: o.signal,
    prompt: 'stdin', seed: { sessionId: o.resumeId },
    argv: a => codexArgv({ model: a.model, effort: o.effort, resumeId: a.resumeId, cwd: o.cwd }),
    adapt,
  }, o.prompts)
}
