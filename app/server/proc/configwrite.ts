import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Agent, Dashboard, HealthCheck } from '../../shared/types.ts'
import { summaryDeclProblems } from './summary.ts'

/**
 * The configuration writer for the new-dashboard route: the ONE place fundd creates a dashboard's
 * `dashboard.json` (platform/dashboards/<id>/) at runtime, and the rule a NEW roster row is
 * held to (agentErrors; the row itself lands as app/agents/<id>.md, server/proc/scaffold.ts). Every
 * write is validated before it lands, 2-space JSON + LF, written to a temp file and renamed over the
 * original so a crash never leaves half a file. Keys the writer does not know (`$comment`) are kept.
 *
 * The dashboard shape is the platform's (`fundplat.dashboards.registry`): dashboardFileErrors() is
 * its rule for ONE file as read, registryErrors() its rule across files; dashboardErrors() is the
 * stricter rule a NEW row is held to.
 */

export const DASHBOARD_JSON = 'dashboard.json'
export const MARKETS = ['crypto', 'tradfi', 'predmkts', 'all'] as const
const CHECKS = ['port', 'http', 'exists', 'file_age'] as const
/** every kind a dashboard.json may declare (no `service`: the live feed left the cockpit with live
 *  data v2, 2026-09-26; live data is a library inside each dashboard) */
const KINDS = ['dashboard', 'tool'] as const
/** every key a dashboard.json must carry (fundplat.dashboards.registry REQUIRED) */
export const DASHBOARD_REQUIRED = ['id', 'name', 'market', 'agent', 'kind', 'open', 'start', 'health', 'every', 'order'] as const

const isStr = (x: unknown): x is string => typeof x === 'string' && x.length > 0
const isInt = (x: unknown): x is number => typeof x === 'number' && Number.isInteger(x)
const isPort = (x: unknown): x is number => isInt(x) && x >= 1 && x <= 65535
const relOk = (p: string) => !/^([A-Za-z]:|[\\/])/.test(p) && !p.split(/[\\/]/).includes('..')

/** the ports a dashboard row occupies: start, start_dev and every port check */
export function portsOf(d: Dashboard): number[] {
  const ps = [d.start?.port, d.start_dev?.port, ...d.health.map(h => (h.check === 'port' ? h.port : undefined))]
  return [...new Set(ps.filter((p): p is number => isPort(p)))]
}

function checkErrors(h: HealthCheck, i: number): string[] {
  const e: string[] = []
  const at = `health[${i}]`
  if (!isStr(h?.id)) e.push(`${at}.id missing`)
  if (!CHECKS.includes(h?.check as any)) return [...e, `${at}.check must be one of ${CHECKS.join('|')}`]
  if (h.check === 'port' && !isPort(h.port)) e.push(`${at}.port invalid`)
  if (h.check === 'http' && !/^http:\/\/127\.0\.0\.1:\d+\//.test(h.url ?? '')) e.push(`${at}.url must be http://127.0.0.1:<port>/...`)
  if ((h.check === 'exists' || h.check === 'file_age') && !isStr(h.path)) e.push(`${at}.path missing`)
  if (h.check === 'file_age' && !(typeof h.max_h === 'number' && h.max_h > 0)) e.push(`${at}.max_h invalid`)
  return e
}

/** everything wrong with ONE dashboard.json as read (the platform registry's rule; empty = fine) */
export function dashboardFileErrors(doc: unknown, folder?: string): string[] {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return ['not a JSON object']
  const d = doc as Record<string, any>
  const missing = DASHBOARD_REQUIRED.filter(k => !(k in d)).map(k => `missing ${k}`)
  if (missing.length) return missing
  const e: string[] = []
  if (!isStr(d.id)) e.push('id is not a string')
  else if (folder !== undefined && d.id !== folder) e.push(`id ${d.id} is not its folder name ${folder}`)
  if (!isStr(d.name)) e.push('name is not a string')
  if (!isStr(d.agent)) e.push('agent is not a string')
  if (!isStr(d.open)) e.push('open is not a string')
  if (!KINDS.includes(d.kind)) e.push(`kind must be ${KINDS.join('|')}`)
  if (!MARKETS.includes(d.market)) e.push(`market must be ${MARKETS.join('|')}`)
  if (!isInt(d.order)) e.push('order is not an int')
  const st = d.start
  if (!st || typeof st !== 'object' || !isStr(st.cmd) || !isStr(st.cwd) || !('port' in st)) e.push('start needs cmd, cwd and port')
  else if (!isInt(st.port)) e.push('start.port is not an int')
  if (!Array.isArray(d.health) || d.health.length === 0) e.push('health is not a non-empty list')
  else {
    const seen = new Set<string>()
    for (const h of d.health) {
      if (!h || typeof h !== 'object' || !CHECKS.includes(h.check) || !isStr(h.id)) { e.push(`health entry ${JSON.stringify(h)} needs an id and a check in ${CHECKS.join('|')}`); continue }
      if (seen.has(h.id)) e.push(`health id ${h.id} repeated`)
      seen.add(h.id)
    }
  }
  // the live summary card's declaration (registry.py _summary_decl_problems): a dashboard's own, on its own port
  if ('summary' in d) e.push(...summaryDeclProblems(d))
  return e
}

function tally<T>(xs: T[]): Map<T, number> {
  const m = new Map<T, number>()
  for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1)
  return m
}

/** start as a canonical string: key order never makes two identical servers look different */
const startKey = (s: Dashboard['start']) => JSON.stringify(s ? Object.fromEntries(Object.entries(s).sort(([a], [b]) => a.localeCompare(b))) : null)

/** faults BETWEEN dashboards (the platform registry's rule): an order used twice, an agent owning two
 *  dashboards, one port claimed by servers that are not one identical start.shared server */
export function registryErrors(list: Dashboard[]): string[] {
  const e: string[] = []
  for (const [o, n] of tally(list.map(d => d.order))) if (n > 1 && o !== undefined) e.push(`order ${o} used twice`)
  for (const [a, n] of tally(list.filter(d => (d.kind ?? 'dashboard') === 'dashboard').map(d => d.agent))) if (n > 1) e.push(`agent ${a} owns two dashboards`)
  const byPort = new Map<number, Dashboard[]>()
  for (const d of list) if (d.start) byPort.set(d.start.port, [...(byPort.get(d.start.port) ?? []), d])
  for (const [port, group] of [...byPort].sort((a, b) => a[0] - b[0])) {
    if (group.length < 2) continue
    if (group.some(g => !g.start?.shared) || new Set(group.map(g => startKey(g.start))).size !== 1) {
      e.push(`port ${port} is claimed by ${group.map(g => g.id).join(', ')} without one identical start.shared server`)
    }
  }
  return e
}

/** everything wrong with a NEW dashboard row against the dashboards already registered */
export function dashboardErrors(d: Dashboard, existing: Dashboard[]): string[] {
  const e: string[] = []
  if (!isStr(d?.id)) return ['id missing']
  if (existing.some(x => x.id === d.id)) e.push(`dashboard ${d.id} already exists`)
  if (!isStr(d.name)) e.push('name missing')
  if (!MARKETS.includes(d.market as any)) e.push(`market must be one of ${MARKETS.join('|')}`)
  if (!isStr(d.agent)) e.push('agent missing')
  if (d.kind !== 'dashboard' && d.kind !== 'tool') e.push('kind must be dashboard|tool')
  if (!/^http:\/\/127\.0\.0\.1:\d+\//.test(d.open ?? '')) e.push('open must be http://127.0.0.1:<port>/...')
  if (!d.start) e.push('start missing')
  else {
    if (!isStr(d.start.cmd)) e.push('start.cmd missing')
    if (!isStr(d.start.cwd) || !relOk(d.start.cwd)) e.push('start.cwd must be fund-relative')
    if (!isPort(d.start.port)) e.push('start.port invalid')
  }
  if (!Array.isArray(d.health) || d.health.length === 0) e.push('health needs at least one check')
  else d.health.forEach((h, i) => e.push(...checkErrors(h, i)))
  if (Array.isArray(d.health) && new Set(d.health.map(h => h.id)).size !== d.health.length) e.push('health ids must be unique')
  if (!isStr(d.every)) e.push('every missing')
  if (d.on_fail !== undefined && d.on_fail !== 'wake_agent' && d.on_fail !== 'notify') e.push('on_fail must be wake_agent|notify')
  if (!isInt(d.order)) e.push('order must be an int')
  else if (existing.some(x => x.order === d.order)) e.push(`order ${d.order} is taken`)
  if (d.summary !== undefined) e.push(...summaryDeclProblems(d as unknown as Record<string, unknown>))
  if (Array.isArray(d.health)) {
    for (const p of portsOf(d)) {
      const owner = existing.find(x => portsOf(x).includes(p))
      if (owner && !(d.start?.shared && owner.start?.shared === d.start.shared)) e.push(`port ${p} is taken by ${owner.id}`)
    }
  }
  return e
}

/** the next free display order: one past the highest registered */
export function nextOrder(existing: Dashboard[]): number {
  return existing.reduce((m, d) => (isInt(d.order) && d.order > m ? d.order : m), 0) + 1
}

/** everything wrong with a NEW agent row */
export function agentErrors(a: Agent, existing: Agent[]): string[] {
  const e: string[] = []
  if (!isStr(a?.id)) return ['id missing']
  if (existing.some(x => x.id === a.id)) e.push(`agent ${a.id} already exists`)
  for (const k of ['name', 'dept', 'role', 'cwd', 'model', 'effort'] as const) if (!isStr(a[k])) e.push(`${k} missing`)
  if (a.kind !== 'standing' && a.kind !== 'dashboard') e.push('kind must be standing|dashboard')
  if (a.mode !== 'active' && a.mode !== 'dormant') e.push('mode must be active|dormant')
  if (isStr(a.cwd) && !relOk(a.cwd)) e.push('cwd must be fund-relative')
  if (!Array.isArray(a.writes) || a.writes.length === 0) e.push('writes needs at least one path')
  else for (const w of a.writes) {
    if (!isStr(w) || !relOk(w)) e.push(`writes: ${w} must be fund-relative`)
    else if (w === '.' || w === './' || w === '/' || w.split('/').filter(Boolean).length < 2) e.push(`writes: ${w} is too wide`)
  }
  if (!Array.isArray(a.boot)) e.push('boot must be a list')
  return e
}

/** write a JSON document whole: 2-space + LF, parsed back before it lands, temp + rename so a crash
 *  never leaves half a file. Returns what was written. */
export function writeJsonAtomic(path: string, doc: unknown): string {
  const text = JSON.stringify(doc, null, 2).replace(/\r\n/g, '\n') + '\n'
  JSON.parse(text)                                    // the file we are about to land parses
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(tmp, text)
  try { renameSync(tmp, path) } catch (e) { if (existsSync(tmp)) unlinkSync(tmp); throw e }
  return text
}

/** read-modify-write one JSON file; the mutation may throw to abort. Returns what was written. */
export function editJson<T extends Record<string, unknown>>(path: string, mutate: (cur: T) => T): string {
  const cur = JSON.parse(readFileSync(path, 'utf8')) as T
  return writeJsonAtomic(path, mutate(cur))
}

/**
 * A NEW dashboard lands as its own file, `<dashboardsDir>/<id>/dashboard.json`, validated against
 * every dashboard already registered. Refuses to overwrite. Returns the absolute path written.
 */
export function addDashboard(dashboardsDir: string, d: Dashboard, existing: Dashboard[]): string {
  const errs = dashboardErrors(d, existing)
  if (errs.length) throw new Error(`${DASHBOARD_JSON}: ${errs.join('; ')}`)
  const dir = join(dashboardsDir, d.id)
  const path = join(dir, DASHBOARD_JSON)
  if (existsSync(path)) throw new Error(`refusing to overwrite ${d.id}/${DASHBOARD_JSON}`)
  mkdirSync(dir, { recursive: true })
  writeJsonAtomic(path, d)
  return path
}

/** rollback helper: remove exactly one dashboard file by id (no-op when absent) */
export function removeDashboard(dashboardsDir: string, id: string) {
  const path = join(dashboardsDir, id, DASHBOARD_JSON)
  if (existsSync(path)) unlinkSync(path)
}
