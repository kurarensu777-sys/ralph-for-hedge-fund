/**
 * @fund/db ops - typed functions over the ops store, the mirror of fund_db.ops NAME FOR NAME
 * (snake_case there, camelCase here; tests/test_contract.py fails when the two lists differ).
 *
 * Conventions: times are epoch MILLISECONDS; required arguments are positional, optional ones sit
 * in one options object, and the last argument `q` is an optional pool or transaction client
 * (`transaction(async c => { await ops.logEvent('x', 'y', {}, c) })`). Rows are shaped like the
 * interfaces in rows.ts.
 */
import { exec, one, query, transaction, type Queryable } from './db.ts'
import type { Rows } from './rows.ts'
import { adapt, checkCols, count, del, get, insert, nowMs, qi, readable, select, update, upsert } from './table.ts'

export { count, del, get, insert, nowMs, select, transaction, update, upsert }

type R<T extends keyof Rows> = Rows[T]
const cols = readable

// ------------------------------------------------------------------------------------------ events

/** append one row to the activity feed; returns its id */
export async function logEvent(kind: string, summary: string,
  o: { agent?: string | null; conversation?: string | null; payload?: unknown; ts?: number } = {}, q?: Queryable): Promise<number> {
  return (await insert('events', { ts: o.ts ?? nowMs(), kind, summary, agent_id: o.agent ?? null,
    conversation_id: o.conversation ?? null, payload_json: o.payload === undefined ? null : o.payload }, q)).id
}

/** newest first */
export async function listEvents(o: { limit?: number; agent?: string; kinds?: string[]; since?: number; conversation?: string } = {},
  q?: Queryable): Promise<R<'events'>[]> {
  const w: string[] = []; const a: unknown[] = []
  if (o.agent !== undefined) { a.push(o.agent); w.push(`agent_id = $${a.length}`) }
  if (o.kinds?.length) { a.push(o.kinds); w.push(`kind = ANY($${a.length})`) }
  if (o.since !== undefined) { a.push(o.since); w.push(`ts >= $${a.length}`) }
  if (o.conversation !== undefined) { a.push(o.conversation); w.push(`conversation_id = $${a.length}`) }
  a.push(o.limit ?? 200)
  return query(`SELECT ${cols('events')} FROM ops.events${w.length ? ' WHERE ' + w.join(' AND ') : ''} ORDER BY ts DESC, id DESC LIMIT $${a.length}`, a, q)
}

// ----------------------------------------------------------------------------------- conversations

export async function createConversation(id: string, agentId: string,
  o: { title?: string; transcriptUuid?: string | null; state?: string; cwd?: string | null; startedAt?: number; model?: string | null; effort?: string | null } = {},
  q?: Queryable): Promise<R<'conversations'>> {
  const t = o.startedAt ?? nowMs()
  return insert('conversations', { id, agent_id: agentId, title: o.title ?? '', transcript_uuid: o.transcriptUuid ?? null,
    state: o.state ?? 'idle', cwd: o.cwd ?? null, started_at: t, last_at: t, model: o.model ?? null, effort: o.effort ?? null }, q)
}

export async function getConversation(id: string, o: { includeForgotten?: boolean } = {}, q?: Queryable): Promise<R<'conversations'> | null> {
  const r = await get('conversations', id, q)
  return r && (o.includeForgotten || !r.forgotten) ? r : null
}

export async function conversationByTranscript(transcriptUuid: string, q?: Queryable): Promise<R<'conversations'> | null> {
  return (await select('conversations', { where: { transcript_uuid: transcriptUuid }, limit: 1 }, q))[0] ?? null
}

/** newest activity first */
export async function listConversations(o: { agent?: string; limit?: number; includeForgotten?: boolean; since?: number } = {},
  q?: Queryable): Promise<R<'conversations'>[]> {
  const w: string[] = []; const a: unknown[] = []
  if (o.agent !== undefined) { a.push(o.agent); w.push(`agent_id = $${a.length}`) }
  if (!o.includeForgotten) w.push('NOT forgotten')
  if (o.since !== undefined) { a.push(o.since); w.push(`last_at >= $${a.length}`) }
  a.push(o.limit ?? 200)
  return query(`SELECT ${cols('conversations')} FROM ops.conversations${w.length ? ' WHERE ' + w.join(' AND ') : ''} ORDER BY last_at DESC LIMIT $${a.length}`, a, q)
}

/** set any conversation columns (title, state, transcript_uuid, last_at, model, effort, indexed, ...) */
export async function updateConversation(id: string, fields: Partial<R<'conversations'>>, q?: Queryable): Promise<R<'conversations'> | null> {
  return update('conversations', id, fields, q)
}

export async function forgetConversation(id: string, q?: Queryable): Promise<R<'conversations'> | null> {
  return update('conversations', id, { forgotten: true, state: 'closed' }, q)
}

/** at daemon start: nothing is live any more; returns how many rows changed */
export async function closeOpenConversations(q?: Queryable): Promise<number> {
  return exec("UPDATE ops.conversations SET state = 'closed' WHERE state <> 'closed'", [], q)
}

export async function knownTranscripts(q?: Queryable): Promise<Set<string>> {
  return new Set((await query<{ u: string }>('SELECT transcript_uuid AS u FROM ops.conversations WHERE transcript_uuid IS NOT NULL', [], q)).map(r => r.u))
}

/** one usage row, and the conversation's running totals bumped in the same transaction */
export async function addUsage(conversationId: string | null, agentId: string,
  o: { tokensIn?: number; tokensOut?: number; cacheRead?: number; cacheWrite?: number; costUsd?: number; model?: string | null; ts?: number } = {},
  q?: Queryable): Promise<number> {
  const ti = o.tokensIn ?? 0, to = o.tokensOut ?? 0, cost = o.costUsd ?? 0
  return transaction(async c => {
    const id = (await insert('usage', { ts: o.ts ?? nowMs(), agent_id: agentId, conversation_id: conversationId, model: o.model ?? null,
      tokens_in: ti, tokens_out: to, cache_read: o.cacheRead ?? 0, cache_write: o.cacheWrite ?? 0, cost_usd: cost }, c)).id
    if (conversationId !== null) await c.query('UPDATE ops.conversations SET tokens_in = tokens_in + $1, tokens_out = tokens_out + $2, ' +
      'cost_usd = cost_usd + $3 WHERE id = $4', [ti, to, cost, conversationId])
    return id
  }, q)
}

/** oldest first */
export async function listUsage(o: { since?: number; agent?: string } = {}, q?: Queryable): Promise<R<'usage'>[]> {
  const a: unknown[] = [o.since ?? 0]; let w = 'ts >= $1'
  if (o.agent !== undefined) { a.push(o.agent); w += ` AND agent_id = $${a.length}` }
  return query(`SELECT ${cols('usage')} FROM ops.usage WHERE ${w} ORDER BY ts, id`, a, q)
}

// ---------------------------------------------------------------------------------------- messages

export const MESSAGE_MAX_CHARS = 20_000

/** index one message for search (text clipped to 20,000 chars) */
export async function indexMessage(conversationId: string, role: string, text: string, o: { ts?: number } = {}, q?: Queryable): Promise<number> {
  return (await insert('messages', { conversation_id: conversationId, role, ts: o.ts ?? nowMs(), text: text.slice(0, MESSAGE_MAX_CHARS) }, q)).id
}

/** re-index a whole conversation atomically: [{role, text, ts}] replaces what was there */
export async function replaceMessages(conversationId: string, messages: { role: string; text: string; ts?: number }[], q?: Queryable): Promise<number> {
  return transaction(async c => {
    await c.query('DELETE FROM ops.messages WHERE conversation_id = $1', [conversationId])
    for (const m of messages) await indexMessage(conversationId, m.role, m.text, { ts: m.ts }, c)
    return messages.length
  }, q)
}

export interface MessageHit { conversation_id: string; snippet: string; rank: number }

/** full-text search over every indexed message, best first; web-search syntax ("phrase", -not, or) */
export async function searchMessages(text: string, o: { limit?: number } = {}, q?: Queryable): Promise<MessageHit[]> {
  if (!text.trim()) return []
  return query<MessageHit>("SELECT conversation_id, ts_headline('simple', text, x, 'MaxWords=10, MinWords=4, StartSel=\"\", StopSel=\"\", " +
    "FragmentDelimiter=\"...\"') AS snippet, ts_rank(tsv, x) AS rank FROM ops.messages, websearch_to_tsquery('simple', $1) x " +
    'WHERE tsv @@ x ORDER BY rank DESC, ts DESC LIMIT $2', [text, o.limit ?? 400], q)
}

/** each conversation's newest indexed message text; a conversation with none is absent */
export async function lastMessages(conversationIds: string[], q?: Queryable): Promise<Map<string, string>> {
  if (!conversationIds.length) return new Map()
  const rows = await query<{ conversation_id: string; text: string }>('SELECT DISTINCT ON (conversation_id) conversation_id, text ' +
    'FROM ops.messages WHERE conversation_id = ANY($1) ORDER BY conversation_id, ts DESC, id DESC', [conversationIds], q)
  return new Map(rows.map(r => [r.conversation_id, r.text]))
}

// ---------------------------------------------------------------------------------------- presence

/** heartbeat a hand: a new hand gets since = now; an existing one keeps its since */
export async function setPresence(handId: string, agentId: string,
  o: { conversationId?: string | null; doing?: string | null; pid?: number | null; ts?: number } = {}, q?: Queryable): Promise<R<'presence'>> {
  const t = o.ts ?? nowMs()
  return upsert('presence', { hand_id: handId, agent_id: agentId, conversation_id: o.conversationId ?? null, doing: o.doing ?? null,
    since: t, heartbeat_at: t, pid: o.pid ?? null }, { update: ['doing', 'heartbeat_at'] }, q)
}

export async function clearPresence(handId: string, q?: Queryable): Promise<number> { return del('presence', handId, q) }

/** drop every hand whose id starts with `prefix` (e.g. 'chat:' at daemon start) */
export async function clearPresencePrefix(prefix: string, q?: Queryable): Promise<number> {
  return exec('DELETE FROM ops.presence WHERE left(hand_id, $1) = $2', [prefix.length, prefix], q)
}

export async function listPresence(o: { freshSince?: number } = {}, q?: Queryable): Promise<R<'presence'>[]> {
  const rows = await select('presence', { orderBy: '-heartbeat_at' }, q)
  return o.freshSince === undefined ? rows : rows.filter(r => r.heartbeat_at >= o.freshSince!)
}

// ------------------------------------------------------------------------------------------ health

export async function recordHealth(probeId: string, target: string, status: string,
  o: { reading?: string | null; detail?: unknown; ts?: number } = {}, q?: Queryable): Promise<number> {
  return (await insert('health_readings', { ts: o.ts ?? nowMs(), probe_id: probeId, target, status, reading: o.reading ?? null,
    detail_json: o.detail === undefined ? null : o.detail }, q)).id
}

/** the newest reading of every probe (optionally one target kind), ordered by probe_id */
export async function latestHealth(o: { target?: string } = {}, q?: Queryable): Promise<R<'health_readings'>[]> {
  const a: unknown[] = []
  let w = ''
  if (o.target !== undefined) { a.push(o.target); w = ' WHERE target = $1' }
  return query(`SELECT DISTINCT ON (probe_id) ${cols('health_readings')} FROM ops.health_readings${w} ORDER BY probe_id, ts DESC, id DESC`, a, q)
}

/** newest first */
export async function healthHistory(probeId: string, o: { since?: number; limit?: number } = {}, q?: Queryable): Promise<R<'health_readings'>[]> {
  return query(`SELECT ${cols('health_readings')} FROM ops.health_readings WHERE probe_id = $1 AND ts >= $2 ORDER BY ts DESC, id DESC LIMIT $3`,
    [probeId, o.since ?? 0, o.limit ?? 500], q)
}

/** delete readings older than `before` (ms), by default keeping each probe's newest one */
export async function pruneHealth(before: number, o: { keepLatest?: boolean } = {}, q?: Queryable): Promise<number> {
  if (o.keepLatest === false) return exec('DELETE FROM ops.health_readings WHERE ts < $1', [before], q)
  return exec('DELETE FROM ops.health_readings h WHERE ts < $1 AND id <> (SELECT x.id FROM ops.health_readings x ' +
    'WHERE x.probe_id = h.probe_id ORDER BY x.ts DESC, x.id DESC LIMIT 1)', [before], q)
}

// --------------------------------------------------------------------------------------- scheduler

/** a job starting now: a 'running' row; returns its id */
export async function startJobRun(jobId: string, dueAt: number | null, o: { trigger?: string; startedAt?: number } = {}, q?: Queryable): Promise<number> {
  return (await insert('job_runs', { job_id: jobId, due_at: dueAt, started_at: o.startedAt ?? nowMs(), status: 'running',
    trigger: o.trigger ?? 'schedule' }, q)).id
}

/** a row that is not a start: missed / skipped decisions; returns its id */
export async function addJobRun(jobId: string, status: string,
  o: { dueAt?: number | null; startedAt?: number | null; endedAt?: number | null; detail?: string | null; trigger?: string } = {}, q?: Queryable): Promise<number> {
  return (await insert('job_runs', { job_id: jobId, status, due_at: o.dueAt ?? null, started_at: o.startedAt ?? null,
    ended_at: o.endedAt ?? null, detail: o.detail ?? null, trigger: o.trigger ?? 'schedule' }, q)).id
}

/** close a run; conversationId only overwrites when given */
export async function finishJobRun(id: number, status: string,
  o: { exitCode?: number | null; detail?: string | null; conversationId?: string | null; endedAt?: number } = {}, q?: Queryable): Promise<R<'job_runs'> | null> {
  return one(`UPDATE ops.job_runs SET status = $1, exit_code = $2, ended_at = $3, detail = $4, conversation_id = COALESCE($5, conversation_id) ` +
    `WHERE id = $6 RETURNING ${cols('job_runs')}`, [status, o.exitCode ?? null, o.endedAt ?? nowMs(), o.detail ?? null, o.conversationId ?? null, id], q)
}

export async function updateJobRun(id: number, fields: Partial<R<'job_runs'>>, q?: Queryable): Promise<R<'job_runs'> | null> {
  return update('job_runs', id, fields, q)
}

export async function getJobRun(id: number, q?: Queryable): Promise<R<'job_runs'> | null> { return get('job_runs', id, q) }

/** newest first by COALESCE(started_at, ended_at, due_at) */
export async function listJobRuns(o: { jobId?: string; limit?: number } = {}, q?: Queryable): Promise<R<'job_runs'>[]> {
  const order = 'ORDER BY COALESCE(started_at, ended_at, due_at) DESC NULLS LAST, id DESC'
  if (o.jobId === undefined) return query(`SELECT ${cols('job_runs')} FROM ops.job_runs ${order} LIMIT $1`, [o.limit ?? 50], q)
  return query(`SELECT ${cols('job_runs')} FROM ops.job_runs WHERE job_id = $1 ${order} LIMIT $2`, [o.jobId, o.limit ?? 50], q)
}

export async function runningJobRuns(q?: Queryable): Promise<R<'job_runs'>[]> {
  return select('job_runs', { where: { status: 'running' }, orderBy: 'id' }, q)
}

/** the newest row per job that says something (not a skip), else the newest row at all */
export async function latestJobRunPerJob(q?: Queryable): Promise<Map<string, R<'job_runs'>>> {
  const rows = await query<R<'job_runs'>>(`SELECT DISTINCT ON (job_id) ${cols('job_runs')} FROM ops.job_runs ORDER BY job_id, ` +
    "(status = 'skipped') ASC, COALESCE(started_at, ended_at, due_at) DESC NULLS LAST, id DESC", [], q)
  return new Map(rows.map(r => [r.job_id, r]))
}

/** the newest run of a job that actually STARTED (missed / skipped rows never started) */
export async function lastStartedJobRun(jobId: string, q?: Queryable): Promise<R<'job_runs'> | null> {
  return one(`SELECT ${cols('job_runs')} FROM ops.job_runs WHERE job_id = $1 AND started_at IS NOT NULL ORDER BY started_at DESC, id DESC LIMIT 1`, [jobId], q)
}

export async function lastDuePerJob(q?: Queryable): Promise<Map<string, number>> {
  const rows = await query<{ job_id: string; d: number }>('SELECT job_id, MAX(due_at) AS d FROM ops.job_runs WHERE due_at IS NOT NULL GROUP BY job_id', [], q)
  return new Map(rows.map(r => [r.job_id, r.d]))
}

export interface JobTally { ran: number; ok: number; failed: number; unknown: number; missed: number; skipped: number; running: number }

/** counts by status of rows that ended (or started) at or after `since`; ran = ok + fail + unknown */
export async function jobRunTally(since: number, q?: Queryable): Promise<JobTally> {
  const c: Record<string, number> = {}
  for (const r of await query<{ status: string; n: number }>('SELECT status, count(*)::bigint AS n FROM ops.job_runs ' +
    'WHERE COALESCE(ended_at, started_at) >= $1 GROUP BY status', [since], q)) c[r.status] = r.n
  const g = (k: string) => c[k] ?? 0
  return { ran: g('ok') + g('fail') + g('unknown'), ok: g('ok'), failed: g('fail'), unknown: g('unknown'), missed: g('missed'),
    skipped: g('skipped'), running: g('running') }
}

// --------------------------------------------------------------------------------------- processes

export async function addProcess(dashboardId: string, mode: string, cmd: string,
  o: { pid?: number | null; port?: number | null; logPath?: string | null; startedAt?: number } = {}, q?: Queryable): Promise<number> {
  return (await insert('processes', { dashboard_id: dashboardId, mode, cmd, pid: o.pid ?? null, port: o.port ?? null,
    log_path: o.logPath ?? null, started_at: o.startedAt ?? nowMs() }, q)).id
}

export async function closeProcess(id: number, o: { exitCode?: number | null; stoppedAt?: number } = {}, q?: Queryable): Promise<R<'processes'> | null> {
  return update('processes', id, { exit_code: o.exitCode ?? null, stopped_at: o.stoppedAt ?? nowMs() }, q)
}

export async function listProcesses(o: { dashboardId?: string; limit?: number } = {}, q?: Queryable): Promise<R<'processes'>[]> {
  return select('processes', { where: o.dashboardId ? { dashboard_id: o.dashboardId } : undefined, orderBy: ['-started_at', '-id'], limit: o.limit ?? 50 }, q)
}

export async function openProcesses(q?: Queryable): Promise<R<'processes'>[]> {
  return select('processes', { where: { stopped_at: null }, orderBy: ['-started_at', '-id'] }, q)
}

// ---------------------------------------------------------------------------------- reads, commits

export async function recordRead(agentId: string, bookPath: string,
  o: { conversationId?: string | null; atBoot?: boolean; ts?: number } = {}, q?: Queryable): Promise<number> {
  return (await insert('reads', { ts: o.ts ?? nowMs(), agent_id: agentId, conversation_id: o.conversationId ?? null,
    book_path: bookPath, at_boot: o.atBoot ?? false }, q)).id
}

/** newest first; pullsOnly = books pulled beyond boot */
export async function listReads(o: { agent?: string; bookPath?: string; since?: number; pullsOnly?: boolean; limit?: number } = {},
  q?: Queryable): Promise<R<'reads'>[]> {
  const w: string[] = []; const a: unknown[] = []
  if (o.agent !== undefined) { a.push(o.agent); w.push(`agent_id = $${a.length}`) }
  if (o.bookPath !== undefined) { a.push(o.bookPath); w.push(`book_path = $${a.length}`) }
  if (o.since !== undefined) { a.push(o.since); w.push(`ts >= $${a.length}`) }
  if (o.pullsOnly) w.push('NOT at_boot')
  a.push(o.limit ?? 500)
  return query(`SELECT ${cols('reads')} FROM ops.reads${w.length ? ' WHERE ' + w.join(' AND ') : ''} ORDER BY ts DESC, id DESC LIMIT $${a.length}`, a, q)
}

/** index one commit keyed (repo, sha); a re-index updates the other columns */
export async function upsertCommit(row: Partial<R<'commits'>> & Pick<R<'commits'>, 'repo' | 'sha'>, q?: Queryable): Promise<R<'commits'>> {
  return upsert('commits', row, {}, q)
}

export async function getCommit(repo: string, sha: string, q?: Queryable): Promise<R<'commits'> | null> { return get('commits', [repo, sha], q) }

/** newest first */
export async function listCommits(o: { repo?: string; since?: number; conversationId?: string; limit?: number } = {}, q?: Queryable): Promise<R<'commits'>[]> {
  const w: string[] = []; const a: unknown[] = []
  if (o.repo !== undefined) { a.push(o.repo); w.push(`repo = $${a.length}`) }
  if (o.conversationId !== undefined) { a.push(o.conversationId); w.push(`conversation_id = $${a.length}`) }
  if (o.since !== undefined) { a.push(o.since); w.push(`ts >= $${a.length}`) }
  a.push(o.limit ?? 200)
  return query(`SELECT ${cols('commits')} FROM ops.commits${w.length ? ' WHERE ' + w.join(' AND ') : ''} ORDER BY ts DESC, sha LIMIT $${a.length}`, a, q)
}

// -------------------------------------------------------------------------------------------- loop

export async function setMetric(day: string, agentId: string, metric: string, value: number, q?: Queryable): Promise<R<'loop_metrics'>> {
  return upsert('loop_metrics', { day, agent_id: agentId, metric, value }, {}, q)
}

/** oldest day first */
export async function listMetrics(o: { sinceDay?: string; agent?: string; metric?: string } = {}, q?: Queryable): Promise<R<'loop_metrics'>[]> {
  const a: unknown[] = [o.sinceDay ?? '']; const w = ['day >= $1']
  if (o.agent !== undefined) { a.push(o.agent); w.push(`agent_id = $${a.length}`) }
  if (o.metric !== undefined) { a.push(o.metric); w.push(`metric = $${a.length}`) }
  return query(`SELECT ${cols('loop_metrics')} FROM ops.loop_metrics WHERE ${w.join(' AND ')} ORDER BY day, agent_id, metric`, a, q)
}

export async function addLesson(agentId: string, text: string,
  o: { conversationId?: string | null; scope?: string; readWhen?: string | null; ts?: number } = {}, q?: Queryable): Promise<number> {
  return (await insert('loop_lessons', { ts: o.ts ?? nowMs(), agent_id: agentId, conversation_id: o.conversationId ?? null, text,
    scope: o.scope ?? 'agent', read_when: o.readWhen ?? null }, q)).id
}

export async function listLessons(o: { state?: string; agent?: string; limit?: number } = {}, q?: Queryable): Promise<R<'loop_lessons'>[]> {
  const where: Record<string, string> = {}
  if (o.state !== undefined) where.state = o.state
  if (o.agent !== undefined) where.agent_id = o.agent
  return select('loop_lessons', { where, orderBy: ['-ts', '-id'], limit: o.limit ?? 500 }, q)
}

export async function setLessonState(id: number, state: string, o: { proposal?: string } = {}, q?: Queryable): Promise<R<'loop_lessons'> | null> {
  return update('loop_lessons', id, o.proposal !== undefined ? { state, proposal: o.proposal } : { state }, q)
}

export async function addLoopPass(trigger: string, ok: boolean, summary: string, o: { detail?: unknown; ts?: number } = {}, q?: Queryable): Promise<number> {
  return (await insert('loop_passes', { ts: o.ts ?? nowMs(), trigger, ok, summary, detail_json: o.detail === undefined ? null : o.detail }, q)).id
}

export async function listLoopPasses(o: { limit?: number } = {}, q?: Queryable): Promise<R<'loop_passes'>[]> {
  return select('loop_passes', { orderBy: ['-ts', '-id'], limit: o.limit ?? 50 }, q)
}

/** keyed (conversation_id, turn_ix, source, key); graded_at defaults to now */
export async function upsertTurnGrade(row: Omit<R<'turn_grades'>, 'graded_at'> & { graded_at?: number }, q?: Queryable): Promise<R<'turn_grades'>> {
  return upsert('turn_grades', { graded_at: nowMs(), ...row }, {}, q)
}

/** oldest turn first */
export async function listTurnGrades(o: { conversationId?: string; since?: number; source?: string } = {}, q?: Queryable): Promise<R<'turn_grades'>[]> {
  const a: unknown[] = [o.since ?? 0]; const w = ['ts >= $1']
  if (o.conversationId !== undefined) { a.push(o.conversationId); w.push(`conversation_id = $${a.length}`) }
  if (o.source !== undefined) { a.push(o.source); w.push(`source = $${a.length}`) }
  return query(`SELECT ${cols('turn_grades')} FROM ops.turn_grades WHERE ${w.join(' AND ')} ORDER BY ts, conversation_id, turn_ix, source, key`, a, q)
}

/** keyed (conversation_id, turn_ix, reason); a re-queue never reopens a done item (state is written only on insert) */
export async function upsertReview(row: Partial<R<'review_queue'>> & Pick<R<'review_queue'>, 'conversation_id' | 'turn_ix' | 'reason'>, q?: Queryable): Promise<R<'review_queue'>> {
  const keep = new Set(['conversation_id', 'turn_ix', 'reason', 'state'])
  return upsert('review_queue', row, { update: Object.keys(row).filter(k => !keep.has(k)) }, q)
}

export async function listReview(o: { state?: string | null; limit?: number } = {}, q?: Queryable): Promise<R<'review_queue'>[]> {
  const state = o.state === undefined ? 'open' : o.state
  return select('review_queue', { where: state ? { state } : undefined, orderBy: ['-ts', 'conversation_id', 'turn_ix'], limit: o.limit ?? 200 }, q)
}

export async function setReviewState(conversationId: string, turnIx: number, reason: string, state: string, q?: Queryable): Promise<R<'review_queue'> | null> {
  return update('review_queue', [conversationId, turnIx, reason], { state }, q)
}

// --------------------------------------------------------------------------------------- law loads

/** {conversation_id, agent_id, file_path, load_reason, ...}; ts defaults to now */
export async function addLawLoad(row: Omit<Partial<R<'law_loads'>>, 'id'> & Pick<R<'law_loads'>, 'conversation_id' | 'agent_id' | 'file_path' | 'load_reason'>,
  q?: Queryable): Promise<number> {
  return (await insert('law_loads', { ts: nowMs(), ...row }, q)).id
}

export async function listLawLoads(conversationId: string, q?: Queryable): Promise<R<'law_loads'>[]> {
  return select('law_loads', { where: { conversation_id: conversationId }, orderBy: ['ts', 'id'] }, q)
}

// ------------------------------------------------------------------------------------------- board

export async function attestBoard(id: string, fp: string, via: string, o: { ts?: number } = {}, q?: Queryable): Promise<R<'board_attest'>> {
  return upsert('board_attest', { id, fp, via, ts: o.ts ?? nowMs() }, {}, q)
}

export async function getBoardAttest(id: string, q?: Queryable): Promise<R<'board_attest'> | null> { return get('board_attest', id, q) }

export async function dropBoardAttest(id: string, q?: Queryable): Promise<number> { return del('board_attest', id, q) }

type Suggestion = Omit<R<'board_suggested'>, 'first_seen' | 'last_seen'> & { first_seen?: number }

/** make board_suggested exactly `rows` (one scan's findings), keeping first_seen for a fingerprint
 *  seen before and setting last_seen = ts; atomic; returns the row count */
export async function syncBoardSuggestions(rows: Suggestion[], o: { ts?: number } = {}, q?: Queryable): Promise<number> {
  const t = o.ts ?? nowMs()
  return transaction(async c => {
    await c.query('DELETE FROM ops.board_suggested WHERE NOT (fp = ANY($1))', [rows.map(r => r.fp)])
    for (const r of rows) {
      const full = { ...r, first_seen: r.first_seen ?? t, last_seen: t }
      await upsert('board_suggested', full, { update: Object.keys(full).filter(k => k !== 'fp' && k !== 'first_seen') }, c)
    }
    return rows.length
  }, q)
}

export async function listBoardSuggestions(q?: Queryable): Promise<R<'board_suggested'>[]> {
  return select('board_suggested', { orderBy: ['-last_seen', 'fp'] }, q)
}

export async function markSuggestionDone(fp: string, state: string, o: { item?: string | null; title?: string | null; ts?: number } = {},
  q?: Queryable): Promise<R<'board_suggested_done'>> {
  return upsert('board_suggested_done', { fp, state, item: o.item ?? null, title: o.title ?? null, ts: o.ts ?? nowMs() }, {}, q)
}

export async function listSuggestionsDone(q?: Queryable): Promise<R<'board_suggested_done'>[]> {
  return select('board_suggested_done', { orderBy: ['-ts', 'fp'] }, q)
}

/** the one last-scan row (id is always 1) */
export async function setBoardScan(row: Omit<R<'board_scan'>, 'id'>, q?: Queryable): Promise<R<'board_scan'>> {
  return upsert('board_scan', { ...row, id: 1 }, {}, q)
}

export async function getBoardScan(q?: Queryable): Promise<R<'board_scan'> | null> { return get('board_scan', 1, q) }

// ------------------------------------------------------------------------------------------ alerts

/** one burn alert; only the newest `keep` (default 20) rows are kept */
export async function addSpendAlert(agent: string, billable: number, median: number,
  o: { multiple?: number | null; ts?: number; keep?: number } = {}, q?: Queryable): Promise<number> {
  return transaction(async c => {
    const id = (await insert('spend_alerts', { ts: o.ts ?? nowMs(), agent, billable, median, multiple: o.multiple ?? null }, c)).id
    await c.query('DELETE FROM ops.spend_alerts WHERE id NOT IN (SELECT id FROM ops.spend_alerts ORDER BY ts DESC, id DESC LIMIT $1)', [o.keep ?? 20])
    return id
  }, q)
}

export async function listSpendAlerts(o: { limit?: number } = {}, q?: Queryable): Promise<R<'spend_alerts'>[]> {
  return select('spend_alerts', { orderBy: ['-ts', '-id'], limit: o.limit ?? 20 }, q)
}

/** create or replace a rule by id; created defaults to now on first save */
export async function saveAlertRule(row: Partial<R<'alert_rules'>> & Pick<R<'alert_rules'>, 'id'>, q?: Queryable): Promise<R<'alert_rules'>> {
  return upsert('alert_rules', { created: nowMs(), ...row }, { update: Object.keys(row).filter(k => k !== 'id' && k !== 'created') }, q)
}

export async function getAlertRule(id: string, q?: Queryable): Promise<R<'alert_rules'> | null> { return get('alert_rules', id, q) }

export async function listAlertRules(q?: Queryable): Promise<R<'alert_rules'>[]> { return select('alert_rules', { orderBy: ['created', 'id'] }, q) }

export async function deleteAlertRule(id: string, q?: Queryable): Promise<number> { return del('alert_rules', id, q) }

export async function markAlertFired(id: string, o: { ts?: number } = {}, q?: Queryable): Promise<R<'alert_rules'> | null> {
  return update('alert_rules', id, { last_fired: o.ts ?? nowMs() }, q)
}

/** one line per (rule, subject, bar), ever: false when that bar was already logged */
export async function logAlert(rule: string, subject: string, bar: number, delivered: string, channel: string,
  o: { value?: number | null; detail?: string | null; at?: number } = {}, q?: Queryable): Promise<boolean> {
  return (await exec('INSERT INTO ops.alert_log (at, rule, subject, value, bar, delivered, channel, detail) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ' +
    'ON CONFLICT (rule, subject, bar) DO NOTHING', [o.at ?? nowMs(), rule, subject, o.value ?? null, bar, delivered, channel, o.detail ?? null], q)) === 1
}

export async function listAlertLog(o: { since?: number; rule?: string; limit?: number } = {}, q?: Queryable): Promise<R<'alert_log'>[]> {
  const a: unknown[] = [o.since ?? 0]; const w = ['at >= $1']
  if (o.rule !== undefined) { a.push(o.rule); w.push(`rule = $${a.length}`) }
  a.push(o.limit ?? 500)
  return query(`SELECT ${cols('alert_log')} FROM ops.alert_log WHERE ${w.join(' AND ')} ORDER BY at DESC, id DESC LIMIT $${a.length}`, a, q)
}

export async function addAlertPass(bar: number, bars: string, rules: number, rows: number,
  o: { error?: string | null; forced?: boolean; at?: number } = {}, q?: Queryable): Promise<number> {
  return (await insert('alert_passes', { at: o.at ?? nowMs(), bar, bars, rules, rows, error: o.error ?? null, forced: o.forced ?? false }, q)).id
}

export async function listAlertPasses(o: { since?: number; limit?: number } = {}, q?: Queryable): Promise<R<'alert_passes'>[]> {
  return query(`SELECT ${cols('alert_passes')} FROM ops.alert_passes WHERE at >= $1 ORDER BY at DESC, id DESC LIMIT $2`, [o.since ?? 0, o.limit ?? 500], q)
}

// ---------------------------------------------------------------------------------- library drafts

type DraftIn = Omit<Partial<R<'library_drafts'>>, 'id'> &
  Pick<R<'library_drafts'>, 'conv' | 'agent' | 'shelf' | 'path' | 'book' | 'series_row' | 'quote' | 'key'>

/** one draft per correction (unique key): the new id, or null when the key exists */
export async function addLibraryDraft(row: DraftIn, q?: Queryable): Promise<number | null> {
  const r: Record<string, unknown> = { ts: nowMs(), ...row }
  const v = adapt('library_drafts', r)
  const cs = checkCols('library_drafts', Object.keys(v), true)
  const got = await one<{ id: number }>(`INSERT INTO ops.library_drafts (${cs.map(qi).join(', ')}) VALUES (${cs.map((_, i) => '$' + (i + 1)).join(', ')}) ` +
    'ON CONFLICT (key) DO NOTHING RETURNING id', cs.map(c => v[c]), q)
  return got ? got.id : null
}

export async function listLibraryDrafts(o: { state?: string; limit?: number } = {}, q?: Queryable): Promise<R<'library_drafts'>[]> {
  return select('library_drafts', { where: o.state ? { state: o.state } : undefined, orderBy: ['-ts', '-id'], limit: o.limit ?? 200 }, q)
}

export async function updateLibraryDraft(id: number, fields: Partial<R<'library_drafts'>>, q?: Queryable): Promise<R<'library_drafts'> | null> {
  return update('library_drafts', id, { updated: nowMs(), ...fields }, q)
}

export async function setDraftScan(conv: string, lastAt: number,
  o: { found?: number; costUsd?: number; note?: string | null; ts?: number } = {}, q?: Queryable): Promise<R<'library_draft_scans'>> {
  return upsert('library_draft_scans', { conv, last_at: lastAt, ts: o.ts ?? nowMs(), found: o.found ?? 0, cost_usd: o.costUsd ?? 0,
    note: o.note ?? null }, {}, q)
}

export async function getDraftScan(conv: string, q?: Queryable): Promise<R<'library_draft_scans'> | null> { return get('library_draft_scans', conv, q) }

export async function setBookMark(path: string, o: { state?: string; n?: number; note?: string | null; boot?: unknown; ts?: number } = {},
  q?: Queryable): Promise<R<'book_marks'>> {
  return upsert('book_marks', { path, state: o.state ?? 'cold', n: o.n ?? 0, ts: o.ts ?? nowMs(), note: o.note ?? null,
    boot_json: o.boot === undefined ? null : o.boot }, {}, q)
}

export async function getBookMark(path: string, q?: Queryable): Promise<R<'book_marks'> | null> { return get('book_marks', path, q) }

export async function listBookMarks(o: { state?: string } = {}, q?: Queryable): Promise<R<'book_marks'>[]> {
  return select('book_marks', { where: o.state ? { state: o.state } : undefined, orderBy: 'path' }, q)
}

export async function dropBookMark(path: string, q?: Queryable): Promise<number> { return del('book_marks', path, q) }

// --------------------------------------------------------------------------------- lab comparators

/** append-only: a pull never rewrites an earlier row; returns seq */
export async function addComparatorSnapshot(id: string, status: string, series: unknown, src: string,
  o: { readAt?: string | null; ts?: number } = {}, q?: Queryable): Promise<number> {
  return (await insert('comparator_snapshots', { id, ts: o.ts ?? nowMs(), status, series, src, read_at: o.readAt ?? null }, q)).seq
}

export async function latestComparatorSnapshots(q?: Queryable): Promise<Map<string, R<'comparator_snapshots'>>> {
  const rows = await query<R<'comparator_snapshots'>>(`SELECT DISTINCT ON (id) ${cols('comparator_snapshots')} FROM ops.comparator_snapshots ` +
    'ORDER BY id, ts DESC, seq DESC', [], q)
  return new Map(rows.map(r => [r.id, r]))
}

export async function comparatorHistory(id: string, o: { limit?: number } = {}, q?: Queryable): Promise<R<'comparator_snapshots'>[]> {
  return select('comparator_snapshots', { where: { id }, orderBy: ['-ts', '-seq'], limit: o.limit ?? 100 }, q)
}

// -------------------------------------------------------------------------------------------- chat

const normTags = (tags: Iterable<string>): string[] => [...new Set([...tags].map(t => t.toLowerCase()))].sort()

export async function createPrompt(body: string, o: { title?: string; tags?: string[]; ts?: number } = {}, q?: Queryable): Promise<R<'chat_prompts'>> {
  const t = o.ts ?? nowMs()
  return insert('chat_prompts', { title: o.title ?? '', body, tags: normTags(o.tags ?? []), created: t, updated: t }, q)
}

export async function updatePrompt(id: number, fields: { title?: string; body?: string; tags?: string[] }, q?: Queryable): Promise<R<'chat_prompts'> | null> {
  const f: Partial<R<'chat_prompts'>> = { ...fields, updated: nowMs() }
  if (fields.tags) f.tags = normTags(fields.tags)
  return update('chat_prompts', id, f, q)
}

export async function deletePrompt(id: number, q?: Queryable): Promise<number> { return del('chat_prompts', id, q) }

export async function listPrompts(q?: Queryable): Promise<R<'chat_prompts'>[]> { return select('chat_prompts', { orderBy: ['-updated', '-id'] }, q) }

export async function setChatVerify(repo: string, code: number | null, last: string, ms: number, fingerprint: string,
  o: { timedOut?: boolean; ts?: number } = {}, q?: Queryable): Promise<R<'chat_verify'>> {
  return upsert('chat_verify', { repo, code, last, ms, ts: o.ts ?? nowMs(), timed_out: o.timedOut ?? false, fingerprint }, {}, q)
}

export async function getChatVerify(repo: string, q?: Queryable): Promise<R<'chat_verify'> | null> { return get('chat_verify', repo, q) }

export async function listChatVerify(q?: Queryable): Promise<R<'chat_verify'>[]> { return select('chat_verify', { orderBy: 'repo' }, q) }

// =================================================================================================
// READ MODELS the cockpit asks for (each one query the cockpit used to spell itself), and the
// platform's logs (migration ops/002). Names mirror fund_db.ops one for one; a python dict comes
// back as a Map, a python set as a Set.
// =================================================================================================


// ------------------------------------------------------------------------------------ events (reads)

/** events with since <= ts < until, oldest first (ts, id) */
export async function eventsInWindow(since: number, until: number, o: { kinds?: string[]; agentOnly?: boolean } = {},
  q?: Queryable): Promise<R<'events'>[]> {
  const a: unknown[] = [since, until]; const w = ['ts >= $1', 'ts < $2']
  if (o.kinds?.length) { a.push(o.kinds); w.push(`kind = ANY($${a.length})`) }
  if (o.agentOnly) w.push('agent_id IS NOT NULL')
  return query(`SELECT ${cols('events')} FROM ops.events WHERE ${w.join(' AND ')} ORDER BY ts, id`, a, q)
}

export type TurnEvent = { ts: number; summary: string; agent_id: string | null; conversation_id: string }

/** the 'turn' events of one conversation (ts, id), or of every conversation (conversation, ts, id) */
export async function turnEvents(o: { conversation?: string } = {}, q?: Queryable): Promise<TurnEvent[]> {
  return o.conversation !== undefined
    ? query("SELECT ts, summary, agent_id, conversation_id FROM ops.events WHERE kind = 'turn' AND conversation_id = $1 ORDER BY ts, id", [o.conversation], q)
    : query("SELECT ts, summary, agent_id, conversation_id FROM ops.events WHERE kind = 'turn' AND conversation_id IS NOT NULL ORDER BY conversation_id, ts, id", [], q)
}

/** one conversation's events of `kind` with after < ts <= through (a turn's own span) */
export async function turnWindowEvents(conversation: string, kind: string, after: number, through: number, q?: Queryable): Promise<R<'events'>[]> {
  return query(`SELECT ${cols('events')} FROM ops.events WHERE kind = $1 AND conversation_id = $2 AND ts > $3 AND ts <= $4 ORDER BY ts, id`,
    [kind, conversation, after, through], q)
}

/** the newest ts of an event of `kind` whose payload carries payloadKey = payloadValue */
export async function lastEventTs(kind: string, payloadKey: string, payloadValue: string, q?: Queryable): Promise<number | null> {
  return (await one<{ ts: number | null }>('SELECT MAX(ts) AS ts FROM ops.events WHERE kind = $1 AND payload_json->>$2 = $3',
    [kind, payloadKey, payloadValue], q))?.ts ?? null
}

/** conversations with an event whose summary starts 'reverted ' */
export async function revertedConversations(q?: Queryable): Promise<string[]> {
  return (await query<{ id: string }>("SELECT DISTINCT conversation_id AS id FROM ops.events WHERE conversation_id IS NOT NULL AND summary LIKE 'reverted %' ORDER BY 1",
    [], q)).map(r => r.id)
}

export async function errorCountsByConversation(q?: Queryable): Promise<Map<string, number>> {
  return new Map((await query<{ id: string; n: number }>("SELECT conversation_id AS id, count(*)::int AS n FROM ops.events " +
    "WHERE kind = 'error' AND conversation_id IS NOT NULL GROUP BY 1", [], q)).map(r => [r.id, r.n]))
}

// ----------------------------------------------------------------------------- conversations (reads)

/** bump last_at; set the title only while it is still blank */
export async function touchConversation(id: string, o: { ts?: number; title?: string } = {}, q?: Queryable): Promise<number> {
  return exec("UPDATE ops.conversations SET last_at = $1, title = CASE WHEN title = '' THEN $2 ELSE title END WHERE id = $3",
    [o.ts ?? nowMs(), o.title ?? '', id], q)
}

/** one conversation not yet indexed (not forgotten, with a transcript and a cwd) */
export async function nextUnindexedConversation(q?: Queryable): Promise<{ id: string; cwd: string; transcript_uuid: string } | null> {
  return one('SELECT id, cwd, transcript_uuid FROM ops.conversations WHERE NOT indexed AND NOT forgotten AND transcript_uuid IS NOT NULL ' +
    'AND cwd IS NOT NULL ORDER BY last_at DESC, id LIMIT 1', [], q)
}

/** agent_id -> conversations not forgotten */
export async function conversationCounts(q?: Queryable): Promise<Map<string, number>> {
  return new Map((await query<{ a: string; n: number }>('SELECT agent_id AS a, count(*)::int AS n FROM ops.conversations WHERE NOT forgotten GROUP BY agent_id',
    [], q)).map(r => [r.a, r.n]))
}

/** every conversation id, forgotten ones included */
export async function listConversationIds(q?: Queryable): Promise<string[]> {
  return (await query<{ id: string }>('SELECT id FROM ops.conversations ORDER BY id', [], q)).map(r => r.id)
}

export type DraftCandidate = { id: string; agent_id: string; last_at: number; state: string }

/** idle or closed, not forgotten, last moved in (since, quietBefore), not scanned since it last moved; newest first */
export async function conversationsDueForDraftScan(quietBefore: number, since: number, o: { limit?: number } = {}, q?: Queryable): Promise<DraftCandidate[]> {
  return query(`SELECT c.id, c.agent_id, c.last_at, c.state FROM ops.conversations c
    LEFT JOIN ops.library_draft_scans s ON s.conv = c.id
    WHERE NOT c.forgotten AND c.state IN ('idle', 'closed') AND c.last_at < $1 AND c.last_at > $2
      AND (s.conv IS NULL OR s.last_at < c.last_at)
    ORDER BY c.last_at DESC LIMIT $3`, [quietBefore, since, o.limit ?? 20], q)
}

// ---------------------------------------------------------------------------------- messages (reads)

/** the search words of a typed query: each run of letters, digits and _, lower-cased, unique, at
 *  most 16. Nothing the owner types can become tsquery syntax. */
export function prefixWords(text: string): string[] {
  return [...new Set(String(text).toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [])].slice(0, 16)
}

/** messages matching EVERY word of `text` as a prefix, newest first; no word at all -> [] */
export async function searchMessagesPrefix(text: string, o: { limit?: number } = {}, q?: Queryable): Promise<{ conversation_id: string; snippet: string }[]> {
  const words = prefixWords(text)
  if (!words.length) return []
  return query("SELECT conversation_id, ts_headline('simple', text, x, 'MaxWords=10, MinWords=4, StartSel=\"\", StopSel=\"\", " +
    "FragmentDelimiter=\"...\"') AS snippet FROM ops.messages, to_tsquery('simple', $1) x WHERE tsv @@ x ORDER BY ts DESC LIMIT $2",
    [words.map(w => `${w}:*`).join(' & '), o.limit ?? 400], q)
}

/** the assistant messages of one conversation with after < ts <= through, in order */
export async function assistantText(conversationId: string, after: number, through: number, q?: Queryable): Promise<string[]> {
  return (await query<{ text: string }>("SELECT text FROM ops.messages WHERE conversation_id = $1 AND role = 'assistant' AND ts > $2 AND ts <= $3 ORDER BY ts, id",
    [conversationId, after, through], q)).map(r => r.text)
}

// ---------------------------------------------------------------------------------- presence (write)

export async function heartbeatPresence(handIds: string[], o: { ts?: number } = {}, q?: Queryable): Promise<number> {
  if (!handIds.length) return 0
  return exec('UPDATE ops.presence SET heartbeat_at = $1 WHERE hand_id = ANY($2)', [o.ts ?? nowMs(), handIds], q)
}

// ------------------------------------------------------------------------------------- reads (pulls)
// A PULL is a read that was not made at boot (at_boot false).

/** record a pull unless the same agent pulled the same book in the same conversation within dedupeMs */
export async function recordReadOnce(agentId: string, bookPath: string,
  o: { conversationId?: string | null; ts?: number; dedupeMs?: number } = {}, q?: Queryable): Promise<boolean> {
  const t = o.ts ?? nowMs(); const conv = o.conversationId ?? null
  const dup = await one('SELECT 1 AS x FROM ops.reads WHERE book_path = $1 AND agent_id = $2 AND NOT at_boot AND ts > $3 ' +
    'AND conversation_id IS NOT DISTINCT FROM $4 LIMIT 1', [bookPath, agentId, t - (o.dedupeMs ?? 60_000), conv], q)
  if (dup) return false
  await recordRead(agentId, bookPath, { conversationId: conv, atBoot: false, ts: t }, q)
  return true
}

/** book_path -> pulls in one conversation */
export async function countReadsByBook(conversationId: string, q?: Queryable): Promise<Map<string, number>> {
  return new Map((await query<{ p: string; n: number }>('SELECT book_path AS p, count(*)::int AS n FROM ops.reads WHERE conversation_id = $1 ' +
    'AND NOT at_boot GROUP BY book_path', [conversationId], q)).map(r => [r.p, r.n]))
}

/** the books pulled in one conversation, most recently pulled first */
export async function booksReadInConversation(conversationId: string, q?: Queryable): Promise<string[]> {
  return (await query<{ p: string }>('SELECT book_path AS p, MAX(ts) AS t FROM ops.reads WHERE conversation_id = $1 AND NOT at_boot ' +
    'GROUP BY book_path ORDER BY t DESC, book_path', [conversationId], q)).map(r => r.p)
}

/** the oldest pull's ts (or null) and how many pulls */
export async function pullLedgerSpan(q?: Queryable): Promise<{ first: number | null; n: number }> {
  const r = await one<{ first: number | null; n: number }>('SELECT MIN(ts) AS first, count(*)::int AS n FROM ops.reads WHERE NOT at_boot', [], q)
  return { first: r?.first ?? null, n: r?.n ?? 0 }
}

/** every book ever pulled, sorted */
export async function pulledBooks(q?: Queryable): Promise<string[]> {
  return (await query<{ p: string }>('SELECT DISTINCT book_path AS p FROM ops.reads WHERE NOT at_boot ORDER BY 1', [], q)).map(r => r.p)
}

/** per (book_path, at_boot): n_since (reads with ts > since) and last (newest ts) */
export async function readStatsByBook(since: number, q?: Queryable): Promise<{ book_path: string; at_boot: boolean; n_since: number; last: number }[]> {
  return query('SELECT book_path, at_boot, count(*) FILTER (WHERE ts > $1)::int AS n_since, MAX(ts) AS last FROM ops.reads ' +
    'GROUP BY book_path, at_boot ORDER BY book_path, at_boot', [since], q)
}

/** per (book_path, agent_id): pulls with ts > since, most first */
export async function pullersByBook(since: number, q?: Queryable): Promise<{ book_path: string; agent_id: string; n: number }[]> {
  return query('SELECT book_path, agent_id, count(*)::int AS n FROM ops.reads WHERE NOT at_boot AND ts > $1 ' +
    'GROUP BY book_path, agent_id ORDER BY n DESC, agent_id, book_path', [since], q)
}

/** per (agent_id, book_path): pulls with ts > since and the newest ts, most recent first */
export async function pullsByAgent(since: number, q?: Queryable): Promise<{ agent_id: string; book_path: string; n: number; last: number }[]> {
  return query('SELECT agent_id, book_path, count(*)::int AS n, MAX(ts) AS last FROM ops.reads WHERE NOT at_boot AND ts > $1 ' +
    'GROUP BY agent_id, book_path ORDER BY last DESC, agent_id, book_path', [since], q)
}

/** every pull made in a conversation, ordered by book, conversation, ts */
export async function listPulls(q?: Queryable): Promise<{ book_path: string; conversation_id: string; ts: number }[]> {
  return query('SELECT book_path, conversation_id, ts FROM ops.reads WHERE NOT at_boot AND conversation_id IS NOT NULL ' +
    'ORDER BY book_path, conversation_id, ts, id', [], q)
}

export async function conversationsWithPulls(q?: Queryable): Promise<string[]> {
  return (await query<{ id: string }>('SELECT DISTINCT conversation_id AS id FROM ops.reads WHERE NOT at_boot AND conversation_id IS NOT NULL ORDER BY 1',
    [], q)).map(r => r.id)
}

// ----------------------------------------------------------------------------------- commits (reads)

export type CommitSubject = { repo: string; sha: string; ts: number; subject: string; conversation_id: string | null; loop_change: string | null }

/** every indexed commit, oldest first */
export async function commitSubjects(q?: Queryable): Promise<CommitSubject[]> {
  return query('SELECT repo, sha, ts, subject, conversation_id, loop_change FROM ops.commits ORDER BY ts, repo, sha', [], q)
}

/** files_json of one conversation's commits with after < ts <= through */
export async function commitFiles(conversationId: string, after: number, through: number, q?: Queryable): Promise<unknown[]> {
  return (await query<{ files_json: unknown }>('SELECT files_json FROM ops.commits WHERE conversation_id = $1 AND ts > $2 AND ts <= $3 ORDER BY ts, sha',
    [conversationId, after, through], q)).map(r => r.files_json)
}

export async function knownCommits(repo: string, shas: string[], q?: Queryable): Promise<Set<string>> {
  if (!shas.length) return new Set()
  return new Set((await query<{ sha: string }>('SELECT sha FROM ops.commits WHERE repo = $1 AND sha = ANY($2)', [repo, shas], q)).map(r => r.sha))
}

/** sha -> shrink_json for the named commits that carry one */
export async function commitShrinks(repo: string, shas: string[], q?: Queryable): Promise<Map<string, unknown>> {
  if (!shas.length) return new Map()
  return new Map((await query<{ sha: string; shrink_json: unknown }>('SELECT sha, shrink_json FROM ops.commits WHERE repo = $1 ' +
    'AND shrink_json IS NOT NULL AND sha = ANY($2)', [repo, shas], q)).map(r => [r.sha, r.shrink_json]))
}

// --------------------------------------------------------------------------------------- loop (more)

/** lessons with ts >= since, newest first */
export async function lessonsSince(o: { since?: number; limit?: number } = {}, q?: Queryable): Promise<R<'loop_lessons'>[]> {
  return query(`SELECT ${cols('loop_lessons')} FROM ops.loop_lessons WHERE ts >= $1 ORDER BY ts DESC, id DESC LIMIT $2`, [o.since ?? 0, o.limit ?? 500], q)
}

/** delete every loop_metrics row with day >= fromDay (a recompute rewrites them) */
export async function clearMetrics(fromDay: string, q?: Queryable): Promise<number> {
  return exec('DELETE FROM ops.loop_metrics WHERE day >= $1', [fromDay], q)
}

/** loop_metrics rows with fromDay <= day <= toDay, oldest day first */
export async function metricsBetween(fromDay: string, toDay: string, q?: Queryable): Promise<R<'loop_metrics'>[]> {
  return query(`SELECT ${cols('loop_metrics')} FROM ops.loop_metrics WHERE day >= $1 AND day <= $2 ORDER BY day, agent_id, metric`, [fromDay, toDay], q)
}

/** usage rows with since <= ts < until, oldest first */
export async function usageInWindow(since: number, until: number, q?: Queryable): Promise<R<'usage'>[]> {
  return query(`SELECT ${cols('usage')} FROM ops.usage WHERE ts >= $1 AND ts < $2 ORDER BY ts, id`, [since, until], q)
}

/** turn_grades of one source with since <= ts < until, oldest first */
export async function gradesInWindow(source: string, since: number, until: number, q?: Queryable): Promise<R<'turn_grades'>[]> {
  return query(`SELECT ${cols('turn_grades')} FROM ops.turn_grades WHERE source = $1 AND ts >= $2 AND ts < $3 ORDER BY ts, conversation_id, turn_ix, key`,
    [source, since, until], q)
}

/** distinct (conversation_id, turn_ix) that carry a grade from `source` */
export async function gradedTurns(source: string, q?: Queryable): Promise<{ conversation_id: string; turn_ix: number }[]> {
  return query('SELECT DISTINCT conversation_id, turn_ix FROM ops.turn_grades WHERE source = $1 ORDER BY conversation_id, turn_ix', [source], q)
}

/** the whole review queue, every state: newest first, then conversation, turn, reason */
export async function listReviewAll(q?: Queryable): Promise<R<'review_queue'>[]> {
  return query(`SELECT ${cols('review_queue')} FROM ops.review_queue ORDER BY ts DESC, conversation_id, turn_ix, reason`, [], q)
}

/** set the state of every review item (every reason) of one turn */
export async function setReviewStateAll(conversationId: string, turnIx: number, state: string, q?: Queryable): Promise<number> {
  return exec('UPDATE ops.review_queue SET state = $1 WHERE conversation_id = $2 AND turn_ix = $3', [state, conversationId, turnIx], q)
}

/** take the owner's grade off one turn and reopen its review items, in one transaction; returns the grade rows removed */
export async function clearOwnerGrade(conversationId: string, turnIx: number, q?: Queryable): Promise<number> {
  return transaction(async c => {
    const n = await exec("DELETE FROM ops.turn_grades WHERE conversation_id = $1 AND turn_ix = $2 AND source = 'owner'", [conversationId, turnIx], c)
    await exec("UPDATE ops.review_queue SET state = 'open' WHERE conversation_id = $1 AND turn_ix = $2", [conversationId, turnIx], c)
    return n
  }, q)
}

// ------------------------------------------------------------------------------------- board (reads)

export async function listBoardAttest(q?: Queryable): Promise<R<'board_attest'>[]> {
  return select('board_attest', { orderBy: 'id' }, q)
}

export type OpenSuggestion = Pick<R<'board_suggested'>, 'fp' | 'source' | 'kind' | 'path' | 'line' | 'ref' | 'quote' | 'title' | 'owner' | 'first_seen' | 'last_seen'>

/** suggestions not marked done, ordered by source, path, line (nulls first), title */
export async function listOpenBoardSuggestions(q?: Queryable): Promise<OpenSuggestion[]> {
  return query(`SELECT s.fp, s.source, s.kind, s.path, s.line, s.ref, s.quote, s.title, s.owner, s.first_seen, s.last_seen
    FROM ops.board_suggested s LEFT JOIN ops.board_suggested_done d ON d.fp = s.fp
    WHERE d.fp IS NULL ORDER BY s.source, s.path, s.line NULLS FIRST, s.title`, [], q)
}

// ------------------------------------------------------------------------------------ alerts (reads)

/** (rule, subject, bar) already logged for the named rules and bars */
export async function alertLogKeys(rules: string[], bars: number[], q?: Queryable): Promise<{ rule: string; subject: string; bar: number }[]> {
  if (!rules.length || !bars.length) return []
  return query('SELECT rule, subject, bar FROM ops.alert_log WHERE rule = ANY($1) AND bar = ANY($2) ORDER BY rule, subject, bar', [rules, bars], q)
}

/** rule -> deliveries attempted (ok or fail) with at >= since */
export async function alertDeliveredCounts(rules: string[], since: number, q?: Queryable): Promise<Map<string, number>> {
  if (!rules.length) return new Map()
  return new Map((await query<{ rule: string; n: number }>("SELECT rule, count(*)::int AS n FROM ops.alert_log WHERE rule = ANY($1) AND at >= $2 " +
    "AND delivered IN ('ok', 'fail') GROUP BY rule", [rules, since], q)).map(r => [r.rule, r.n]))
}

export async function pruneAlertPasses(before: number, q?: Queryable): Promise<number> {
  return exec('DELETE FROM ops.alert_passes WHERE at < $1', [before], q)
}

export async function firstAlertPass(q?: Queryable): Promise<number | null> {
  return (await one<{ t: number | null }>('SELECT MIN(at) AS t FROM ops.alert_passes', [], q))?.t ?? null
}

// ---------------------------------------------------------------------------- library drafts (more)

/** record a scan of one conversation: last_at, ts and note are replaced, found and cost_usd ADD */
export async function bumpDraftScan(conv: string, lastAt: number,
  o: { found?: number; costUsd?: number; note?: string | null; ts?: number } = {}, q?: Queryable): Promise<R<'library_draft_scans'>> {
  return (await one<R<'library_draft_scans'>>(`INSERT INTO ops.library_draft_scans (conv, last_at, ts, found, cost_usd, note) VALUES ($1, $2, $3, $4, $5, $6)
    ON CONFLICT (conv) DO UPDATE SET last_at = EXCLUDED.last_at, ts = EXCLUDED.ts, found = ops.library_draft_scans.found + EXCLUDED.found,
      cost_usd = ops.library_draft_scans.cost_usd + EXCLUDED.cost_usd, note = EXCLUDED.note RETURNING ${cols('library_draft_scans')}`,
  [conv, lastAt, o.ts ?? nowMs(), o.found ?? 0, o.costUsd ?? 0, o.note ?? null], q))!
}

export async function libraryDraftExists(key: string, q?: Queryable): Promise<boolean> {
  return (await one('SELECT 1 AS x FROM ops.library_drafts WHERE key = $1', [key], q)) !== null
}

export async function libraryDraftTally(q?: Queryable): Promise<{ saved: number; dismissed: number; last_scan_ts: number | null }> {
  const t = await one<{ saved: number; dismissed: number }>("SELECT count(*) FILTER (WHERE state = 'saved')::int AS saved, " +
    "count(*) FILTER (WHERE state = 'dismissed')::int AS dismissed FROM ops.library_drafts", [], q)
  const s = await one<{ ts: number | null }>('SELECT MAX(ts) AS ts FROM ops.library_draft_scans', [], q)
  return { saved: t?.saved ?? 0, dismissed: t?.dismissed ?? 0, last_scan_ts: s?.ts ?? null }
}

/** did the conversation file a loop lesson that no library draft was made from? */
export async function conversationHasUndraftedLesson(conversationId: string, q?: Queryable): Promise<boolean> {
  return (await one('SELECT 1 AS x FROM ops.loop_lessons WHERE conversation_id = $1 AND id NOT IN ' +
    '(SELECT lesson_id FROM ops.library_drafts WHERE lesson_id IS NOT NULL) LIMIT 1', [conversationId], q)) !== null
}

// --------------------------------------------------------------------------------- processes (more)

/** close a process row only if it is still open; a known exit code is never overwritten */
export async function closeProcessOnce(id: number, o: { exitCode?: number | null; stoppedAt?: number } = {}, q?: Queryable): Promise<number> {
  return exec('UPDATE ops.processes SET stopped_at = $1, exit_code = COALESCE(exit_code, $2) WHERE id = $3 AND stopped_at IS NULL',
    [o.stoppedAt ?? nowMs(), o.exitCode ?? null, id], q)
}

// ------------------------------------------------------------------------------------ health (reads)

export type HealthPoint = { probe_id: string; ts: number; status: string; reading: string | null }
export type HealthPointDetail = HealthPoint & { detail_json: unknown }

/** readings whose probe_id starts with the prefix, of one target kind, with ts >= since, oldest first */
export async function healthReadingsSince(probePrefix: string, target: string, since: number, q?: Queryable): Promise<HealthPoint[]> {
  return query('SELECT probe_id, ts, status, reading FROM ops.health_readings WHERE starts_with(probe_id, $1) AND target = $2 AND ts >= $3 ORDER BY ts, id',
    [probePrefix, target, since], q)
}

/** which of the probes have a reading with ts >= since */
export async function healthProbesSeen(probeIds: string[], since: number, q?: Queryable): Promise<Set<string>> {
  if (!probeIds.length) return new Set()
  return new Set((await query<{ p: string }>('SELECT DISTINCT probe_id AS p FROM ops.health_readings WHERE probe_id = ANY($1) AND ts >= $2',
    [probeIds, since], q)).map(r => r.p))
}

/** probe_id -> newest reading ts, for the probes that have one */
export async function lastHealthTs(probeIds: string[], q?: Queryable): Promise<Map<string, number>> {
  if (!probeIds.length) return new Map()
  return new Map((await query<{ probe_id: string; ts: number }>('SELECT probe_id, MAX(ts) AS ts FROM ops.health_readings WHERE probe_id = ANY($1) GROUP BY probe_id',
    [probeIds], q)).map(r => [r.probe_id, r.ts]))
}

/** readings with since <= ts <= until, oldest first */
export async function healthBetween(probeIds: string[], since: number, until: number, q?: Queryable): Promise<HealthPointDetail[]> {
  if (!probeIds.length) return []
  return query('SELECT probe_id, ts, status, reading, detail_json FROM ops.health_readings WHERE probe_id = ANY($1) AND ts >= $2 AND ts <= $3 ORDER BY ts, id',
    [probeIds, since, until], q)
}

/** each probe's newest reading with ts < before */
export async function healthBefore(probeIds: string[], before: number, q?: Queryable): Promise<HealthPointDetail[]> {
  if (!probeIds.length) return []
  return query('SELECT DISTINCT ON (probe_id) probe_id, ts, status, reading, detail_json FROM ops.health_readings WHERE probe_id = ANY($1) AND ts < $2 ' +
    'ORDER BY probe_id, ts DESC, id DESC', [probeIds, before], q)
}

// -------------------------------------------------------------------------------------- jobs (reads)

export type WindowRun = Pick<R<'job_runs'>, 'id' | 'job_id' | 'due_at' | 'started_at' | 'ended_at' | 'status' | 'trigger' | 'detail'>

/** runs DUE inside [since, until], or with no due and a start (else end) inside it */
export async function jobRunsInWindow(since: number, until: number, q?: Queryable): Promise<WindowRun[]> {
  return query(`SELECT id, job_id, due_at, started_at, ended_at, status, trigger, detail FROM ops.job_runs
    WHERE (due_at BETWEEN $1 AND $2) OR (due_at IS NULL AND COALESCE(started_at, ended_at) BETWEEN $1 AND $2)
    ORDER BY COALESCE(due_at, started_at, ended_at), id`, [since, until], q)
}

/** the oldest run's start (else end), and each job's oldest due */
export async function jobRunSpan(q?: Queryable): Promise<{ first: number | null; first_due: Map<string, number> }> {
  const f = await one<{ t: number | null }>('SELECT MIN(COALESCE(started_at, ended_at)) AS t FROM ops.job_runs', [], q)
  const d = await query<{ job_id: string; t: number }>('SELECT job_id, MIN(due_at) AS t FROM ops.job_runs WHERE due_at IS NOT NULL GROUP BY job_id', [], q)
  return { first: f?.t ?? null, first_due: new Map(d.map(r => [r.job_id, r.t])) }
}

// ------------------------------------------------------------------------------------- usage (reads)
// billable = tokens_in + cache_write + tokens_out. A DAY is the local calendar day of `ts` in the IANA zone `tz`.

export type UsageDay = { agent: string; day: string; tin: number; tout: number; cr: number; cw: number; cost: number; billable: number; n: number }

/** per (agent, local day) with ts >= since; newest day first */
export async function usageByDay(since: number, tz: string, q?: Queryable): Promise<UsageDay[]> {
  return query(`SELECT agent_id AS agent, to_char(to_timestamp(ts / 1000.0) AT TIME ZONE $1, 'YYYY-MM-DD') AS day,
      SUM(tokens_in)::float8 AS tin, SUM(tokens_out)::float8 AS tout, SUM(cache_read)::float8 AS cr, SUM(cache_write)::float8 AS cw,
      SUM(cost_usd)::float8 AS cost, SUM(tokens_in + cache_write + tokens_out)::float8 AS billable, count(*)::int AS n
    FROM ops.usage WHERE ts >= $2 GROUP BY 1, 2 ORDER BY day DESC, agent`, [tz, since], q)
}

/** the billable sum (or null) and row count of usage rows with ts >= since on the local day `day` */
export async function billableOnDay(day: string, tz: string, since: number, q?: Queryable): Promise<{ billable: number | null; n: number }> {
  const r = await one<{ t: number | null; n: number }>(`SELECT SUM(tokens_in + cache_write + tokens_out)::float8 AS t, count(*)::int AS n FROM ops.usage
    WHERE ts >= $1 AND to_char(to_timestamp(ts / 1000.0) AT TIME ZONE $2, 'YYYY-MM-DD') = $3`, [since, tz, day], q)
  return { billable: r?.t ?? null, n: r?.n ?? 0 }
}

/** agent, ts, billable per usage row with since <= ts < until, oldest first */
export async function billableRows(since: number, until: number, q?: Queryable): Promise<{ agent: string; ts: number; billable: number }[]> {
  return query('SELECT agent_id AS agent, ts, (tokens_in + cache_write + tokens_out)::float8 AS billable FROM ops.usage WHERE ts >= $1 AND ts < $2 ORDER BY ts, id',
    [since, until], q)
}

export async function billableByAgent(since: number, q?: Queryable): Promise<Map<string, number>> {
  return new Map((await query<{ a: string; t: number }>('SELECT agent_id AS a, SUM(tokens_in + cache_write + tokens_out)::float8 AS t FROM ops.usage ' +
    'WHERE ts >= $1 GROUP BY agent_id', [since], q)).map(r => [r.a, r.t]))
}

/** agent -> newest spend alert ts */
export async function lastSpendAlerts(q?: Queryable): Promise<Map<string, number>> {
  return new Map((await query<{ agent: string; ts: number }>('SELECT agent, MAX(ts) AS ts FROM ops.spend_alerts GROUP BY agent', [], q)).map(r => [r.agent, r.ts]))
}

// ------------------------------------------------------------------------------ the DATA panel audit

/** append one audit record (append-only); returns the stored row */
export async function addDataAudit(op: string, actor: string,
  o: { request?: unknown; result?: unknown; planId?: string | null; pid?: number | null; host?: string | null; ts?: number } = {},
  q?: Queryable): Promise<R<'data_audit'>> {
  return insert('data_audit', { ts: o.ts ?? nowMs(), op, actor, pid: o.pid ?? null, host: o.host ?? null, plan_id: o.planId ?? null,
    request: o.request === undefined ? null : o.request, result: o.result === undefined ? null : o.result }, q)
}

/** the newest `limit` records, returned OLDEST first */
export async function listDataAudit(o: { limit?: number } = {}, q?: Queryable): Promise<R<'data_audit'>[]> {
  return (await select('data_audit', { orderBy: ['-ts', '-id'], limit: o.limit ?? 100 }, q)).reverse()
}

// ------------------------------------------------------------------------------------------ the wire

export type WireChangeIn = { ts_ms: number; prev_ms?: number | null; venue: string; kind: string; subject: string;
  before?: unknown; after?: unknown; source?: string; tag?: string }

/** append detected venue changes in one transaction; returns how many */
export async function addWireChanges(rows: WireChangeIn[], o: { logged?: number } = {}, q?: Queryable): Promise<number> {
  if (!rows.length) return 0
  const t = o.logged ?? nowMs()
  return transaction(async c => {
    for (const r of rows) {
      await insert('wire_changes', { ts_ms: r.ts_ms, prev_ms: r.prev_ms ?? null, venue: r.venue, kind: r.kind, subject: r.subject,
        before: r.before === undefined ? null : r.before, after: r.after === undefined ? null : r.after,
        source: r.source ?? '', tag: r.tag ?? '[API]', logged: t }, c)
    }
    return rows.length
  }, q)
}

/** detected changes (ts_ms >= since), newest first (or oldest first); limit null = all */
export async function listWireChanges(o: { venue?: string; since?: number; limit?: number | null; oldestFirst?: boolean } = {},
  q?: Queryable): Promise<R<'wire_changes'>[]> {
  const w: string[] = []; const a: unknown[] = []
  if (o.venue !== undefined) { a.push(o.venue); w.push(`venue = $${a.length}`) }
  if (o.since !== undefined) { a.push(o.since); w.push(`ts_ms >= $${a.length}`) }
  let sqlText = `SELECT ${cols('wire_changes')} FROM ops.wire_changes${w.length ? ' WHERE ' + w.join(' AND ') : ''}` +
    (o.oldestFirst ? ' ORDER BY ts_ms, id' : ' ORDER BY ts_ms DESC, id DESC')
  const limit = o.limit === undefined ? 500 : o.limit
  if (limit !== null) { a.push(limit); sqlText += ` LIMIT $${a.length}` }
  return query(sqlText, a, q)
}

export async function countWireChanges(o: { venue?: string; since?: number } = {}, q?: Queryable): Promise<number> {
  const w: string[] = []; const a: unknown[] = []
  if (o.venue !== undefined) { a.push(o.venue); w.push(`venue = $${a.length}`) }
  if (o.since !== undefined) { a.push(o.since); w.push(`ts_ms >= $${a.length}`) }
  return (await one<{ n: number }>(`SELECT count(*)::int AS n FROM ops.wire_changes${w.length ? ' WHERE ' + w.join(' AND ') : ''}`, a, q))?.n ?? 0
}

/** the day's latest public-metadata read of one venue (a later read that day replaces it) */
export async function setWireSnapshot(venue: string, day: string, tsMs: number, markets: unknown, o: { source?: string } = {},
  q?: Queryable): Promise<R<'wire_snapshots'>> {
  return upsert('wire_snapshots', { venue, day, ts_ms: tsMs, source: o.source ?? '', markets }, {}, q)
}

export async function latestWireSnapshot(venue: string, q?: Queryable): Promise<R<'wire_snapshots'> | null> {
  return one(`SELECT ${cols('wire_snapshots')} FROM ops.wire_snapshots WHERE venue = $1 ORDER BY day DESC LIMIT 1`, [venue], q)
}

/** venue -> {ts_ms, markets (how many), source} of each venue's latest snapshot */
export async function wireSnapshotHeads(q?: Queryable): Promise<Map<string, { ts_ms: number; markets: number; source: string }>> {
  const rows = await query<{ venue: string; ts_ms: number; source: string; n: number }>('SELECT DISTINCT ON (venue) venue, ts_ms, source, ' +
    '(SELECT count(*) FROM jsonb_object_keys(markets))::int AS n FROM ops.wire_snapshots ORDER BY venue, day DESC', [], q)
  return new Map(rows.map(r => [r.venue, { ts_ms: r.ts_ms, markets: r.n, source: r.source }]))
}

export async function getWireState(key: string, q?: Queryable): Promise<unknown> {
  return (await get('wire_state', key, q))?.value ?? null
}

export async function setWireState(key: string, value: unknown, o: { ts?: number } = {}, q?: Queryable): Promise<R<'wire_state'>> {
  return upsert('wire_state', { key, value, updated: o.ts ?? nowMs() }, {}, q)
}

// ------------------------------------------------------------------------------ no-lesson stand-downs

export async function addNoLesson(desk: string, subject: string, reason: string,
  o: { hand?: string | null; operator?: string | null; touched?: string[]; ts?: number } = {}, q?: Queryable): Promise<number> {
  return (await insert('no_lesson', { ts: o.ts ?? nowMs(), desk: desk || '.', hand: o.hand ?? null, operator: o.operator ?? null,
    subject, reason, touched: (o.touched ?? []).map(String) }, q)).id
}

/** newest first */
export async function listNoLesson(o: { desk?: string; limit?: number } = {}, q?: Queryable): Promise<R<'no_lesson'>[]> {
  return select('no_lesson', { where: o.desk !== undefined ? { desk: o.desk } : undefined, orderBy: ['-ts', '-id'], limit: o.limit ?? 500 }, q)
}

