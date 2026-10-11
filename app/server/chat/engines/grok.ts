import { readFileSync } from 'node:fs'
import type { SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { spawnForeign, type ForeignState } from './foreign.ts'
import type { ForeignHand } from './types.ts'

// GROK (the Grok Build CLI, ~/.grok/bin/grok): `grok --prompt-file f --output-format streaming-messages-json` prints
// NDJSON in the Anthropic Messages wire format (system/init, stream_event with --include-partial-messages, assistant,
// user tool_result, result), so this adapter is thin: it renames the CLI's tools to the names normalize.ts knows,
// flattens its JSON tool results to the text the feed shows, keeps message ids unique across turns (the CLI restarts
// them at msg_0 every process) and keeps usage cumulative (one process per turn reports per turn).
// Read from `grok --help`, ~/.grok/docs/user-guide/14-headless-mode.md and a live turn, 2026-10-06, grok 1.0.46.

// Grok's tool -> the name actionFor() knows, so a Grok turn renders with the same verbs and icons as any other
const TOOL: Record<string, string> = {
  run_terminal_command: 'Bash', read_file: 'Read', search_replace: 'Edit', write: 'Write', grep: 'Grep', list_dir: 'LS',
  web_search: 'WebSearch', web_fetch: 'WebFetch', todo_write: 'TodoWrite', spawn_subagent: 'Task',
}
const clip = (s: string, n = 6000) => (s.length > n ? s.slice(0, n) : s)

function input(name: string, i: Record<string, unknown>): Record<string, unknown> {
  const o = { ...i }
  if (name === 'read_file' && o.target_file && !o.file_path) o.file_path = o.target_file
  if (name === 'list_dir' && !o.path) o.path = o.target_directory ?? o.relative_workspace_path ?? o.directory
  if (name === 'spawn_subagent' && !o.description) o.description = o.name ?? o.agent
  return o
}

/** a Grok tool result is a JSON blob typed by tool ({"type":"Bash","output_for_prompt":"exit: 0\nhi"}); the feed wants its text */
export function resultText(content: unknown): string {
  const raw = typeof content === 'string' ? content : Array.isArray(content) ? content.map((b: any) => (typeof b === 'string' ? b : b?.text ?? '')).join('\n') : ''
  let j: any
  try { j = JSON.parse(raw) } catch { return raw }
  if (!j || typeof j !== 'object') return raw
  const pick = (o: any, depth: number): string | null => {
    if (!o || typeof o !== 'object' || depth > 3) return null
    for (const k of ['output_for_prompt', 'tool_output_for_prompt_concise', 'tool_output_for_prompt']) if (typeof o[k] === 'string') return o[k]
    if (typeof o.FileContent?.content === 'string') return o.FileContent.content
    for (const v of Object.values(o)) { const r = pick(v, depth + 1); if (r !== null) return r }
    return null
  }
  return pick(j, 0) ?? raw
}

export function adapt(raw: Record<string, unknown>, st: ForeignState): SDKMessage[] {
  const t = String(raw.type ?? '')
  const msg = (m: unknown) => [m as SDKMessage]

  if (t === 'system') {
    if (raw.subtype !== 'init') return []
    if (raw.session_id) st.sessionId = String(raw.session_id)
    if (raw.model && raw.model !== 'unknown') st.model = String(raw.model)
    // no session_id on the message handed on: the runner advances the conversation's Claude transcript head on one,
    // and a Grok session is not a Claude transcript
    return msg({ type: 'system', subtype: 'init', uuid: `gk-${st.tag}init`, model: st.model ?? '' })
  }

  if (t === 'stream_event') {
    const ev: any = raw.event
    if (ev?.type === 'message_start' && ev.message) return msg({ ...raw, event: { ...ev, message: { ...ev.message, id: st.tag + String(ev.message.id ?? '') } } })
    return msg(raw)
  }

  if (t === 'assistant') {
    const m: any = raw.message ?? {}
    const u = m.usage
    if (u) st.lastIn = (Number(u.input_tokens) || 0) + (Number(u.cache_read_input_tokens) || 0) + (Number(u.cache_creation_input_tokens) || 0)
    const content = (Array.isArray(m.content) ? m.content : []).map((b: any) => b?.type === 'thinking'
      ? { type: 'thinking', thinking: b.thinking }
      : b?.type === 'tool_use' ? { ...b, name: TOOL[b.name] ?? b.name, input: input(b.name, b.input ?? {}) } : b)
    return msg({ ...raw, message: { ...m, id: st.tag + String(m.id ?? ''), content } })
  }

  if (t === 'user') {
    const m: any = raw.message ?? {}
    const content = (Array.isArray(m.content) ? m.content : []).map((b: any) => b?.type === 'tool_result' ? { ...b, content: clip(resultText(b.content)) } : b)
    return msg({ ...raw, message: { ...m, content } })
  }

  if (t === 'result') {
    // cumulative per hand, like the SDK's: the runner diffs each result against the last
    st.cum ??= { cost: 0, models: {} }
    st.cum.cost += Number(raw.total_cost_usd) || 0
    let window = 0
    for (const [mid, mu] of Object.entries<any>((raw.modelUsage as Record<string, any>) ?? {})) {
      const c = (st.cum.models[mid] ??= { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 })
      for (const k of Object.keys(c)) c[k] += Number(mu?.[k]) || 0
      window = Math.max(window, Number(mu?.contextWindow) || 0)
    }
    if (st.lastIn && window) st.usage = { percentage: Math.min(100, (st.lastIn / window) * 100), totalTokens: st.lastIn, maxTokens: window }
    const ok = raw.subtype === 'success' && !raw.is_error
    const errs = Array.isArray(raw.errors) ? (raw.errors as unknown[]).map(String).join('\n') : ''
    return msg({ ...raw, total_cost_usd: st.cum.cost, modelUsage: st.cum.models, ...(ok ? {} : { result: String(raw.result ?? '') || errs || String(raw.subtype ?? 'the turn failed') }) })
  }
  return []
}

/** the fund's deny list (permissions.deny of <fund>/.claude/settings.json) as Grok's own --deny rules. Grok has no
 *  --settings flag and reads .claude/settings.json only by walking up from its folder to the repo root, which stops
 *  inside a sub-repo; passing the rules explicitly means the same list binds Grok as binds a Claude seat. */
export function denyArgs(settingsFile: string): string[] {
  let doc: any
  try { doc = JSON.parse(readFileSync(settingsFile, 'utf8')) } catch { return [] }
  const rules: string[] = Array.isArray(doc?.permissions?.deny) ? doc.permissions.deny.filter((r: unknown): r is string => typeof r === 'string' && r.trim() !== '') : []
  // Grok refuses the whole turn on a tool prefix it does not know ("unknown tool prefix: PowerShell", measured 2026-10-06),
  // and its one shell tool answers to Bash(...): a PowerShell row is carried over as the Bash row it twins
  const out = new Set(rules.map(r => r.replace(/^PowerShell\(/, 'Bash(')))
  return [...out].flatMap(r => ['--deny', r])
}

export function grokArgv(o: { model: string; effort?: string; resumeId?: string; promptFile?: string; deny: string[] }): string[] {
  return [
    '--prompt-file', o.promptFile ?? '',
    '--output-format', 'streaming-messages-json', '--include-partial-messages',
    '-m', o.model,
    ...(o.effort ? ['--reasoning-effort', o.effort] : []),
    ...(o.resumeId ? ['--resume', o.resumeId] : []),
    // headless: nobody is there to answer a prompt, so the rules decide. The fund's own deny list rides along.
    '--permission-mode', 'bypassPermissions',
    '--no-plan', '--disallowed-tools', 'ask_user_question,enter_plan_mode,exit_plan_mode',
    ...o.deny,
  ]
}

export function spawnGrok(o: { bin: string; cwd: string; env: Record<string, string | undefined>; model: string; effort?: string; resumeId?: string; preamble?: string; deny: string[]; signal: AbortSignal; prompts: AsyncIterable<SDKUserMessage> }): ForeignHand {
  return spawnForeign({
    label: 'Grok', bin: o.bin, cwd: o.cwd, model: o.model, preamble: o.preamble, signal: o.signal,
    env: { ...o.env, GROK_DISABLE_AUTOUPDATER: '1' },
    prompt: 'file',
    seed: { sessionId: o.resumeId },
    argv: a => grokArgv({ model: a.model, effort: o.effort, resumeId: a.resumeId, promptFile: a.promptFile, deny: o.deny }),
    adapt,
  }, o.prompts)
}
