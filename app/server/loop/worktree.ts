import { statSync } from 'node:fs'
import { join } from 'node:path'
import { git } from '../git/run.ts'
import { isLedger, isMachineLedger } from './grades.ts'

/** porcelain -z records -> paths (a rename record carries its old path as the next field; skipped) */
export function porcelainPaths(z: string): string[] {
  const f = z.split('\0')
  const out: string[] = []
  for (let i = 0; i < f.length; i++) {
    const r = f[i]
    if (r.length < 4) continue
    out.push(r.slice(3))
    if (r[0] === 'R' || r[0] === 'C') i++
  }
  return out
}

/**
 * the desk ledgers changed in a repo's working tree and not yet committed, with each file's mtime:
 * what an uncommitted shell append leaves behind (see turns.ts Dirty)
 */
export async function dirtyLedgers(repo: string): Promise<{ path: string; mtime: number }[]> {
  const r = await git(repo, ['status', '--porcelain', '-z', '-uall'])
  if (r.code !== 0) throw new Error(r.stderr.trim() || `git status exited ${r.code}`)
  const out: { path: string; mtime: number }[] = []
  for (const p of porcelainPaths(r.stdout)) {
    if (!isLedger(p) || isMachineLedger(p)) continue
    try { out.push({ path: p, mtime: statSync(join(repo, p)).mtimeMs }) } catch { /* deleted: nothing appended */ }
  }
  return out
}
