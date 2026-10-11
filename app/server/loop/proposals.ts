import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * A PROPOSAL is one markdown file, app/loop/records/proposals/L-NNN.md:
 *
 *   ---
 *   id: L-001
 *   kind: promote | boot-compress | unread
 *   title: one line
 *   target: ["library/platform/x.md", ".../_series.md"]
 *   source: ["inbox:3", "git:ab12..:library/..."]
 *   why: one line
 *   gates: [{"name":"rails","ok":true,"note":""}]
 *   state: proposed | applied | watching | kept | reverted | vetoed
 *   auto: true              (the loop may apply it by itself)
 *   commit: <sha of the apply commit> | null
 *   revert: <sha of the revert commit> | null
 *   watch: {"agents":[...],"from":ms,"until":ms,"events":200,"before":{...},"after":{...},"verdict":null}
 *   pinned: false
 *   review: {"agent":"fund","conversation":"<id>","at":ISO,"ask":"apply","tries":1,"verdict":null,"note":"","commit":null} | null
 *           (the agent the loop SENT it to: the one whose writes cover its targets checks it and lands it
 *            or declines it, and reports back through POST /api/loop/proposals/:id/review)
 *   created: ISO   updated: ISO
 *   ---
 *   ## Why ...
 *   ## Change   (for promote: the book text in a ~~~markdown fence and the series row in a ~~~text fence)
 *   ## Log      (one line per transition, newest last)
 *
 * Scalars are written bare; anything else as one line of JSON, so the file stays greppable and
 * the parser stays tiny. The FILE is the state: the database never holds a proposal.
 */

export const STATES = ['proposed', 'applied', 'watching', 'kept', 'reverted', 'vetoed'] as const
export type State = typeof STATES[number]
export type Kind = 'promote' | 'boot-compress' | 'unread'
export type Gate = { name: string; ok: boolean; note: string }
export type Window = { counts: Record<string, number>; score: number | null; days: number }
export type Watch = {
  agents: string[]
  from: number | null        // apply time (ms)
  until: number | null       // from + watchDays
  events: number             // close early after this many cohort turns
  before: Window | null
  after: Window | null
  verdict: 'better' | 'same' | 'worse' | 'no-signal' | null
  extended?: number          // times a due watch was extended because it read no-signal (absent = 0)
}

/** the agent a pass sent the proposal to (dispatch.ts): it checks the change and lands or declines it */
export type Review = {
  agent: string
  conversation: string | null
  at: string                                  // when it was sent (ISO)
  ask: 'apply' | 'revert'                     // land the change, or take a landed one back out
  tries: number                               // sends so far (a send nobody answered is re-sent once)
  verdict: 'applied' | 'declined' | 'reverted' | null   // null = sent, not reported yet
  note: string
  commit: string | null                       // the agent's own commit, once reported
}

export type Proposal = {
  id: string
  kind: Kind
  title: string
  target: string[]
  source: string[]
  why: string
  gates: Gate[]
  state: State
  auto: boolean
  commit: string | null
  revert: string | null
  watch: Watch
  pinned: boolean
  review: Review | null
  created: string
  updated: string
  body: string
}

const ORDER: (keyof Proposal)[] = ['id', 'kind', 'title', 'target', 'source', 'why', 'gates', 'state', 'auto', 'commit', 'revert', 'watch', 'pinned', 'review', 'created', 'updated']

export const emptyWatch = (agents: string[] = [], events = 0): Watch => ({ agents, from: null, until: null, events, before: null, after: null, verdict: null })

function scalar(v: unknown): string {
  if (v === null || v === undefined) return 'null'
  if (typeof v === 'string') return /^[\w@./:# -]*$/.test(v) && v.trim() === v && !/^(null|true|false|-?\d)/.test(v) && !v.includes(': ') ? v : JSON.stringify(v)
  return JSON.stringify(v)
}

export function serialize(p: Proposal): string {
  const lines = ['---', ...ORDER.map(k => `${k}: ${scalar(p[k])}`), '---', '']
  return lines.join('\n') + p.body.replace(/\r\n/g, '\n').replace(/\s+$/, '') + '\n'
}

function value(raw: string): unknown {
  const s = raw.trim()
  if (s === '') return ''
  if (/^[[{"]/.test(s) || s === 'null' || s === 'true' || s === 'false' || /^-?\d+(\.\d+)?$/.test(s)) {
    try { return JSON.parse(s) } catch { return s }
  }
  return s
}

const VERDICTS = ['applied', 'declined', 'reverted'] as const

function reviewOf(v: unknown): Review | null {
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  if (typeof o.agent !== 'string' || !o.agent) return null
  const str = (x: unknown) => (typeof x === 'string' && x ? x : null)
  return {
    agent: o.agent,
    conversation: str(o.conversation),
    at: String(o.at ?? ''),
    ask: o.ask === 'revert' ? 'revert' : 'apply',
    tries: typeof o.tries === 'number' && o.tries > 0 ? Math.floor(o.tries) : 1,
    verdict: (VERDICTS as readonly string[]).includes(String(o.verdict)) ? o.verdict as Review['verdict'] : null,
    note: String(o.note ?? ''),
    commit: str(o.commit),
  }
}

export function parse(raw: string): Proposal {
  const text = raw.replace(/\r\n/g, '\n')
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(text)
  if (!m) throw new Error('no frontmatter')
  const fm: Record<string, unknown> = {}
  for (const line of m[1].split('\n')) {
    const i = line.indexOf(':')
    if (i <= 0) continue
    fm[line.slice(0, i).trim()] = value(line.slice(i + 1))
  }
  const arr = (v: unknown) => (Array.isArray(v) ? v.map(String) : typeof v === 'string' && v ? [v] : [])
  const w = (fm.watch && typeof fm.watch === 'object' ? fm.watch : {}) as Partial<Watch>
  const state = STATES.includes(fm.state as State) ? fm.state as State : 'proposed'
  if (typeof fm.id !== 'string' || !/^L-\d{3,}$/.test(fm.id)) throw new Error('id is not L-NNN')
  return {
    id: fm.id,
    kind: (['promote', 'boot-compress', 'unread'].includes(String(fm.kind)) ? fm.kind : 'unread') as Kind,
    title: String(fm.title ?? ''),
    target: arr(fm.target),
    source: arr(fm.source),
    why: String(fm.why ?? ''),
    gates: Array.isArray(fm.gates) ? (fm.gates as Gate[]).map(g => ({ name: String(g.name), ok: !!g.ok, note: String(g.note ?? '') })) : [],
    state,
    auto: fm.auto === true,
    commit: typeof fm.commit === 'string' && fm.commit ? fm.commit : null,
    revert: typeof fm.revert === 'string' && fm.revert ? fm.revert : null,
    watch: { ...emptyWatch(), ...w, agents: arr(w.agents) },
    pinned: fm.pinned === true,
    review: reviewOf(fm.review),
    created: String(fm.created ?? ''),
    updated: String(fm.updated ?? ''),
    body: text.slice(m[0].length).replace(/^\n+/, ''),
  }
}

/** the self-improvement loop's own folder, fund-relative: its proposals, metrics and watch records */
export const LOOP_REL = 'app/loop/records'

export const dirOf = (fundRoot: string) => join(fundRoot, ...LOOP_REL.split('/'), 'proposals')
export const fileOf = (fundRoot: string, id: string) => join(dirOf(fundRoot), `${id}.md`)
export const relOf = (id: string) => `${LOOP_REL}/proposals/${id}.md`

export function list(fundRoot: string): { proposals: Proposal[]; bad: { file: string; error: string }[] } {
  const dir = dirOf(fundRoot)
  const out: Proposal[] = []
  const bad: { file: string; error: string }[] = []
  let files: string[] = []
  try { files = readdirSync(dir).filter(f => /^L-\d+\.md$/.test(f)).sort() } catch { return { proposals: [], bad: [] } }
  for (const f of files) {
    try { out.push(parse(readFileSync(join(dir, f), 'utf8'))) } catch (e) { bad.push({ file: f, error: (e as Error).message }) }
  }
  return { proposals: out, bad }
}

export function read(fundRoot: string, id: string): Proposal | null {
  if (!/^L-\d{3,}$/.test(id)) return null
  const f = fileOf(fundRoot, id)
  if (!existsSync(f)) return null
  return parse(readFileSync(f, 'utf8'))
}

export function write(fundRoot: string, p: Proposal) {
  mkdirSync(dirOf(fundRoot), { recursive: true })
  writeFileSync(fileOf(fundRoot, p.id), serialize(p))
}

export function nextId(fundRoot: string, taken: string[] = []): string {
  let n = 0
  try { for (const f of readdirSync(dirOf(fundRoot))) { const m = /^L-(\d+)\.md$/.exec(f); if (m) n = Math.max(n, Number(m[1])) } } catch { /* first */ }
  for (const t of taken) { const m = /^L-(\d+)$/.exec(t); if (m) n = Math.max(n, Number(m[1])) }
  return `L-${String(n + 1).padStart(3, '0')}`
}

/** append one line to the proposal's ## Log section (created if missing) */
export function logLine(p: Proposal, line: string, iso: string): Proposal {
  const entry = `- ${iso} ${line.replace(/\s+/g, ' ').trim()}`
  const body = /^## Log\s*$/m.test(p.body) ? `${p.body.replace(/\s+$/, '')}\n${entry}\n` : `${p.body.replace(/\s+$/, '')}\n\n## Log\n\n${entry}\n`
  return { ...p, body, updated: iso }
}

/** the fenced blocks of a promote proposal's ## Change section: the book text and the series row */
export function changeOf(p: Proposal): { book: string | null; row: string | null } {
  // everything after the ## Change heading: the book text inside the fence carries ## headings of
  // its own, so the section is not cut at the next heading; the fences themselves delimit it
  const at = /^## Change\s*$/m.exec(p.body)
  const sec = at ? p.body.slice(at.index + at[0].length) : p.body
  const fence = (lang: string) => new RegExp('^~~~' + lang + '\\n([\\s\\S]*?)\\n~~~[ \\t]*$', 'm').exec(sec)?.[1] ?? null
  return { book: fence('markdown'), row: fence('text') }
}
