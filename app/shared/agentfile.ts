// THE ROSTER FILE FORMAT: one markdown file per agent, app/agents/<id>.md (':' -> '-', so dash:vol is
// dash-vol.md). A YAML header carries the row the cockpit and the guard read; the body under it is
// the agent's brief (who it is, what it owns, how it works, what it never does):
//
//   ---
//   id: dash:vol
//   name: Vol
//   kind: dashboard
//   mode: active
//   dept: Dashboards
//   dashboard: vol
//   role: "The VOL screen: term structure, smile, implied vs realised"
//   cwd: platform/dashboards/vol
//   model: claude-sonnet-5-5
//   effort: medium
//   order: 9
//   writes:
//     - platform/dashboards/vol/
//   boot:
//     - app/library/law/how-we-know.md#a-shared-window-is-one-result
//   ---
//
//   # vol - the brief
//   ...
//
// The header is a deliberately SMALL subset of YAML, so that it reads identically here, in the
// commit guard (scripts/hooks/guard.mjs, plain node), in the python tools (app/tools/_root.py, stdlib
// only, the same grammar) and in any real YAML parser: `key: scalar`, `key:` followed by `  - item`
// lines, `key: []` and a one-line flow list `key: [a, b]`. A scalar is plain, "JSON-quoted" or
// 'single-quoted'; true/false/null and plain numbers are typed. Nothing else (no nesting, no
// anchors, no multi-line strings). serializeAgentFile() writes only that subset and quotes any
// scalar a YAML reader could take for something else. test/roster.test.ts round-trips it and
// test/layout-parity.test.ts holds the python reader to the same answer.
//
// Pure, dependency-free and only erasable TypeScript: fundd, scripts/board.mjs and the guard
// (node >= 23.6 strips the types) all import THIS file.

export type HeaderValue = string | number | boolean | null | string[]
export type Header = Record<string, HeaderValue>

/** the order a header's keys are written in; any other key follows, alphabetically */
export const HEADER_ORDER = ['id', 'name', 'kind', 'mode', 'dept', 'dashboard', 'role', 'cwd', 'model', 'effort', 'order', 'budgetTokensPerDay', 'writes', 'boot', 'reads'] as const

/** the file an agent id lives in: dash:vol -> dash-vol.md */
export const agentFileName = (id: string) => `${id.replace(/:/g, '-')}.md`

/** a file name that is an agent (not a README, a _index or a hidden file) */
export const isAgentFileName = (name: string) => /^[A-Za-z0-9][A-Za-z0-9._-]*\.md$/.test(name) && !/^readme\.md$/i.test(name)

export class AgentFileError extends Error {}

function unquote(raw: string): HeaderValue {
  const s = raw.trim()
  if (s === '') return ''
  if (s.startsWith('"')) {
    if (!s.endsWith('"') || s.length < 2) throw new AgentFileError(`unterminated string ${s}`)
    try { return JSON.parse(s) as string } catch { throw new AgentFileError(`bad string ${s}`) }
  }
  if (s.startsWith("'")) {
    if (!s.endsWith("'") || s.length < 2) throw new AgentFileError(`unterminated string ${s}`)
    return s.slice(1, -1).replace(/''/g, "'")
  }
  if (s === 'true') return true
  if (s === 'false') return false
  if (s === 'null' || s === '~') return null
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s)
  return s
}

const str = (v: HeaderValue): string => (v === null ? '' : String(v))

/** split `a, "b, c", 'd'` on the commas outside quotes */
function flowItems(inner: string): string[] {
  const out: string[] = []
  let cur = '', q: string | null = null
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i]
    if (q) {
      cur += c
      if (c === '\\' && q === '"' && i + 1 < inner.length) { cur += inner[++i]; continue }
      if (c === q) q = null
    } else if (c === '"' || c === "'") { q = c; cur += c }
    else if (c === ',') { out.push(cur); cur = '' }
    else cur += c
  }
  if (q) throw new AgentFileError(`unterminated string in [${inner}]`)
  if (cur.trim() !== '' || out.length) out.push(cur)
  return out.map(x => x.trim()).filter(x => x !== '')
}

/** a trailing ` # comment` on a plain (unquoted) value is YAML's; a quoted value keeps its '#' */
const stripComment = (v: string) => (/^["']/.test(v.trim()) ? v : v.replace(/\s+#.*$/, ''))

/** parse the header text (between the --- lines) */
export function parseHeader(text: string): Header {
  const out: Header = {}
  let list: string[] | null = null
  for (const [i, raw] of text.replace(/\r\n/g, '\n').split('\n').entries()) {
    const line = raw.replace(/\s+$/, '')
    if (!line.trim() || /^\s*#/.test(line)) continue
    const item = /^\s+-\s*(.*)$/.exec(line) ?? /^-\s+(.*)$/.exec(line)
    if (item) {
      if (!list) throw new AgentFileError(`line ${i + 1}: a list item outside a list`)
      list.push(str(unquote(stripComment(item[1]))))
      continue
    }
    const kv = /^([A-Za-z_][A-Za-z0-9_-]*):(?:\s+(.*))?$/.exec(line)
    if (!kv) throw new AgentFileError(`line ${i + 1}: not "key: value": ${line.trim()}`)
    const [, key, rest = ''] = kv
    if (key in out) throw new AgentFileError(`line ${i + 1}: ${key} given twice`)
    const v = stripComment(rest).trim()
    if (v === '') { list = []; out[key] = list; continue }
    list = null
    if (v.startsWith('[')) {
      if (!v.endsWith(']')) throw new AgentFileError(`line ${i + 1}: unterminated list`)
      out[key] = flowItems(v.slice(1, -1)).map(x => str(unquote(x)))
    } else out[key] = unquote(v)
  }
  return out
}

/** a scalar YAML would read back as this same string, unquoted */
const PLAIN = /^[A-Za-z0-9_./@+(][A-Za-z0-9_./@+()=<>,:#' -]*$/
function scalar(v: string | number | boolean | null): string {
  if (v === null) return 'null'
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  const plain = PLAIN.test(v) && !/[\s]$/.test(v) && !/^(true|false|null|yes|no|on|off|~|-?\d[\d.]*)$/i.test(v) && !v.includes(': ') && !v.endsWith(':') && !v.includes(' #')
  return plain ? v : JSON.stringify(v)
}

/** the header's text (no --- lines), keys in HEADER_ORDER then alphabetical; undefined keys dropped */
export function serializeHeader(h: Record<string, unknown>): string {
  const keys = Object.keys(h).filter(k => h[k] !== undefined)
  const rank = (k: string) => { const i = (HEADER_ORDER as readonly string[]).indexOf(k); return i < 0 ? HEADER_ORDER.length : i }
  keys.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
  const lines: string[] = []
  for (const k of keys) {
    const v = h[k]
    if (Array.isArray(v)) {
      if (!v.length) { lines.push(`${k}: []`); continue }
      lines.push(`${k}:`)
      for (const x of v) lines.push(`  - ${scalar(String(x))}`)
    } else if (v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') lines.push(`${k}: ${scalar(v)}`)
    else throw new AgentFileError(`${k}: only scalars and lists of strings are written`)
  }
  return lines.join('\n')
}

/** split an agent file into its header (parsed) and its body (the brief); throws on a bad header */
export function parseAgentFile(raw: string): { header: Header; body: string } {
  const text = raw.replace(/^﻿/, '').replace(/\r\n/g, '\n')
  if (!text.startsWith('---\n')) throw new AgentFileError('no header: the file must open with a --- line')
  const end = text.indexOf('\n---', 3)
  if (end < 0) throw new AgentFileError('the header has no closing --- line')
  const closing = text.slice(end + 1).split('\n', 1)[0]
  if (closing.trim() !== '---') throw new AgentFileError('the header has no closing --- line')
  const header = parseHeader(text.slice(4, end))
  const body = text.slice(end + 1 + closing.length).replace(/^\n+/, '')
  return { header, body }
}

/** the whole file: header between --- lines, a blank line, the body, one trailing newline */
export function serializeAgentFile(header: Record<string, unknown>, body: string): string {
  const b = body.replace(/\r\n/g, '\n').replace(/^\n+/, '').replace(/\n*$/, '\n')
  return `---\n${serializeHeader(header)}\n---\n\n${b === '\n' ? '' : b}`
}

/** the fields every agent must carry, and their types */
const STRINGS = ['id', 'name', 'kind', 'mode', 'dept', 'role', 'cwd', 'model', 'effort'] as const
const LISTS = ['writes', 'boot'] as const

/** what is wrong with one header, [] when nothing (file = the file name it was read from) */
export function headerErrors(h: Header, file?: string): string[] {
  const errs: string[] = []
  for (const k of STRINGS) if (typeof h[k] !== 'string' || !(h[k] as string).trim()) errs.push(`${k} is missing`)
  for (const k of LISTS) if (!Array.isArray(h[k])) errs.push(`${k} must be a list`)
  if (h.reads !== undefined && !Array.isArray(h.reads)) errs.push('reads must be a list')
  if (typeof h.kind === 'string' && !['standing', 'dashboard'].includes(h.kind)) errs.push(`kind ${h.kind} is not standing or dashboard`)
  if (typeof h.mode === 'string' && !['active', 'dormant'].includes(h.mode)) errs.push(`mode ${h.mode} is not active or dormant`)
  if (h.kind === 'dashboard' && typeof h.dashboard !== 'string') errs.push('a dashboard agent names its dashboard')
  if (h.order !== undefined && typeof h.order !== 'number') errs.push('order must be a number')
  if (file && typeof h.id === 'string' && agentFileName(h.id) !== file) errs.push(`id ${h.id} belongs in ${agentFileName(h.id)}, not ${file}`)
  return errs
}

/** the brief an agent file carries: its body under the header; a file with no header (a brief kept
 *  in a file of its own, `brief:` in the header) is all brief. A header that does not parse is shown
 *  whole, so a broken file is seen rather than silently emptied. */
export function briefBody(raw: string): string {
  if (!raw.replace(/^\uFEFF/, '').startsWith('---')) return raw
  try { return parseAgentFile(raw).body } catch { return raw }
}
