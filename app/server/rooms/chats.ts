import type { ServiceGroup, Status } from '../../shared/types.ts'
import { onRestart, onStop, onSummary } from '../hooks.ts'
import { logEvent, ops } from '../db.ts'
import { publish } from '../events.ts'
import { HttpError, type Router } from '../http.ts'
import { inFund } from '../paths.ts'
import { busyReasons, childNames } from '../restart.ts'
import { agent as configAgent, config } from '../config.ts'
import { agentCwd, EFFORTS, launchCwd } from '../chat/launch.ts'
import { checkEffort, checkModel, exactOf, readPermitted } from '../chat/models.ts'
import { checkDial, providers } from '../chat/engines/catalog.ts'
import { landEffort } from '../chat/engines/land.ts'
import { EFFORT_ORDER, engineOf, nearestEffort } from '../../shared/engines.ts'
import type { PermittedModel } from '../../shared/models.ts'
import * as changes from '../chat/changes.ts'
import { draftHandoff } from '../chat/handoff.ts'
import { law } from '../chat/law.ts'
import * as prompts from '../chat/prompts.ts'
import * as pty from '../chat/pty.ts'
import * as runner from '../chat/runner.ts'
import { readPlan } from '../chat/planlimit.ts'
import * as store from '../chat/store.ts'
import type { AgentRow } from '../chat/types.ts'

// ROOM: chats. Conversations with the fund's agents (one Agent SDK process each, owned by fundd)
// and terminals (node-pty, owned by fundd). Engine in server/chat/; this file is the routes.
// Other rooms start a conversation with POST /api/chats {agent, prompt} and then go('chats', id).

const bad = (m: string) => new HttpError(400, m)
const need = async (id: string) => { const c = await store.get(id); if (!c) throw new HttpError(404, 'no such conversation'); return c }

/** a model id a conversation may run: Claude's own list for a bare id, the provider's for a prefixed one */
const pickModel = (id: string): Promise<PermittedModel> => engineOf(id) === 'claude' ? checkModel(id) : checkDial(id).then(d => d.model)
const EFFORT_IDS: readonly string[] = EFFORT_ORDER
/** every row of every provider, by id (the effort ladder of whatever model a conversation holds) */
const ladderOf = async (id: string): Promise<string[] | undefined> =>
  (await providers()).flatMap(p => p.read.models).find(m => m.id === id)?.efforts

async function agentRows(): Promise<AgentRow[]> {
  const live = runner.byAgent()
  const totals = await ops.conversationCounts()
  return config.agents().map(a => {
    const l = live.get(a.id) ?? { working: 0, waiting: 0, open: 0 }
    return {
      id: a.id, name: a.name, kind: a.kind, mode: a.mode, role: a.role, dept: a.dept, cwd: a.cwd, model: a.model, effort: a.effort,
      working: l.working, waiting: l.waiting, open: l.open, total: totals.get(a.id) ?? 0,
    }
  })
}

export function register(r: Router) {
  if (!process.env.VITEST) void readPermitted()   // ask Claude Code for the permitted models once at start (never inside the tests)
  r.get('/api/chats/agents', async () => { await store.adopt(config.agents()); return { agents: await agentRows(), efforts: EFFORTS } })

  // the plan's 5-hour and 7-day windows as Claude Code last reported them (server/chat/planlimit.ts); before /:id
  r.get('/api/chats/plan', () => readPlan())

  r.get('/api/chats', async ({ query }) => {
    await store.adopt(config.agents())
    const rows = await store.list({ agent: query.get('agent') ?? undefined, q: query.get('q') ?? undefined, limit: Number(query.get('limit')) || 300 })
    // ?preview=1 (the landing): each row's last message as one line, absent when there is none
    const pv = query.get('preview') === '1' ? await store.previews(rows.map(c => c.id)) : null
    return { conversations: rows.map(c => {
      const failed = runner.lastTurnFailed(c.id)
      return { ...c, state: runner.liveState(c.id), ...(failed === null ? {} : { failed }), ...(pv?.has(c.id) ? { preview: pv.get(c.id) } : {}) }
    }) }
  })

  r.post('/api/chats', async ({ body }) => {
    const b = await body()
    if (typeof b.agent !== 'string' || !b.agent) throw bad('agent required')
    const a = configAgent(b.agent)
    if (!a) throw new HttpError(404, `no agent ${b.agent}`)
    if (a.mode === 'dormant') throw new HttpError(409, `${a.name} is dormant - arm it in its roster file first`)
    // an optional model / effort for this conversation (the board's own model), checked like a PATCH
    let brain: { model: string | null; effort: string | null } | undefined
    if (typeof b.model === 'string' && b.model) {
      const pm = await pickModel(b.model).catch(e => { throw bad(e.message) })
      const effort = typeof b.effort === 'string' && b.effort && pm.efforts.length ? b.effort : null
      if (effort) { try { checkEffort(pm, effort) } catch (e) { throw bad((e as Error).message) } }
      brain = { model: pm.id, effort }
    } else if (typeof b.effort === 'string' && b.effort) {
      if (!EFFORT_IDS.includes(b.effort)) throw bad(`effort must be one of ${EFFORT_IDS.join(', ')}`)
      brain = { model: null, effort: b.effort }
    }
    try { return await runner.start(a.id, typeof b.prompt === 'string' ? b.prompt : undefined, typeof b.title === 'string' ? b.title : undefined, brain) }
    catch (e: any) { throw e instanceof HttpError ? e : bad(String(e?.message ?? e)) }
  })

  // the prompt rack (registered before /:id so the literal segment wins)
  r.get('/api/chats/prompts', async () => ({ prompts: await prompts.list() }))
  r.post('/api/chats/prompts', async ({ body }) => {
    const b = await body()
    let p
    try { p = await prompts.upsert(b) } catch (e) { throw e instanceof prompts.PromptError ? bad(e.message) : e }
    publish('chats:prompts', { id: p.id })
    return { prompt: p }
  })
  r.delete('/api/chats/prompts/:id', async ({ params }) => {
    const ok = await prompts.remove(Number(params.id))
    if (!ok) throw new HttpError(404, 'no such prompt')
    publish('chats:prompts', { id: Number(params.id), removed: true })
    return { ok }
  })

  // terminals (registered before /:id so the literal segment wins)
  r.get('/api/chats/terminals', () => ({ terminals: pty.terminals() }))
  // the light in each tab: every conversation's turn progress (server/chat/progress.ts), topic chat:progress
  r.get('/api/chats/progress', () => ({ progress: runner.progressList() }))
  r.post('/api/chats/terminal', async ({ body }) => {
    const b = await body()
    let cwd: string | undefined
    let agent: string | null = null
    if (typeof b.agent === 'string' && b.agent) {
      const a = configAgent(b.agent)
      if (!a) throw new HttpError(404, `no agent ${b.agent}`)
      agent = a.id
      cwd = agentCwd(a)
    }
    if (typeof b.cwd === 'string' && b.cwd) {
      const abs = inFund(b.cwd)
      if (!abs) throw bad('cwd must be inside the fund')
      cwd = abs
    }
    try { return pty.openTerminal({ cwd, agent, cols: Number(b.cols) || undefined, rows: Number(b.rows) || undefined }) }
    catch (e: any) { throw bad(String(e?.message ?? e)) }
  })
  r.delete('/api/chats/terminal/:id', ({ params }) => ({ ok: pty.killTerminal(params.id) }))
  r.ws('/ws/term/:id', pty.upgrade)

  // the models this account may run, as Claude Code itself lists them (server/chat/models.ts); ?fresh=1 asks again
  r.get('/api/chats/models', async ({ query }) => readPermitted(query.get('fresh') === '1'))
  // every provider the chat box offers (Claude, Codex, DeepSeek, Grok), each with its models, effort ladders and, when it
  // cannot run here, the line that says what is missing; ?fresh=1 asks again
  r.get('/api/chats/providers', async ({ query }) => ({ providers: await providers(query.get('fresh') === '1') }))

  r.get('/api/chats/:id', async ({ params }) => {
    const c = await need(params.id)
    return { conversation: { ...c, state: runner.liveState(c.id) }, ...(await runner.entries(c.id)) }
  })

  r.post('/api/chats/:id/send', async ({ params, body }) => {
    await need(params.id)
    const b = await body()
    const images = Array.isArray(b.images) ? b.images.filter((x: any) => x && typeof x.data === 'string') : []
    try { await runner.send(params.id, String(b.text ?? ''), images) } catch (e: any) { throw e instanceof HttpError ? e : bad(String(e?.message ?? e)) }
    return { ok: true }
  })

  // a compaction on demand through the seat (send() would space the slash and chat it)
  r.post('/api/chats/:id/compact', async ({ params }) => {
    await need(params.id)
    try { await runner.command(params.id, '/compact') } catch (e: any) { throw new HttpError(409, String(e?.message ?? e)) }
    return { ok: true }
  })

  r.post('/api/chats/:id/stop', async ({ params, body }) => {
    await need(params.id)
    const b = await body()
    return runner.stop(params.id, !!b.hard)
  })

  // one background command or subagent: Stop (above) spares them since B-0560
  r.post('/api/chats/:id/tasks/:task/stop', async ({ params }) => {
    await need(params.id)
    const out = await runner.stopTask(params.id, params.task)
    if (!out.ok) throw new HttpError(404, out.error)
    return out
  })

  r.post('/api/chats/:id/decide', async ({ params, body }) => {
    await need(params.id)
    try { runner.decide(params.id, await body()) } catch (e: any) { throw new HttpError(409, String(e?.message ?? e)) }
    return { ok: true }
  })

  r.post('/api/chats/:id/rewind', async ({ params, body }) => {
    await need(params.id)
    const b = await body()
    try { return await runner.rewind(params.id, String(b.entry ?? '')) } catch (e: any) { throw new HttpError(409, String(e?.message ?? e)) }
  })

  r.patch('/api/chats/:id', async ({ params, body }) => {
    const c = await need(params.id)
    const b = await body()
    const agentModel = config.agents().find(a => a.id === c.agent)?.model ?? ''
    const agentEffort = config.agents().find(a => a.id === c.agent)?.effort ?? ''
    const p: { title?: string; model?: string | null; effort?: string | null } = {}
    if (typeof b.title === 'string') p.title = b.title.trim().slice(0, 120)
    if (b.model === null || typeof b.model === 'string') {
      if (b.model) await pickModel(b.model).catch(e => { throw bad(e.message) })
      p.model = b.model || null
    }
    if (b.effort === null || typeof b.effort === 'string') {
      if (b.effort && !EFFORT_IDS.includes(b.effort)) throw bad(`effort must be one of ${EFFORT_IDS.join(', ')}`)
      p.effort = b.effort || null
    }
    // The effort must be on the ladder of the model the conversation will hold. A model that takes none clears the
    // override; an effort the NEW model lacks (Codex's ultra on a Claude model) lands on its nearest rung at or below, and
    // the answer below says where it landed: the pill takes the server's word, never its own guess.
    const model = exactOf(p.model !== undefined ? p.model ?? agentModel : c.model ?? agentModel)
    const ladder = await ladderOf(model)
    const landed = landEffort(ladder, { modelChanged: p.model !== undefined, asked: p.effort, stored: c.effort })
    if ('error' in landed) throw bad(`${model} ${landed.error}`)
    if (landed.effort !== undefined) p.effort = landed.effort
    let out
    try { out = await runner.patch(params.id, p) } catch (e: any) { throw e instanceof HttpError ? e : new HttpError(409, String(e?.message ?? e)) }
    const effort = p.effort !== undefined ? p.effort : c.effort
    return { ok: true, ...out, model: p.model !== undefined ? p.model : c.model, effort, effective: ladder ? (ladder.length ? nearestEffort(ladder, effort || agentEffort) : '') : effort || agentEffort }
  })

  // ---- a conversation's changes: its commits (by Conversation: trailer) + the agent's working tree
  const convCwd = async (id: string) => {
    const c = await need(id)
    const a = configAgent(c.agent)
    if (!a) throw new HttpError(404, `agent ${c.agent} is not in the roster`)
    return launchCwd(a, id) // a conversation on a build branch reads its worktree, not the main checkout
  }
  r.get('/api/chats/:id/changes', async ({ params }) => {
    const cwd = await convCwd(params.id)
    const ch = await changes.changes(params.id, cwd)
    return { ...ch, plan: changes.revertPlan(ch.commits).map(p => ({ repo: p.repo, shas: p.shas.map(c => c.sha), skipped: p.skipped.length })) }
  })
  r.get('/api/chats/:id/diff', async ({ params, query }) => {
    const cwd = await convCwd(params.id)
    try {
      return await changes.fileDiff(params.id, cwd, { repo: String(query.get('repo') ?? ''), path: String(query.get('path') ?? ''), sha: query.get('sha') || undefined })
    } catch (e: any) { throw bad(String(e?.message ?? e)) }
  })
  r.post('/api/chats/:id/revert', async ({ params, body }) => {
    const cwd = await convCwd(params.id)
    const b = await body()
    if (b.confirm !== true) throw bad('confirm required')
    const expect = Array.isArray(b.shas) ? b.shas.filter((x: unknown): x is string => typeof x === 'string') : undefined
    let results
    try { results = await changes.revertConversation(params.id, cwd, expect) } catch (e: any) { throw new HttpError(409, String(e?.message ?? e)) }
    const n = results.reduce((s, x) => s + x.reverted.length, 0)
    const failed = results.filter(x => x.error)
    logEvent(failed.length ? 'error' : 'turn', `reverted ${n} commit${n === 1 ? '' : 's'} of ${params.id}${failed.length ? ` - stopped: ${failed.map(f => `${f.repo} ${f.error}`).join('; ')}` : ''}`.slice(0, 300), { conversation: params.id })
    publish('git', { reverted: params.id })
    publish('chat', { id: params.id, reverted: n })
    return { results }
  })

  // ---- the loaded-law manifest: every instruction file and boot book in the context, with drift
  r.get('/api/chats/:id/law', async ({ params }) => { await need(params.id); return law(params.id) })

  // ---- handoff: a deterministic draft for the next seat (numbers word for word)
  r.get('/api/chats/:id/handoff', async ({ params }) => {
    await need(params.id)
    const h = await draftHandoff(params.id)
    if (!h) throw new HttpError(404, 'no such conversation')
    return h
  })

  r.delete('/api/chats/:id', async ({ params }) => { await need(params.id); runner.forget(params.id); return { ok: true } })

  r.get('/api/chats/:id/attach/:file', async ({ params, res }) => {
    const a = await runner.attachment(params.id, params.file)
    if (!a) throw new HttpError(404, 'no such attachment')
    res.writeHead(200, { 'content-type': a.mime, 'cache-control': 'max-age=3600' })
    res.end(a.buf)
    return undefined
  })
}

onStop(async () => { await runner.stopAll() })
onSummary(() => runner.counts())
// the idle restart (B-0174): a running turn, a parked decision, background work (B-0254) or a terminal
// running a command holds it; the open conversations are saved and reopened from their transcripts by
// the next fundd, and the journal keeps that list current for an exit that is not a restart.
// Terminals are not reopened: a shell at its prompt is closed with fundd.
onRestart({
  busy: async () => busyReasons({
    convs: runner.liveList(),
    terminals: await Promise.all(pty.terminals().filter(t => t.alive).map(async t => ({ id: t.id, title: t.title, children: await childNames(t.pid) }))),
  }),
  live: () => runner.liveList(),
  close: () => { runner.closeForRestart(); pty.killAllTerminals() },
  reopen: (id, r) => runner.reopen(id, r),
  scan: (since, exclude) => runner.scanCut(since, exclude),
  watch: fn => runner.onLiveChange(fn),
})

/** the services rail: one row per agent with live work */
export async function services(): Promise<ServiceGroup | null> {
  const live = runner.byAgent()
  const rows = config.agents().filter(a => { const l = live.get(a.id); return l && (l.working || l.waiting) }).map(a => {
    const l = live.get(a.id)!
    // 'run' / 'ask' are the kit's working / waiting-on-you dots; ServiceRow.status is typed Status
    const status = (l.waiting ? 'ask' : 'run') as unknown as Status
    const reading = [l.working ? `${l.working} working` : '', l.waiting ? `${l.waiting} waiting` : ''].filter(Boolean).join(' ')
    return { id: `agent:${a.id}`, label: a.name, status, reading, room: 'chats' }
  })
  return { id: 'agents', label: 'Agents', rows }
}
