import { existsSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type { HealthCheck } from '../../shared/types.ts'
import { within } from '../paths.ts'
import { portOpen } from './ports.ts'

export type CheckStatus = 'ok' | 'warn' | 'fail' | 'unknown'
export type CheckResult = { status: CheckStatus; reading: string; detail?: Record<string, unknown> }

/** "15m" / "5m" / "1h" / "30s" / "1d" -> ms; default 15m */
export function parseEvery(s: string | undefined): number {
  const m = /^(\d+(?:\.\d+)?)\s*(s|m|h|d)$/.exec((s ?? '').trim())
  if (!m) return 15 * 60_000
  return Number(m[1]) * { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as 's' | 'm' | 'h' | 'd']
}

/** `~` = the home dir; anything else is fund-relative and must stay inside the fund root */
export function resolveCheckPath(p: string, fundRoot: string, home = homedir()): string | null {
  if (p === '~' || p.startsWith('~/') || p.startsWith('~\\')) return resolve(home, p.slice(2))
  const abs = resolve(fundRoot, p)
  return within(abs, fundRoot) ? abs : null
}

/** newest mtime of any file at/under `path` (bounded walk); null when nothing is there */
export function newestMtime(path: string, limit = 50_000): { mtime: number; file: string; files: number } | null {
  let best: { mtime: number; file: string } | null = null
  let files = 0
  const stack = [path]
  while (stack.length && files < limit) {
    const p = stack.pop()!
    let st
    try { st = statSync(p) } catch { continue }
    if (st.isDirectory()) {
      let names: string[] = []
      try { names = readdirSync(p) } catch { continue }
      for (const n of names) stack.push(join(p, n))
    } else {
      files++
      if (!best || st.mtimeMs > best.mtime) best = { mtime: st.mtimeMs, file: p }
    }
  }
  return best ? { ...best, files } : null
}

export function fmtAgeMs(ms: number): string {
  const m = Math.max(0, Math.floor(ms / 60000))
  return m < 60 ? `${m}m` : m < 2880 ? `${Math.floor(m / 60)}h` : `${Math.floor(m / 1440)}d`
}

/**
 * A port check only says SOMETHING listens. When an http check on the same port fails in the same
 * pass, the listener is not this dashboard (a stray server holding its port) or it is broken, so the
 * port check is not ok either: it turns `warn` and says why. Pure; results are index-aligned.
 */
export function reconcilePort(checks: HealthCheck[], results: CheckResult[]): CheckResult[] {
  const portOf = (c: HealthCheck) => {
    if (c.check === 'port') return c.port
    if (c.check === 'http') { try { const u = new URL(c.url); return Number(u.port || (u.protocol === 'https:' ? 443 : 80)) } catch { return null } }
    return null
  }
  return results.map((r, i) => {
    const c = checks[i]
    if (c.check !== 'port' || r.status !== 'ok') return r
    const bad = checks.findIndex((x, j) => x.check === 'http' && portOf(x) === c.port && results[j].status === 'fail')
    return bad < 0 ? r : { status: 'warn', reading: `${r.reading}, but ${checks[bad].id} fails (${results[bad].reading})`, detail: { ...(r.detail ?? {}), apiCheck: checks[bad].id } }
  })
}

/** run one health check. Never throws: a broken check is a `fail` with the reason. */
export async function runCheck(c: HealthCheck, opts: { fundRoot: string; home?: string; now?: number; httpTimeoutMs?: number }): Promise<CheckResult> {
  const now = opts.now ?? Date.now()
  try {
    switch (c.check) {
      case 'port': {
        const up = await portOpen(c.port, '127.0.0.1', 1500)
        return up ? { status: 'ok', reading: `:${c.port} open` } : { status: 'fail', reading: `:${c.port} closed` }
      }
      case 'http': {
        const t0 = Date.now()
        const ctl = new AbortController()
        const timer = setTimeout(() => ctl.abort(), opts.httpTimeoutMs ?? 4000)
        try {
          const res = await fetch(c.url, { signal: ctl.signal, redirect: 'manual' })
          await res.arrayBuffer().catch(() => null)
          const ms = Date.now() - t0
          const ok = res.status >= 200 && res.status < 300
          return { status: ok ? 'ok' : 'fail', reading: `${res.status} ${ms}ms`, detail: { status: res.status, ms } }
        } catch (e: any) {
          const reason = e?.name === 'AbortError' ? 'timeout' : String(e?.cause?.code ?? e?.message ?? e)
          return { status: 'fail', reading: reason }
        } finally { clearTimeout(timer) }
      }
      case 'exists': {
        const p = resolveCheckPath(c.path, opts.fundRoot, opts.home)
        if (!p) return { status: 'fail', reading: 'path escapes the fund root' }
        return existsSync(p) ? { status: 'ok', reading: 'present' } : { status: 'fail', reading: 'missing', detail: { path: p } }
      }
      case 'file_age': {
        const p = resolveCheckPath(c.path, opts.fundRoot, opts.home)
        if (!p) return { status: 'fail', reading: 'path escapes the fund root' }
        if (!existsSync(p)) return { status: 'fail', reading: 'missing', detail: { path: p } }
        const n = newestMtime(p)
        if (!n) return { status: 'fail', reading: 'empty', detail: { path: p } }
        const age = now - n.mtime
        const ok = age <= c.max_h * 3_600_000
        return { status: ok ? 'ok' : 'warn', reading: `${fmtAgeMs(age)} old`, detail: { newest: n.mtime, file: n.file, files: n.files, max_h: c.max_h } }
      }
    }
    return { status: 'unknown', reading: `unknown check ${(c as any).check}` }
  } catch (e: any) {
    return { status: 'fail', reading: String(e?.message ?? e) }
  }
}

export type DashState = 'running' | 'stale' | 'failing' | 'stopped' | 'dev'

/**
 * The dashboard status rule. Port closed = stopped (grey: nobody started it, nothing is
 * broken). Port up: a failed check = failing, a warn = stale, else running; a dev-mode
 * process with its port up = dev. Checks not yet measured do not make it look healthy -
 * they are reported by `measured` so the UI can show an outline instead of a green dot.
 */
export function dashStatus(portUp: boolean, checks: CheckStatus[], dev = false): { state: DashState; measured: boolean } {
  const measured = checks.length > 0 && checks.every(s => s !== 'unknown')
  if (!portUp) return { state: 'stopped', measured }
  if (checks.includes('fail')) return { state: 'failing', measured }
  if (checks.includes('warn')) return { state: 'stale', measured }
  return { state: dev ? 'dev' : 'running', measured }
}
