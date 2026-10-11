import { closeSync, openSync, readSync, statSync } from 'node:fs'
import { isCockpitMessage } from '../../shared/cockpitmsg.ts'
import { newNormState, normalize, textOf } from './normalize.ts'
import type { Entry } from './types.ts'

// Reading a transcript under ~/.claude/projects WITHOUT resuming it. A resume spawns a writer;
// reading yesterday must never risk today's live hand. The line format is Claude Code's own
// internal log, so this is best-effort and display-only: user/assistant rows are run through the
// same normalize() the live stream uses, so a reopened conversation renders like a live one.

// The transcript logs the PROTOCOL, not just the conversation: local-command wrappers, caveat
// preambles and reminders sit in user position. They are chrome, and chrome is dropped.
const CHROME = /^\s*(<local-command|<command-|Caveat: The messages below|<system-reminder|\[Request interrupted)/

function readRange(file: string, from: 'head' | 'tail', bytes: number): { text: string; clipped: boolean } {
  const size = statSync(file).size
  const take = Math.min(size, bytes)
  const fd = openSync(file, 'r')
  try {
    const buf = Buffer.alloc(take)
    readSync(fd, buf, 0, take, from === 'head' ? 0 : size - take)
    let text = buf.toString('utf8')
    const clipped = take < size
    if (clipped && from === 'tail') text = text.slice(text.indexOf('\n') + 1)
    return { text, clipped }
  } finally { closeSync(fd) }
}

const userText = (row: any): string | null => {
  const c = row?.message?.content
  if (typeof c === 'string') return c
  if (Array.isArray(c) && !c.some((b: any) => b?.type === 'tool_result')) return c.filter((b: any) => b?.type === 'text').map((b: any) => b.text).join('\n')
  return null
}

/** the transcript's tail as feed entries, plus the rewind point of every owner message */
export function transcriptEntries(file: string, max = 400): { entries: Entry[]; truncated: boolean; lastUuid: string } {
  const { text, clipped } = readRange(file, 'tail', 16_000_000)
  const st = newNormState()
  const out: Entry[] = []
  let n = 0
  let prevUuid = ''
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let row: any
    try { row = JSON.parse(line) } catch { continue }
    if (row?.isSidechain) continue
    const ts = Date.parse(row?.timestamp ?? '') || 0
    if (row?.type === 'user' && !row.isMeta) {
      const t = userText(row)
      if (t !== null) {
        if (t.trim() && !CHROME.test(t)) out.push({ id: `h:${row.uuid ?? n++}`, ts, kind: 'user', content: t.slice(0, 8000), ...(prevUuid ? { forkAt: prevUuid } : {}) })
      } else {
        for (const em of normalize({ ...row, tool_use_result: row.toolUseResult } as any, st, ts)) if (em.t === 'entry') out.push(em.e)
      }
    } else if (row?.type === 'assistant') {
      // Claude Code logs each content block of one message as its own row (same message id), so
      // text/thinking entries are keyed by the row here or two blocks would collapse into one.
      for (const em of normalize(row as any, st, ts)) if (em.t === 'entry') {
        out.push(em.e.kind === 'assistant' || em.e.kind === 'thinking' ? { ...em.e, id: `${em.e.id}:${row.uuid ?? n++}` } : em.e)
      }
    }
    if ((row?.type === 'user' || row?.type === 'assistant') && row.uuid) prevUuid = row.uuid
  }
  // replace-by-id: a tool call and its result share an id
  const byId = new Map<string, number>()
  const merged: Entry[] = []
  for (const e of out) {
    const i = byId.get(e.id)
    if (i === undefined) { byId.set(e.id, merged.length); merged.push(e) } else merged[i] = e
  }
  for (const e of merged) if (e.kind === 'tool' && e.status === 'created') e.status = 'success'
  return { entries: merged.slice(-max), truncated: clipped || merged.length > max, lastUuid: prevUuid }
}

const PARKED_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode'])
const INTERRUPTED = /\[Request interrupted/
/**
 * did this transcript end in the MIDDLE of a turn (B-0254 part 5, the boot scan for hard stops)?
 * null = it ended where a turn ends: an answer, or an interruption someone asked for. Otherwise the
 * last main-chain row is a tool call with no result, a result the model never answered, a prompt never
 * answered, or thinking with nothing after it. `waiting` = the open call was a question or a plan for
 * the owner; `auto` = the last prompt was the cockpit's own continue (never continued twice).
 */
export function transcriptCut(file: string): { waiting: boolean; auto: boolean } | null {
  const { text } = readRange(file, 'tail', 4_000_000)
  let last: any = null
  let prompt = ''
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let row: any
    try { row = JSON.parse(line) } catch { continue }
    if (row?.isSidechain || row?.isMeta || (row?.type !== 'user' && row?.type !== 'assistant')) continue
    last = row
    if (row.type === 'user') { const t = userText(row); if (t !== null && t.trim() && !CHROME.test(t)) prompt = t }
  }
  if (!last) return null
  const c = last.message?.content
  const blocks: any[] = Array.isArray(c) ? c : [{ type: 'text', text: String(c ?? '') }]
  if (blocks.some(b => (b?.type === 'text' && INTERRUPTED.test(String(b.text ?? ''))) || (b?.type === 'tool_result' && INTERRUPTED.test(JSON.stringify(b.content ?? ''))))) return null
  const auto = isCockpitMessage(prompt)
  if (last.type === 'assistant') {
    const calls = blocks.filter(b => b?.type === 'tool_use')
    if (calls.length) return { waiting: calls.some(b => PARKED_TOOLS.has(String(b.name))), auto }
    return blocks.some(b => b?.type === 'text' && String(b.text ?? '').trim()) ? null : { waiting: false, auto }
  }
  return { waiting: false, auto }
}

/** a name for a conversation: the CLI's own custom title, else the first thing the owner said */
export function deriveTitle(file: string): string | null {
  try {
    const m = [...readRange(file, 'tail', 64_000).text.matchAll(/"customTitle"\s*:\s*"((?:[^"\\]|\\.)*)"/g)]
    if (m.length) return JSON.parse(`"${m[m.length - 1][1]}"`)
  } catch { /* unreadable tail */ }
  try {
    for (const line of readRange(file, 'head', 256_000).text.split('\n')) {
      if (!line.trim()) continue
      let row: any
      try { row = JSON.parse(line) } catch { continue }
      if (row?.isMeta || row?.type !== 'user' || row?.isSidechain) continue
      const t = userText(row)
      const clean = (t ?? '').replace(/\s+/g, ' ').trim()
      if (!clean || CHROME.test(clean)) continue
      return titleOf(clean)
    }
  } catch { /* unreadable head */ }
  return null
}

export const titleOf = (s: string) => {
  const c = s.replace(/\s+/g, ' ').trim()
  return c.length > 64 ? `${c.slice(0, 63).trimEnd()}...` : c
}

/** every owner + assistant text in a transcript, for the search index (capped) */
export function transcriptTexts(file: string, capBytes = 40_000_000): { role: 'user' | 'assistant'; ts: number; text: string }[] {
  const { text } = readRange(file, 'tail', capBytes)
  const out: { role: 'user' | 'assistant'; ts: number; text: string }[] = []
  for (const line of text.split('\n')) {
    if (!line.includes('"text"') && !line.includes('"content":"')) continue
    let row: any
    try { row = JSON.parse(line) } catch { continue }
    if (row?.isMeta || row?.isSidechain) continue
    const ts = Date.parse(row?.timestamp ?? '') || 0
    if (row?.type === 'user') {
      const t = userText(row)
      if (t && t.trim() && !CHROME.test(t)) out.push({ role: 'user', ts, text: t.slice(0, 20_000) })
    } else if (row?.type === 'assistant') {
      const t = textOf(row?.message?.content)
      if (t.trim()) out.push({ role: 'assistant', ts, text: t.slice(0, 20_000) })
    }
  }
  return out
}
