import { git } from './run.ts'
import { isLibraryBook, parseNameStatusZ, shrinkReport, type ShrinkReport } from '../../scripts/hooks/guard-lib.mjs'

// The book shrink warning, read back from history: the same rule the commit-msg hook applies
// (scripts/hooks/guard-lib.mjs), run on `sha^:path` vs `sha:path` for every library book a
// commit touched. Blobs only, no network.

export type { ShrinkReport }

/** does any path in a commit's file list look like a library book? (cheap pre-filter) */
export const touchesLibrary = (files: string[]) => files.some(f => isLibraryBook(f))

async function blob(dir: string, spec: string): Promise<string | null> {
  const r = await git(dir, ['show', spec])
  return r.code === 0 ? r.stdout : null
}

/**
 * One commit's shrink report, or null when it touched no library book (or git could not say).
 * A root commit is compared against nothing: every book in it is new, so nothing is flagged.
 */
export async function commitShrink(dir: string, sha: string, message: string): Promise<ShrinkReport | null> {
  const parent = await git(dir, ['rev-parse', '--verify', '--quiet', `${sha}^`])
  const ns = parent.code === 0
    ? await git(dir, ['diff-tree', '-r', '-M', '--no-commit-id', '--name-status', '-z', `${sha}^`, sha])
    : await git(dir, ['diff-tree', '-r', '--root', '--no-commit-id', '--name-status', '-z', sha])
  if (ns.code !== 0) return null
  const pairs: { path: string; before: string | null; after: string | null }[] = []
  for (const r of parseNameStatusZ(ns.stdout)) {
    if (!isLibraryBook(r.to) && !isLibraryBook(r.from)) continue
    const before = parent.code !== 0 || r.status === 'A' || r.status === 'C' ? null : await blob(dir, `${sha}^:${r.from}`)
    const after = r.status === 'D' ? null : await blob(dir, `${sha}:${r.to}`)
    pairs.push({ path: r.status === 'D' ? r.from : r.to, before, after })
  }
  if (!pairs.length) return null
  return shrinkReport(pairs, message)
}
