import type { Changes } from './changes.ts'
import type { Entry } from './types.ts'

// HANDOFF TO THE NEXT SEAT: a deterministic draft of what a conversation leaves behind - no LLM
// call, so every number passes through WORD FOR WORD. goal = title + the first owner message;
// files = the conversation's commits + the agent's dirty tree; numbers = assistant lines carrying
// a provenance tag or a dated figure; questions = the last assistant turn's lines ending in '?';
// issue = the first #n / desk#n reference.

export type HandoffFile = { repo: string; path: string; state: 'committed' | 'dirty' }
export type Handoff = { goal: string; files: HandoffFile[]; numbers: string[]; questions: string[]; issue: string | null; text: string }

const MAX_NUMBERS = 20
const MAX_GOAL = 300
const TAG = /\[(?:V|1|U|API)\]/g
const DATE = /\b\d{4}-\d{2}-\d{2}\b/g

const top = (entries: Entry[]) => entries.filter(e => !e.nested)
const lines = (t: string) => t.replace(/\r\n/g, '\n').split('\n').map(l => l.trim()).filter(Boolean)
/** a code fence toggles; lines inside one are code, not prose */
function proseLines(t: string): string[] {
  const out: string[] = []
  let fence = false
  for (const l of lines(t)) {
    if (/^(```|~~~)/.test(l)) { fence = !fence; continue }
    if (!fence) out.push(l)
  }
  return out
}

/** a line that carries a provenance tag and a figure, or a YYYY-MM-DD date next to another number */
export function isNumberLine(l: string): boolean {
  const hasTag = new RegExp(TAG.source).test(l)
  const bare = l.replace(TAG, ' ')
  if (hasTag && /\d/.test(bare)) return true
  if (new RegExp(DATE.source).test(bare) && /\d/.test(bare.replace(DATE, ' '))) return true
  return false
}

/** the first `#n` or `desk#n` reference in the text, as written */
export function issueRef(text: string): string | null {
  const re = /(?<![\w&#/])((?:[a-z][\w:./-]*)?#\d+)(?![\w])/gi
  const m = re.exec(text)
  return m ? m[1] : null
}

export function buildHandoff(i: { id: string; title: string; entries: Entry[]; changes: Pick<Changes, 'commits' | 'working'> | null }): Handoff {
  const es = top(i.entries)
  const firstUser = es.find(e => e.kind === 'user' && e.content.trim())?.content.trim() ?? ''
  const goal = [i.title.trim(), firstUser].filter(Boolean).join('\n\n').slice(0, MAX_GOAL)

  const files: HandoffFile[] = []
  const seen = new Set<string>()
  const add = (f: HandoffFile) => { const k = `${f.repo}\0${f.path}`; if (!seen.has(k)) { seen.add(k); files.push(f) } }
  for (const c of i.changes?.commits ?? []) if (!c.reverted) for (const p of c.files) add({ repo: c.repo, path: p, state: 'committed' })
  const w = i.changes?.working
  if (w?.repo) for (const f of w.files) add({ repo: w.repo, path: f.path, state: 'dirty' })

  const said = es.filter(e => e.kind === 'assistant')
  const numbers: string[] = []
  for (const e of said) for (const l of proseLines(e.content)) if (isNumberLine(l) && !numbers.includes(l)) numbers.push(l)

  let lastUser = -1
  es.forEach((e, n) => { if (e.kind === 'user') lastUser = n })
  const lastTurn = es.slice(lastUser + 1).filter(e => e.kind === 'assistant')
  const questions = lastTurn.flatMap(e => proseLines(e.content)).filter(l => l.endsWith('?'))

  let issue: string | null = null
  for (const e of es) { if (e.kind !== 'user' && e.kind !== 'assistant') continue; issue = issueRef(e.content); if (issue) break }

  const nums = numbers.slice(-MAX_NUMBERS)
  const text = render({ id: i.id, goal, files, numbers: nums, questions, issue })
  return { goal, files, numbers: nums, questions, issue, text }
}

function render(h: { id: string; goal: string; files: HandoffFile[]; numbers: string[]; questions: string[]; issue: string | null }): string {
  const out = [`# Handoff\n\n## Goal\n\n${h.goal || '(none)'}`]
  if (h.issue) out.push(`## Issue\n\n${h.issue}`)
  if (h.files.length) out.push(`## Files\n\n${h.files.map(f => `- \`${f.path}\` (${f.repo}, ${f.state})`).join('\n')}`)
  if (h.numbers.length) out.push(`## Numbers\n\n${h.numbers.map(n => `- ${n}`).join('\n')}`)
  if (h.questions.length) out.push(`## Open questions\n\n${h.questions.map(q => `- ${q}`).join('\n')}`)
  out.push(`From conversation ${h.id}.`)
  return out.join('\n\n')
}

/** the draft for a stored conversation (null = no such conversation) */
export async function draftHandoff(convId: string): Promise<Handoff | null> {
  const store = await import('./store.ts')
  const c = await store.get(convId)
  if (!c) return null
  const runner = await import('./runner.ts')
  let entries: Entry[] = []
  try { entries = (await runner.entries(convId)).entries } catch { entries = [] }
  let ch: Changes | null = null
  try {
    const [{ agent }, { launchCwd }, changes] = await Promise.all([import('../config.ts'), import('./launch.ts'), import('./changes.ts')])
    const a = agent(c.agent)
    if (a) ch = await changes.changes(convId, launchCwd(a, convId))
  } catch { ch = null }
  return buildHandoff({ id: convId, title: c.title, entries, changes: ch })
}
