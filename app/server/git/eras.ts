import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { git } from './run.ts'

// ERAS: the CEO's era books (app/library/law/the-annals/NN-*.md, frontmatter {title, from, to}) mapped
// to commit ranges in every managed repo. Frontmatter only: an era is WRITTEN, never inferred from
// commit clustering. A book with bad frontmatter is returned with `error`, never dropped.

export const ANNALS = 'app/library/law/the-annals'

export type Era = {
  id: string                    // the file name without .md
  book: string                  // fund-relative path
  title: string | null
  from: string | null           // YYYY-MM-DD
  to: string | null             // YYYY-MM-DD | 'open'
  error: string | null          // why the frontmatter does not parse; null = good
  counts: Record<string, number | null>   // repo id -> commits in range (null = git could not say)
}

const DAY = /^\d{4}-\d{2}-\d{2}$/

/** a real calendar day (2026-02-30 is not) */
export function isDay(s: string): boolean {
  if (!DAY.test(s)) return false
  const d = new Date(`${s}T00:00:00Z`)
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s
}

/** the day after a YYYY-MM-DD */
export function nextDay(s: string): string {
  const d = new Date(`${s}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + 1)
  return d.toISOString().slice(0, 10)
}

function frontmatter(raw: string): Record<string, string> | null {
  const text = raw.replace(/^﻿/, '').replace(/\r\n/g, '\n')
  if (!text.startsWith('---\n')) return null
  const end = text.indexOf('\n---', 3)
  if (end < 0) return null
  const fm: Record<string, string> = {}
  for (const line of text.slice(4, end).split('\n')) {
    const m = /^([A-Za-z_][\w-]*):\s*(.*?)\s*$/.exec(line)
    if (m) fm[m[1]] = m[2].replace(/^(["'])(.*)\1$/, '$2')
  }
  return fm
}

/** one era book -> its era (counts empty); bad frontmatter -> error set, fields as far as read */
export function parseEra(file: string, raw: string, dir = ANNALS): Era {
  const id = file.replace(/\.md$/i, '')
  const e: Era = { id, book: `${dir}/${file}`, title: null, from: null, to: null, error: null, counts: {} }
  const fm = frontmatter(raw)
  if (!fm) return { ...e, error: 'no frontmatter' }
  e.title = fm.title?.trim() || null
  e.from = fm.from?.trim() || null
  e.to = fm.to?.trim() || null
  const bad: string[] = []
  if (!e.title) bad.push('title missing')
  if (!e.from) bad.push('from missing')
  else if (!isDay(e.from)) bad.push(`from "${e.from}" is not YYYY-MM-DD`)
  if (!e.to) bad.push('to missing')
  else if (e.to !== 'open' && !isDay(e.to)) bad.push(`to "${e.to}" is not YYYY-MM-DD or open`)
  else if (e.to !== 'open' && e.from && isDay(e.from) && e.to < e.from) bad.push('to is before from')
  return bad.length ? { ...e, error: bad.join('; ') } : e
}

/** every NN-*.md in the annals folder, in file order; [] when the series does not exist */
export function readEras(fundRoot: string, dir = ANNALS): Era[] {
  const abs = join(fundRoot, dir)
  if (!existsSync(abs)) return []
  let files: string[]
  try { files = readdirSync(abs).filter(f => /^\d+-.+\.md$/i.test(f)).sort() } catch { return [] }
  return files.map(f => {
    try { return parseEra(f, readFileSync(join(abs, f), 'utf8'), dir) } catch (err: any) {
      return { id: f.replace(/\.md$/i, ''), book: `${dir}/${f}`, title: null, from: null, to: null, error: `unreadable: ${err?.message ?? err}`, counts: {} }
    }
  })
}

/** git's date bounds for an era: from 00:00 local to the day after `to` (inclusive range) */
export function rangeArgs(from: string, to: string | 'open' | null): string[] {
  const a = [`--since=${from} 00:00:00`]
  if (to && to !== 'open') a.push(`--until=${nextDay(to)} 00:00:00`)
  return a
}

const countCache = new Map<string, number | null>()

/** commits on HEAD inside [from, to]; null when git fails. Cached by HEAD sha. */
export async function eraCount(dir: string, from: string, to: string): Promise<number | null> {
  const head = (await git(dir, ['rev-parse', 'HEAD'])).stdout.trim()
  if (!head) return null
  const key = `${dir}|${head}|${from}|${to}`
  if (countCache.has(key)) return countCache.get(key)!
  const out = await git(dir, ['rev-list', '--count', ...rangeArgs(from, to), 'HEAD'])
  const n = out.code === 0 ? Number(out.stdout.trim()) : NaN
  const v = Number.isFinite(n) ? n : null
  // an open era's count moves with HEAD, which is in the key; a failure is never cached
  if (v !== null) countCache.set(key, v)
  return v
}

/** the eras with their per-repo counts filled (bad eras keep counts {}) */
export async function erasWithCounts(fundRoot: string, repos: { id: string; dir: string }[], dir = ANNALS): Promise<Era[]> {
  const eras = readEras(fundRoot, dir)
  await Promise.all(eras.filter(e => !e.error).map(async e => {
    const pairs = await Promise.all(repos.map(async r => [r.id, await eraCount(r.dir, e.from!, e.to!)] as const))
    e.counts = Object.fromEntries(pairs)
  }))
  return eras
}

/** the most commits one ranged log returns (per repo, and after the merge) */
export const RANGE_CAP = 500

/** `git log` count + date args: a range = up to RANGE_CAP inside it, none = the newest 50 */
export function logRangeArgs(range: { since: string; until: string | null } | null): string[] {
  return range ? [`-${RANGE_CAP}`, ...rangeArgs(range.since, range.until ?? 'open')] : ['-50']
}
