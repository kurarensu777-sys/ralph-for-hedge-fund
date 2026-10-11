import { spawnSync } from 'node:child_process'
import { statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { later, ops } from '../db.ts'
import type { Item } from './store.ts'

/**
 * OWNER ATTESTATION for board auto-pickup. `from: you` is frontmatter in a file any agent can
 * write, so auto.ts never trusts it alone. An item is the owner's when EITHER:
 *
 *  1. the cockpit UI filed or last edited it (a POST/PATCH carrying the cockpit's own Origin,
 *     which a browser sets and a script does not) and its (owner, from, labels) still match what
 *     that request left - recorded in board_attest; or
 *  2. its file is committed, clean against HEAD, and the last commit that touched it carries no
 *     Agent trailer (the commit guard appends one to every agent commit).
 *
 * THE OWNER'S CHOICE (the needs-you contract, 2026-09-25). An item an AGENT filed is never the
 * owner's, with one exception: the owner chose one of its options. The choice is his word, attested
 * the same two ways - recorded here by the cockpit's choose route (key `<id>#chosen`, fingerprint
 * owner/from/labels/chosen, so an agent that rewrites any of them breaks it), or committed clean
 * with no Agent trailer after `board.mjs choose` (which refuses any FUND_AGENT).
 *
 * Residual, stated: an agent under bypassPermissions that deliberately forges an Origin header or
 * writes this database can still pass; this closes the accidental path (a raw file with
 * `from: you`), not a determined forger. MAX_AUTO and MAX_AUTO_PER_DAY remain the hard bound.
 *
 * THE MIRROR. The rows live in ops.board_attest; fundd is their only writer, so it keeps them in
 * memory too (loaded once by loadAttest(), written through by every attest here) and the predicate
 * auto.ts calls stays synchronous. Before loadAttest() resolves an item reads as not attested by
 * the table (it can still pass by git), which only ever HOLDS an item, never runs one.
 */

/** id -> the row as last written (the mirror of ops.board_attest) */
const MIRROR = new Map<string, Row>()
let loaded: Promise<void> | null = null
/** read ops.board_attest into the mirror once (a row written since keeps its newer value) */
export function loadAttest(): Promise<void> {
  loaded ??= (async () => {
    for (const r of await ops.listBoardAttest()) if (!MIRROR.has(r.id)) MIRROR.set(r.id, { id: r.id, fp: r.fp, ts: r.ts, via: r.via })
  })().catch(e => { loaded = null; throw e })
  return loaded
}
function put(r: Row) {
  MIRROR.set(r.id, r)
  void later('board attest', () => ops.attestBoard(r.id, r.fp, r.via, { ts: r.ts }))
}

export function fingerprint(i: Pick<Item, 'owner' | 'from' | 'labels'>): string {
  return JSON.stringify({ owner: i.owner || '', from: i.from || 'you', labels: [...i.labels].map(String).sort() })
}

/** record that the owner's own path left this item in this shape */
export function attest(i: Item, via: string) {
  if ((i.from || 'you') !== 'you') return
  put({ id: i.id, fp: fingerprint(i), ts: Date.now(), via })
}

/** the choice's own fingerprint: what the owner's pick left (who runs it, labels, the pick) */
export function choiceFingerprint(i: Pick<Item, 'owner' | 'from' | 'labels' | 'chosen'>): string {
  return JSON.stringify({ owner: i.owner || '', from: i.from || 'you', labels: [...i.labels].map(String).sort(), chosen: i.chosen ?? '' })
}
const choiceKey = (id: string) => `${id}#chosen`

/** record that the owner's own path (the cockpit) chose this item's option, in this shape */
export function attestChoice(i: Item, via: string) {
  if (!i.chosen) return
  put({ id: choiceKey(i.id), fp: choiceFingerprint(i), ts: Date.now(), via })
}

type Row = { id: string; fp: string; ts: number; via: string }
/** the item's attestation rows as they stand (so an undone choice puts them back exactly) */
export function snapshotAttest(id: string): Row[] {
  return [id, choiceKey(id)].flatMap(k => { const r = MIRROR.get(k); return r ? [{ ...r }] : [] })
}
export function restoreAttest(id: string, rows: Row[]) {
  const keys = [id, choiceKey(id)]
  for (const k of keys) MIRROR.delete(k)
  for (const r of rows) MIRROR.set(r.id, r)
  void later('board attest restore', async () => {
    for (const k of keys) await ops.dropBoardAttest(k)
    for (const r of rows) await ops.attestBoard(r.id, r.fp, r.via, { ts: r.ts })
  })
}

const dbChoiceAttested = (i: Item): boolean => MIRROR.get(choiceKey(i.id))?.fp === choiceFingerprint(i)
const dbAttested = (i: Item): boolean => MIRROR.get(i.id)?.fp === fingerprint(i)

/** the commit-trailer rule, read from git: clean against HEAD and last touched by no agent */
export function gitOwnerCommitted(fundRoot: string, rel: string, run = git): boolean {
  const dirty = run(fundRoot, ['status', '--porcelain', '--', rel])
  if (dirty === null || dirty.trim() !== '') return false          // untracked, modified or unreadable
  const body = run(fundRoot, ['log', '-1', '--format=%B', '--', rel])
  if (body === null || body.trim() === '') return false             // never committed
  return !/^Agent:\s*\S/im.test(body)
}

function git(cwd: string, args: string[]): string | null {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, timeout: 10_000 })
  return r.status === 0 ? r.stdout : null
}

const cache = new Map<string, { key: string; ok: boolean; at: number }>()

/** attested(i) for auto.ts, reading board/<id>.md under fundRoot: the owner filed it, or chose on it */
export function attestedFn(fundRoot: string, boardDir: string) {
  return (i: Item): boolean => {
    const byOwner = (i.from || 'you') === 'you'
    if (!byOwner && !i.chosen) return false
    if (byOwner ? dbAttested(i) : dbChoiceAttested(i)) return true
    const file = join(boardDir, `${i.id}.md`)
    let mtime = 0
    try { mtime = statSync(file).mtimeMs } catch { return false }
    const key = `${mtime}:${byOwner ? fingerprint(i) : choiceFingerprint(i)}`
    const c = cache.get(i.id)
    if (c && c.key === key && Date.now() - c.at < 60_000) return c.ok
    const rel = relative(fundRoot, file).split(sep).join('/')
    const ok = gitOwnerCommitted(fundRoot, rel)
    cache.set(i.id, { key, ok, at: Date.now() })
    return ok
  }
}
