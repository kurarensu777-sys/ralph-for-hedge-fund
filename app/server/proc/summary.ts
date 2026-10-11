import type { DashSummaryDecl, SummaryBody } from '../../shared/types.ts'

/**
 * THE LIVE SUMMARY CARD, the cockpit's half. A dashboard may declare `summary: {url, every}` in its
 * dashboard.json; while its port is up the Dash room reads that url every `every` and shows the three
 * headline tiles it answers. The contract is the PLATFORM's (`platform/dashboards/registry.py`:
 * `summary_problems` for the body, `_summary_decl_problems` for the declaration); this file MIRRORS it
 * rule for rule, because the app never imports platform code. test/dash-summary.test.ts holds the two
 * together: one fixture of bodies and declarations, judged here and by registry.py itself, must get
 * the same verdict on every row (the 24 / 25 character label included).
 *
 * Pure except readSummary(), which does one loopback GET. Never throws: a body that breaks the
 * contract, an unreachable server or a non-JSON answer is a reading of `unknown` with the reason.
 */

export const SUMMARY_KEYS = ['url', 'every'] as const
export const HEALTH = ['ok', 'warn', 'fail'] as const
export const HEADLINE_N = 3
export const LABEL_MAX = 24
export const TAGS = ['[V]', '[1]', '[U]', '[API]'] as const
export const BODY_KEYS = ['as_of_ms', 'health', 'headline'] as const
export const ENTRY_KEYS = ['label', 'value', 'tag', 'hint'] as const
/** 2001-09-09 in ms: an as-of below it was sent in seconds */
export const MS_FLOOR = 10 ** 12
/** registry.py EVERY: digits + s|m|h */
export const EVERY = /^\d+[smh]$/

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x)
const isInt = (x: unknown): x is number => typeof x === 'number' && Number.isInteger(x)
const show = (x: unknown) => { try { return JSON.stringify(x) ?? String(x) } catch { return String(x) } }
/** Python's len() counts code points; a JS string's length counts UTF-16 units */
const chars = (s: string) => [...s].length

/** Every fault in one /api/summary body (empty = valid). Shape only: registry.summary_problems. */
export function summaryProblems(body: unknown): string[] {
  if (!isObj(body)) return ['summary body is not a JSON object']
  const out: string[] = BODY_KEYS.filter(k => !(k in body)).map(k => `missing ${k}`)
  out.push(...Object.keys(body).filter(k => !(BODY_KEYS as readonly string[]).includes(k)).map(k => `unknown key ${show(k)}`))
  if ('as_of_ms' in body) {
    const t = body.as_of_ms
    if (!isInt(t) || t <= 0) out.push(`as_of_ms ${show(t)} is not a positive int`)
    else if (t < MS_FLOOR) out.push(`as_of_ms ${t} reads as seconds, not milliseconds`)
  }
  if ('health' in body && !(HEALTH as readonly unknown[]).includes(body.health)) out.push(`health ${show(body.health)} not in ${HEALTH.join('|')}`)
  if ('headline' in body) {
    const hl = body.headline
    if (!Array.isArray(hl)) return [...out, 'headline is not a list']
    if (hl.length !== HEADLINE_N) out.push(`headline has ${hl.length} entries, not exactly ${HEADLINE_N}`)
    hl.forEach((e, i) => {
      const w = `headline[${i}]: `
      if (!isObj(e)) { out.push(w + 'not an object'); return }
      out.push(...Object.keys(e).filter(k => !(ENTRY_KEYS as readonly string[]).includes(k)).map(k => w + `unknown key ${show(k)}`))
      const lab = e.label
      if (typeof lab !== 'string' || !lab.trim()) out.push(w + 'label is not a non-empty string')
      else if (chars(lab) > LABEL_MAX) out.push(w + `label ${show(lab)} is ${chars(lab)} chars, over ${LABEL_MAX}`)
      if (!('value' in e)) out.push(w + 'missing value')
      // JSON carries no NaN; a value that is not a finite number arrives as null or a string
      else if (typeof e.value === 'number' ? !Number.isFinite(e.value) : typeof e.value !== 'string') {
        out.push(w + (typeof e.value === 'number' ? 'value is NaN (serve "n/a" with a hint instead)' : `value ${show(e.value)} is not a string or a number`))
      }
      if ('tag' in e && !(TAGS as readonly unknown[]).includes(e.tag)) out.push(w + `tag ${show(e.tag)} not in ${TAGS.join(' ')}`)
      if ('hint' in e && typeof e.hint !== 'string') out.push(w + 'hint is not a string')
    })
  }
  return out
}

/** the port of an http://127.0.0.1:<port>/... url; null for anything else (another host or scheme, no
 *  explicit port, credentials in it, a host that only STARTS like loopback): registry._loopback_port */
export function loopbackPort(url: unknown): number | null {
  if (typeof url !== 'string') return null
  const m = /^http:\/\/127\.0\.0\.1:(\d{1,5})\//.exec(url)
  if (!m) return null
  let u: URL
  try { u = new URL(url) } catch { return null }
  const port = Number(m[1])
  // the port spelled canonically (registry.py re-spells it: ":08793" is refused), inside 0..65535
  if (m[1] !== String(port) || port > 65535) return null
  if (u.protocol !== 'http:' || u.hostname !== '127.0.0.1' || u.username || u.password) return null
  return port
}

/** Faults in a dashboard.json `summary` declaration: a dashboard's own, on its own start.port
 *  (registry._summary_decl_problems). `doc` is the whole file as read. */
export function summaryDeclProblems(doc: Record<string, any>): string[] {
  const sm = doc.summary
  if (doc.kind !== 'dashboard') return ['summary belongs to a dashboard, not a tool']
  if (!isObj(sm)) return ['summary is not an object {url, every}']
  const out = SUMMARY_KEYS.filter(k => !(k in sm)).map(k => `summary missing ${k}`)
  out.push(...Object.keys(sm).filter(k => !(SUMMARY_KEYS as readonly string[]).includes(k)).map(k => `summary has unknown key ${show(k)}`))
  if ('url' in sm) {
    const u = loopbackPort(sm.url)
    const port = doc.start?.port
    if (u === null) out.push(`summary.url ${show(sm.url)} is not http://127.0.0.1:<port>/...`)
    else if (isInt(port) && u !== port) out.push(`summary.url ${show(sm.url)} is on port ${u}, not its own start.port ${port}`)
  }
  if ('every' in sm && (typeof sm.every !== 'string' || !EVERY.test(sm.every))) out.push(`summary.every ${show(sm.every)} is not like 30s / 1m / 5m`)
  return out
}

/** "30s" / "1m" / "1h" -> ms (a declaration that passed summaryDeclProblems); 60 s for anything else */
export function summaryEveryMs(every: string | undefined): number {
  const m = /^(\d+)([smh])$/.exec(every ?? '')
  if (!m) return 60_000
  return Math.max(1, Number(m[1])) * { s: 1000, m: 60_000, h: 3_600_000 }[m[2] as 's' | 'm' | 'h']
}

/** one poll's outcome: a valid body, or unknown with the reason */
export type SummaryReading = { status: 'ok'; body: SummaryBody; ts: number } | { status: 'unknown'; reason: string; ts: number }

/** A reading from an answer already in hand (the HTTP status and its text): the rule, testable without a server. */
export function judgeSummary(httpStatus: number, text: string, ts = Date.now()): SummaryReading {
  if (httpStatus < 200 || httpStatus >= 300) return { status: 'unknown', reason: `HTTP ${httpStatus}`, ts }
  let body: unknown
  try { body = JSON.parse(text) } catch { return { status: 'unknown', reason: 'not JSON', ts } }
  const bad = summaryProblems(body)
  if (bad.length) return { status: 'unknown', reason: `malformed: ${bad.join('; ')}`, ts }
  return { status: 'ok', body: body as SummaryBody, ts }
}

/** GET the declared url once (loopback only, no redirects, a timeout) and judge it. Never throws. */
export async function readSummary(decl: DashSummaryDecl, o: { timeoutMs?: number; now?: () => number } = {}): Promise<SummaryReading> {
  const now = o.now ?? Date.now
  if (loopbackPort(decl.url) === null) return { status: 'unknown', reason: `url ${decl.url} is not http://127.0.0.1:<port>/...`, ts: now() }
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), o.timeoutMs ?? 4000)
  try {
    const res = await fetch(decl.url, { signal: ctl.signal, redirect: 'manual', headers: { accept: 'application/json' } })
    const text = await res.text()
    return judgeSummary(res.status, text, now())
  } catch (e: any) {
    const reason = e?.name === 'AbortError' ? 'timeout' : String(e?.cause?.code ?? e?.message ?? e)
    return { status: 'unknown', reason: `unreachable: ${reason}`, ts: now() }
  } finally { clearTimeout(timer) }
}
