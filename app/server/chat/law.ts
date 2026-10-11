import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { later, now, ops, settled } from '../db.ts'
import { chapterOf, splitRef } from '../../shared/bookmeta.ts'
import { FUND_ROOT } from '../paths.ts'

// THE LOADED-LAW MANIFEST: every instruction file (CLAUDE.md chain, rules, user memory) and every
// boot book / brief that entered a conversation's context, with the git blob SHA of the bytes as
// they were at load. `law(conv)` answers the rows plus DRIFT: the file changed on disk since it was
// loaded, it is gone, or it loaded at session_start and did not come back after a compaction.

export type LawRow = {
  id: number; ts: number; path: string; memoryType: string | null; reason: string
  trigger: string | null; sha: string | null; tokens: number | null
  drift: null | 'changed' | 'missing' | 'compacted'
  read: number                      // pulls of this path in this conversation (reads table)
  source: LawSource | null          // who wrote the row; null = recorded before the column existed
}
/** hook = the SDK's own InstructionsLoaded callback · derived = the cockpit read the start chain
 *  itself (the SDK fires no callback for session_start loads) · launch = the brief + boot books it appended */
export type LawSource = 'hook' | 'derived' | 'launch'
export type Law = { rows: LawRow[]; drift: number; tokens: number; compactions: number }

export const BOUNDARY = 'compact_boundary'

/** git's blob hash of a buffer: sha1("blob <len>\0" + bytes) - what `git hash-object` prints */
export function blobSha(buf: Buffer): string {
  return createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex')
}

/** fund-relative with forward slashes when inside the fund; else the absolute path, forward slashes */
export function lawPath(p: string, root = FUND_ROOT): string {
  const abs = isAbsolute(p) ? p : resolve(root, p)
  const rel = relative(root, abs)
  if (rel && !rel.startsWith('..') && !isAbsolute(rel)) return rel.split('\\').join('/')
  return abs.split('\\').join('/')
}
const absOf = (p: string, root = FUND_ROOT) => (isAbsolute(p) || /^[A-Za-z]:\//.test(p) ? p : resolve(root, p))

/** the git blob hash and token estimate of the bytes a conversation loaded. A `<book>#<slug>` ref hashes the
 *  CHAPTER slice alone (so an edit elsewhere in the book is no drift); a slug naming no heading has no sha: missing */
function snapshot(p: string, root = FUND_ROOT): { sha: string | null; tokens: number | null } {
  const { path, slug } = splitRef(p)
  try {
    const b = readFileSync(absOf(path, root))
    if (!slug) return { sha: blobSha(b), tokens: Math.round(b.toString('utf8').length / 4) }
    const c = chapterOf(b.toString('utf8'), slug)
    if (!c) return { sha: null, tokens: null }
    const slice = Buffer.from(c.text, 'utf8')
    return { sha: blobSha(slice), tokens: Math.round(c.text.length / 4) }
  } catch { return { sha: null, tokens: null } }
}

type LoadIn = { conversation_id: string; agent_id: string; ts: number; file_path: string; memory_type: string | null; load_reason: string
  trigger_file_path: string | null; sha: string | null; tokens: number | null; source: LawSource }
/** rows are QUEUED (db.later): recorded in call order from the runner's stream, never thrown into it */
const put = (rows: LoadIn[]) => later('law loads', async () => { for (const r of rows) await ops.addLawLoad(r) })

/** the SDK InstructionsLoaded hook input -> one row */
export function recordLoad(conversationId: string, agentId: string, input: { file_path?: unknown; memory_type?: unknown; load_reason?: unknown; trigger_file_path?: unknown }, root = FUND_ROOT, ts = now(), source: LawSource = 'hook') {
  const row = loadRow(conversationId, agentId, input, root, ts, source)
  return row ? put([row]) : Promise.resolve(undefined)
}
function loadRow(conversationId: string, agentId: string, input: { file_path?: unknown; memory_type?: unknown; load_reason?: unknown; trigger_file_path?: unknown }, root: string, ts: number, source: LawSource): LoadIn | null {
  const fp = typeof input.file_path === 'string' ? input.file_path : ''
  if (!fp) return null
  const s = snapshot(fp, root)
  const trig = typeof input.trigger_file_path === 'string' && input.trigger_file_path ? lawPath(input.trigger_file_path, root) : null
  return { conversation_id: conversationId, agent_id: agentId, ts, file_path: lawPath(fp, root), memory_type: typeof input.memory_type === 'string' ? input.memory_type : null,
    load_reason: typeof input.load_reason === 'string' ? input.load_reason : 'unknown', trigger_file_path: trig, sha: s.sha, tokens: s.tokens, source }
}

/** the brief + boot books (systemPrompt.append), one 'boot' row each; a missing one has no sha */
export function recordBoot(conversationId: string, agentId: string, paths: string[], root = FUND_ROOT, ts = now()) {
  return put(paths.map(p => {
    const s = snapshot(p, root)
    return { conversation_id: conversationId, agent_id: agentId, ts, file_path: lawPath(p, root), memory_type: 'Boot', load_reason: 'boot',
      trigger_file_path: null, sha: s.sha, tokens: s.tokens, source: 'launch' as const }
  }))
}

/**
 * THE START CHAIN, derived at boot. Measured 2026-09-24 against the SDK (0.3.281): an SDK callback
 * for InstructionsLoaded fires for nested_traversal, include and compact loads, but NEVER for the
 * session_start ones - they load before the hook is registered. So the cockpit reads the same chain
 * itself: user memory, then every CLAUDE.md / CLAUDE.local.md / .claude/CLAUDE.md from the fund root
 * down to the cwd, then their `@path` imports (reason 'include', trigger = the importing file).
 */
export function startChain(cwdAbs: string, root = FUND_ROOT, home = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')): { path: string; memoryType: string; reason: string; trigger: string | null }[] {
  const out: { path: string; memoryType: string; reason: string; trigger: string | null }[] = []
  const seen = new Set<string>()
  const add = (abs: string, memoryType: string, reason: string, trigger: string | null, depth: number) => {
    const key = resolve(abs).toLowerCase()
    if (seen.has(key) || !existsSync(abs)) return
    seen.add(key)
    out.push({ path: abs, memoryType, reason, trigger })
    if (depth >= 5) return
    let text = ''
    try { text = readFileSync(abs, 'utf8') } catch { return }
    let fence = false
    for (const line of text.split(/\r?\n/)) {
      if (/^\s*(```|~~~)/.test(line)) { fence = !fence; continue }
      const m = !fence && /^@([^\s`]+)\s*$/.exec(line.trim())
      if (m) add(resolve(dirname(abs), m[1].replace(/^~(?=[\\/])/, homedir())), memoryType, 'include', abs, depth + 1)
    }
  }
  add(join(home, 'CLAUDE.md'), 'User', 'session_start', null, 0)
  const rel = relative(root, cwdAbs)
  const dirs = [root]
  if (rel && !rel.startsWith('..') && !isAbsolute(rel)) {
    let cur = root
    for (const part of rel.split(/[\\/]/).filter(Boolean)) { cur = join(cur, part); dirs.push(cur) }
  }
  for (const d of dirs) {
    add(join(d, 'CLAUDE.md'), 'Project', 'session_start', null, 0)
    add(join(d, '.claude', 'CLAUDE.md'), 'Project', 'session_start', null, 0)
    add(join(d, 'CLAUDE.local.md'), 'Local', 'session_start', null, 0)
  }
  return out
}

/** the start chain as rows (see startChain) */
export function recordStart(conversationId: string, agentId: string, cwdAbs: string, root = FUND_ROOT, ts = now()) {
  return put(startChain(cwdAbs, root).map(f => loadRow(conversationId, agentId, { file_path: f.path, memory_type: f.memoryType, load_reason: f.reason, trigger_file_path: f.trigger ?? undefined }, root, ts, 'derived'))
    .filter((r): r is LoadIn => r !== null))
}

/** a compaction happened: files loaded before it must reappear after it */
export function recordBoundary(conversationId: string, agentId: string, ts = now()) {
  return put([{ conversation_id: conversationId, agent_id: agentId, ts, file_path: '', memory_type: null, load_reason: BOUNDARY, trigger_file_path: null, sha: null, tokens: null, source: 'hook' }])
}

type Raw = { id: number; ts: number; file_path: string; memory_type: string | null; load_reason: string; trigger_file_path: string | null; sha: string | null; tokens: number | null; source: string | null }
const SOURCES: readonly string[] = ['hook', 'derived', 'launch']

/** the manifest: the LATEST load of each path, with drift judged against the disk now */
export async function law(conversationId: string, root = FUND_ROOT): Promise<Law> {
  await settled()
  const all: Raw[] = await ops.listLawLoads(conversationId)
  const boundaries = all.filter(r => r.load_reason === BOUNDARY).map(r => r.ts)
  const lastBoundary = boundaries.length ? Math.max(...boundaries) : null
  const latest = new Map<string, Raw>()
  for (const r of all) if (r.load_reason !== BOUNDARY) latest.set(r.file_path, r)
  const reads = await ops.countReadsByBook(conversationId)
  const rows: LawRow[] = [...latest.values()].map(r => {
    const disk = snapshot(r.file_path, root)
    let drift: LawRow['drift'] = null
    if (disk.sha === null) drift = 'missing'
    else if (r.sha && disk.sha !== r.sha) drift = 'changed'
    // KNOWN GAP (measured 2026-09-25 on c-mug4u9pl-263p): after a compaction the SDK hook re-fires
    // (reason 'compact') only for files that loaded at session_start. Include rows (e.g.
    // platform/CLAUDE.md, HQ.md pulled in by an @-import) are never re-recorded, and this rule
    // flags only session_start rows, so an include missing after a compaction is NEVER flagged.
    else if (lastBoundary !== null && r.load_reason === 'session_start' && r.ts <= lastBoundary) drift = 'compacted'
    return { id: r.id, ts: r.ts, path: r.file_path, memoryType: r.memory_type, reason: r.load_reason, trigger: r.trigger_file_path, sha: r.sha, tokens: r.tokens, drift, read: reads.get(splitRef(r.file_path).path) ?? 0, source: r.source && SOURCES.includes(r.source) ? r.source as LawSource : null }
  })
  return { rows, drift: rows.filter(r => r.drift).length, tokens: rows.reduce((n, r) => n + (r.tokens ?? 0), 0), compactions: boundaries.length }
}
