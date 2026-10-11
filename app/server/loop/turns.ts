import type { Agent } from '../../shared/types.ts'
import { ops, settled, transaction, type Queryable } from '../db.ts'
import { type CheckKey, CHECKS, LABELS, type Reason, type Span, clip, failedChecks, isLedger, isMachineLedger, reasonsFor, runChecks } from './grades.ts'
import { ownerOf } from './metrics.ts'

/**
 * TURN GRADES in the ops store. A TURN is one 'turn done' event of a conversation (runner.ts logs it
 * when a result lands); turn_ix is its 0-based position among that conversation's 'turn done'
 * events. Its assistant text is every assistant message indexed (ops.messages) after the previous
 * turn-kind event and up to it. The checks run once per turn (sweep), their rows are the record that
 * they ran; the owner's good / bad is one more row (source owner, key owner).
 */

export type Turn = { conv: string; ix: number; ts: number; from: number; agent: string | null }

/** every finished turn, in order, with the time window its text and tools fall in */
export async function turns(db: Queryable, conv?: string): Promise<Turn[]> {
  await settled()      // a 'turn done' event is queued by the runner: read after it lands
  const rows = await ops.turnEvents(conv ? { conversation: conv } : {}, db)
  const out: Turn[] = []
  const last = new Map<string, { ts: number; n: number }>()
  for (const r of rows) {
    const l = last.get(r.conversation_id) ?? { ts: 0, n: 0 }
    if (r.summary.startsWith('turn done')) {
      out.push({ conv: r.conversation_id, ix: l.n, ts: r.ts, from: l.ts, agent: r.agent_id })
      l.n++
    }
    l.ts = r.ts
    last.set(r.conversation_id, l)
  }
  return out
}

export async function turnText(db: Queryable, t: Turn): Promise<string> {
  return (await ops.assistantText(t.conv, t.from, t.ts, db)).join('\n\n')
}

/** paths the turn wrote, as the database saw them: Edit / Write tool rows (basename) + attributed commits */
export async function turnTouched(db: Queryable, t: Turn): Promise<string[]> {
  const out: string[] = []
  const tools = await ops.turnWindowEvents(t.conv, 'tool', t.from, t.ts, db)
  for (const x of tools) { const m = /^(?:Edit|Write)\s+(.+)$/.exec(x.summary); if (m) out.push(m[1].trim()) }
  for (const files of await ops.commitFiles(t.conv, t.from, t.ts, db)) {
    // files_json is jsonb (an array); a text row from before still parses
    try { const f = typeof files === 'string' ? JSON.parse(files) : files; if (Array.isArray(f)) out.push(...f.map(String)) } catch { /* skip */ }
  }
  return out
}

/** commits read from git (chat/changes.ts), per conversation: paths + commit time */
export type ChangesFor = (conv: string) => Promise<{ ts: number; files: string[] }[]>

/**
 * ledger files changed in the working tree and not committed, with their mtime (ms): the write a
 * shell append (`>> data/runs.jsonl`, a app/loop/tools script) leaves before anyone commits it. No tool
 * row and no commit carries it, so the file's own mtime is the only witness.
 */
export type Dirty = () => Promise<{ path: string; mtime: number }[]>

/** the roster's write scopes: an uncommitted ledger is a turn's witness only when that turn's agent may write it */
export type Scopes = Pick<Agent, 'id' | 'writes'>[]

/** may this turn's agent write the path? an agent missing from the roster (or none) is not scoped out */
export function inScope(agent: string | null, path: string, scopes?: Scopes): boolean {
  if (!scopes || !agent) return true
  const a = scopes.find(s => s.id === agent)
  if (!a) return true
  return ownerOf(path, [a]) !== null
}

export type SweepResult = { checked: number; queued: number; errors: string[] }

/** run the checks on every turn not yet checked; enqueue the ones that need the owner */
export async function sweep(db: Queryable, o: { changesFor?: ChangesFor; dirty?: Dirty; scopes?: Scopes; limit?: number; now?: number } = {}): Promise<SweepResult> {
  const done = new Set((await ops.gradedTurns('check', db)).map(r => `${r.conversation_id}#${r.turn_ix}`))
  const todo = (await turns(db)).filter(t => !done.has(`${t.conv}#${t.ix}`)).slice(0, o.limit ?? 500)
  const res: SweepResult = { checked: 0, queued: 0, errors: [] }
  const gitCache = new Map<string, { ts: number; files: string[] }[] | null>()
  const now = o.now ?? Date.now()
  let dirty: { path: string; mtime: number }[] = []
  if (o.dirty && todo.length) dirty = (await o.dirty().catch(e => { res.errors.push(`worktree: ${(e as Error).message}`); return [] })).filter(d => isLedger(d.path) && !isMachineLedger(d.path))
  for (const t of todo) {
    const text = await turnText(db, t)
    const r = runChecks(text)
    const touched = await turnTouched(db, t)
    if (o.changesFor) {
      if (!gitCache.has(t.conv)) gitCache.set(t.conv, await o.changesFor(t.conv).catch(e => { res.errors.push(`${t.conv}: ${(e as Error).message}`); return null }))
      for (const c of gitCache.get(t.conv) ?? []) if (c.ts > t.from && c.ts <= t.ts) touched.push(...c.files)   // git stamps whole seconds: a commit belongs to the first turn that ends at or after its stamp
    }
    // an uncommitted ledger whose last write fell inside this turn, inside this agent's own write scope
    // (a leftover pre-lake data/snapshots.jsonl never counts; two hands sharing a scope over one span can still both be flagged)
    for (const d of dirty) if (d.mtime > t.from && d.mtime <= t.ts && inScope(t.agent, d.path, o.scopes)) touched.push(d.path)
    const reasons = reasonsFor(t.conv, t.ix, r, touched)
    const spans = CHECKS.flatMap(k => r[k])
    const { excerpt, spans: kept } = clip(text, spans)
    const detail: Record<Reason, string> = {
      failed: failedChecks(r).join(', '),
      ledger: [...new Set(touched.filter(isLedger))].join(', '),
      sample: '5% sample',
    }
    try {
      await transaction(async c => {
        for (const k of CHECKS) await ops.upsertTurnGrade({ conversation_id: t.conv, turn_ix: t.ix, ts: t.ts, agent_id: t.agent, source: 'check', key: k,
          value: r[k].length ? 0 : 1, label: r[k].length ? JSON.stringify(r[k].map(s => [s.start, s.end])) : null, graded_at: now }, c)
        // a turn already queued for a reason keeps its row as it stands (state included)
        for (const why of reasons) await ops.upsert('review_queue', { conversation_id: t.conv, turn_ix: t.ix, reason: why, state: 'open', ts: t.ts, agent_id: t.agent,
          excerpt, spans_json: kept, detail: detail[why] }, { update: [] }, c)
      }, db)
    } catch (e) { res.errors.push(`${t.conv}#${t.ix}: ${(e as Error).message}`); continue }
    res.checked++
    if (reasons.length) res.queued++
  }
  return res
}

export type QueueItem = {
  conv: string
  turn: number
  ts: number
  agent: string | null
  reasons: Reason[]
  failed: CheckKey[]
  excerpt: string
  spans: Span[]
  detail: Partial<Record<Reason, string>>
  state: 'open' | 'done'
  grade: { value: number; label: string | null } | null
}

/** the queue, open items newest first (plus the most recently graded, so undo has something to show) */
export async function queue(db: Queryable, o: { done?: number } = {}): Promise<{ open: number; items: QueueItem[] }> {
  const rows = (await ops.listReviewAll(db)).map(r => ({ ...r, reason: r.reason as Reason }))
  const owner = new Map((await ops.listTurnGrades({ source: 'owner' }, db)).map(g => [`${g.conversation_id}#${g.turn_ix}`, g]))
  // the failed checks come from the check rows, never from the kept spans: a long turn clipped to its excerpt loses spans, not failures
  const failed = new Map<string, CheckKey[]>()
  const checkRows = (await ops.listTurnGrades({ source: 'check' }, db)).filter(g => g.value < 0.5).sort((a, b) => a.key.localeCompare(b.key))
  for (const g of checkRows) {
    if (!(CHECKS as string[]).includes(g.key)) continue
    const k = `${g.conversation_id}#${g.turn_ix}`
    failed.set(k, [...(failed.get(k) ?? []), g.key as CheckKey])
  }
  const by = new Map<string, QueueItem>()
  for (const r of rows) {
    const k = `${r.conversation_id}#${r.turn_ix}`
    let it = by.get(k)
    if (!it) {
      // spans_json is jsonb (an array); a text row from before still parses
      let spans: Span[] = []
      try { const s = typeof r.spans_json === 'string' ? JSON.parse(r.spans_json) : r.spans_json; spans = Array.isArray(s) ? s as Span[] : [] } catch { spans = [] }
      const g = owner.get(k)
      it = { conv: r.conversation_id, turn: r.turn_ix, ts: r.ts, agent: r.agent_id, reasons: [], failed: failed.get(k) ?? [...new Set(spans.map(s => s.check))], excerpt: r.excerpt ?? '', spans, detail: {}, state: 'done', grade: g ? { value: g.value, label: g.label } : null }
      by.set(k, it)
    }
    it.reasons.push(r.reason)
    if (r.detail) it.detail[r.reason] = r.detail
    if (r.state === 'open') it.state = 'open'
  }
  const all = [...by.values()]
  const open = all.filter(i => i.state === 'open')
  const done = all.filter(i => i.state === 'done').slice(0, o.done ?? 20)
  return { open: open.length, items: [...open, ...done] }
}

export class GradeError extends Error { constructor(public status: number, msg: string) { super(msg) } }

/** good (1) / bad (0) / undo (null) on one turn; closes (or reopens) its queue items */
export async function grade(db: Queryable, b: { conv?: unknown; turn?: unknown; value?: unknown; label?: unknown }, now = Date.now()): Promise<{ conv: string; turn: number; value: number | null; label: string | null }> {
  const conv = typeof b.conv === 'string' ? b.conv : ''
  const turn = Number(b.turn)
  if (!conv || !Number.isInteger(turn) || turn < 0) throw new GradeError(400, 'conv is a conversation id, turn a turn index')
  const v = b.value
  const value = v === null || v === 'undo' ? null : v === 'good' || v === 1 || v === true ? 1 : v === 'bad' || v === 0 || v === false ? 0 : undefined
  if (value === undefined) throw new GradeError(400, 'value is good, bad or null (undo)')
  const label = b.label === undefined || b.label === null || b.label === '' ? null : String(b.label)
  if (label !== null && !(LABELS as readonly string[]).includes(label)) throw new GradeError(400, `label is one of: ${LABELS.join(', ')}`)
  if (value === null) {
    await ops.clearOwnerGrade(conv, turn, db)
    return { conv, turn, value: null, label: null }
  }
  const t = (await turns(db, conv)).find(x => x.ix === turn)
  if (!t) throw new GradeError(404, `no turn ${turn} in ${conv}`)
  await transaction(async c => {
    await ops.upsertTurnGrade({ conversation_id: conv, turn_ix: turn, ts: t.ts, agent_id: t.agent, source: 'owner', key: 'owner', value, label, graded_at: now }, c)
    await ops.setReviewStateAll(conv, turn, 'done', c)
  }, db)
  return { conv, turn, value, label }
}

export type TurnGrade = { turn: number; ts: number; owner: number | null; label: string | null; failed: CheckKey[]; checked: boolean }

/** one conversation's turns with their grades, for the transcript dots */
export async function gradesOf(db: Queryable, conv: string): Promise<TurnGrade[]> {
  const gs = await ops.listTurnGrades({ conversationId: conv }, db)
  return (await turns(db, conv)).map(t => {
    const mine = gs.filter(g => g.turn_ix === t.ix)
    const o = mine.find(g => g.source === 'owner')
    const checks = mine.filter(g => g.source === 'check')
    return { turn: t.ix, ts: t.ts, owner: o ? o.value : null, label: o?.label ?? null, failed: checks.filter(c => c.value < 0.5).map(c => c.key as CheckKey), checked: checks.length > 0 }
  })
}
