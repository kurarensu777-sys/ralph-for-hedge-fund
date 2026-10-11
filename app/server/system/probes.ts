import { execFile } from 'node:child_process'
import { db, ops, type Queryable } from '../db.ts'

/**
 * A PROBE READING is a row of the ops store, `ops.health_readings` (probe_id `system:<id>`, target
 * `system`), written by whoever took it: a probe (app/tools/probes/_probe.py record_health), the
 * budget meter, or the scheduler for a job with `health` true (server/sched). Its detail_json is the
 * whole reading {id, label, owner, status: ok|fail|unknown, reading, probed_ts (epoch SECONDS),
 * window_s, detail, ...extra}. Until 2026-09-26 these were files under <floor>/health; the cockpit
 * now reads only the store, the one place every writer and the heat strip share.
 *
 * A probe that has not reported inside its own window is STALE, and a stale row shows AMBER whatever
 * it claims: silence is not a green light, and an old red verdict is not a current failure (a
 * 37h-old "3 FAIL" beside fresh green rows for the same checks is a stale reading, not the fund's
 * health).
 */
export type Probe = {
  id: string
  label: string
  owner: string
  claimed: string            // the status the reading claims
  status: 'ok' | 'warn' | 'fail' | 'unknown'   // what we show: stale overrides the claim (amber)
  stale: boolean
  reading: string
  detail: string
  probedAt: number | null    // ms
  windowS: number | null
  ageS: number | null
  file: string              // where the reading lives: `ops.health_readings system:<id>`
  error?: string
}

export function probeRow(file: string, raw: string, now: number): Probe {
  let j: any
  try { j = JSON.parse(raw) } catch (e) {
    return { id: file.replace(/\.json$/, ''), label: '', owner: '', claimed: 'unknown', status: 'unknown', stale: false, reading: 'not JSON', detail: '', probedAt: null, windowS: null, ageS: null, file, error: String((e as Error).message) }
  }
  const probedAt = Number.isFinite(Number(j.probed_ts)) && j.probed_ts ? Number(j.probed_ts) * 1000 : null
  const windowS = Number.isFinite(Number(j.window_s)) && j.window_s ? Number(j.window_s) : null
  const ageS = probedAt === null ? null : Math.max(0, Math.round((now - probedAt) / 1000))
  const stale = ageS !== null && windowS !== null && ageS > windowS
  const claimed = String(j.status ?? 'unknown')
  const base: Probe['status'] = claimed === 'ok' ? 'ok' : claimed === 'fail' ? 'fail' : claimed === 'warn' ? 'warn' : 'unknown'
  const status: Probe['status'] = probedAt === null ? 'unknown' : stale && base !== 'unknown' ? 'warn' : base
  return {
    id: String(j.id ?? file.replace(/\.json$/, '')),
    label: String(j.label ?? ''),
    owner: String(j.owner ?? ''),
    claimed, status, stale,
    reading: String(j.reading ?? ''),
    detail: typeof j.detail === 'string' ? j.detail : j.detail === undefined ? '' : JSON.stringify(j.detail, null, 2),
    probedAt, windowS, ageS, file,
  }
}

export const PROBE_TARGET = 'system'
/** the ops-store probe_id of a probe reading (the heat strip reads the same key) */
export const probeKey = (id: string) => `system:${id}`

type Stored = { probe_id: string; ts: number; status: string; reading: string | null; detail_json: unknown }

/** a stored reading -> the reading object its writer recorded, the row's own columns filling what
 *  an older row (heat-only: detail {window_s}) does not carry. Pure */
export function readingOf(r: Stored): Record<string, any> {
  let d: any = r.detail_json
  if (typeof d === 'string') { try { d = JSON.parse(d) } catch { d = null } }
  const o = d && typeof d === 'object' && !Array.isArray(d) ? d : {}
  return {
    ...o,
    id: o.id ?? r.probe_id.replace(/^system:/, ''),
    status: o.status ?? r.status,
    reading: o.reading ?? r.reading ?? '',
    probed_ts: o.probed_ts ?? Math.floor(Number(r.ts) / 1000),
  }
}

/** one stored reading as a Probe row. Pure */
export function probeFromReading(r: Stored, now: number): Probe {
  return probeRow(`ops.health_readings ${r.probe_id}`, JSON.stringify(readingOf(r)), now)
}

/** every probe's newest reading, by id */
export async function loadProbes(now: number, q: Queryable = db): Promise<Probe[]> {
  const rows = await ops.latestHealth({ target: PROBE_TARGET }, q)
  return rows.filter(r => r.probe_id.startsWith('system:')).map(r => probeFromReading(r, now)).sort((a, b) => a.id.localeCompare(b.id))
}

/** one probe's newest reading object (the budget meter, the git probe, retro-due), or null */
export async function latestReading(id: string, q: Queryable = db): Promise<Record<string, any> | null> {
  const [r] = await ops.healthHistory(probeKey(id), { limit: 1 }, q)
  return r ? readingOf(r) : null
}

/** worst first: fail > warn > unknown > ok */
export function worst(ps: { status: string }[]): 'ok' | 'warn' | 'fail' | 'unknown' {
  if (ps.some(p => p.status === 'fail')) return 'fail'
  if (ps.some(p => p.status === 'warn')) return 'warn'
  if (ps.some(p => p.status === 'unknown')) return 'unknown'
  return ps.length ? 'ok' : 'unknown'
}

// ---- the expected set: which readings the Health view judges, and which are ORPHANS ----

/** staleness.py's expected set (`--expected`): the registry probes and the sweep, and the readings a
 *  known writer records. ONE definition, in that file; this only asks it */
export type Expected = { registry: string[]; recorded: string[]; why: string | null }

/** readings split by the expected set: an orphan is a stored reading nothing is known to write (an
 *  old or moved id). It is folded into one line and never counts toward a tile, a group or a dot.
 *  With no set (the tool could not answer) nothing is folded: every reading stays judged. Pure */
export function splitOrphans<T extends { id: string }>(ps: T[], ex: Pick<Expected, 'registry' | 'recorded'> | null): { probes: T[]; orphans: T[] } {
  if (!ex) return { probes: ps, orphans: [] }
  const known = new Set([...ex.registry, ...ex.recorded])
  return { probes: ps.filter(p => known.has(p.id)), orphans: ps.filter(p => !known.has(p.id)) }
}

export const EXPECTED_TTL_MS = 60_000
let expected: { at: number; p: Promise<{ set: Expected | null; why: string | null }> } | null = null

/** ask `app/tools/probes/staleness.py --expected` (a python file of this repo, run as a child),
 *  cached a minute; a failure is said (why), never a guess */
export function expectedSet(script: string, python: string, cwd: string): Promise<{ set: Expected | null; why: string | null }> {
  if (expected && Date.now() - expected.at < EXPECTED_TTL_MS) return expected.p
  const p = new Promise<{ set: Expected | null; why: string | null }>(resolve => {
    execFile(python, [script, '--expected'], { cwd, timeout: 20_000, windowsHide: true }, (err, stdout, stderr) => {
      if (err) return resolve({ set: null, why: `staleness.py --expected: ${(stderr || err.message).trim().split(/\r?\n/).pop()?.slice(0, 200)}` })
      try {
        const j = JSON.parse(stdout)
        if (!Array.isArray(j.registry) || !Array.isArray(j.recorded)) throw new Error('no registry / recorded lists')
        resolve({ set: { registry: j.registry.map(String), recorded: j.recorded.map(String), why: j.why ?? null }, why: null })
      } catch (e) { resolve({ set: null, why: `staleness.py --expected: ${(e as Error).message}` }) }
    })
  })
  expected = { at: Date.now(), p }
  p.then(r => { if (!r.set && expected?.p === p) expected = null })
  return p
}
