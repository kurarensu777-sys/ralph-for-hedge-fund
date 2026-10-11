import type { Router } from '../http.ts'
import { HttpError } from '../http.ts'
import type { ServiceGroup } from '../../shared/types.ts'
import type { CtxAll, CtxDetail, CtxSaved } from '../../shared/context.ts'
import { agentFileName } from '../../shared/agentfile.ts'
import { publish } from '../events.ts'
import { AGENTS_DIR, AGENTS_REL, FUND_ROOT } from '../paths.ts'
import { config, roster } from '../config.ts'
import { caps as readCaps } from '../library/caps.ts'
import { bootRef, books } from '../library/core.ts'
import { bootableIndex } from '../library/scan.ts'
import { hashOf } from '../library/edit.ts'
import { agentBrief, mcpServers } from '../chat/launch.ts'
import { checkEffort, checkModel } from '../chat/models.ts'
import { predict } from '../context/predict.ts'
import { refKnown, saveAgent } from '../context/save.ts'
import { driftOf } from '../context/drift.ts'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// ROOM: context - what every agent loads at boot, by type, with the prompt viewer and the editor (B-0348).
// Everything is read from the same helpers a boot uses (server/context/predict.ts); nothing is configured here.

const tryCaps = () => { try { return { caps: readCaps() } } catch (e) { return { caps: null, error: (e as Error).message } } }

export function overview(): CtxAll {
  const c = tryCaps()
  const r = roster()
  const mcp = mcpServers()
  const servers = Object.keys(mcp.servers)
  return {
    caps: c.caps ? { base: c.caps.base, agent: c.caps.agent, boot: c.caps.boot, chapter: c.caps.chapter, chapterTarget: c.caps.chapterTarget, workspace: c.caps.workspace, screen: c.caps.screen, book: c.caps.book } : null,
    ...(c.error ? { capsError: c.error } : {}),
    agents: r.agents.map(a => predict(a, c.caps, servers).ctx),
    problems: r.problems,
    mcp: { servers, problems: mcp.problems },
    at: Date.now(),
  }
}

export function detail(id: string): CtxDetail {
  const a = config.agents().find(x => x.id === id)
  if (!a) throw new HttpError(404, `no agent ${id}`)
  const c = tryCaps()
  const { ctx, append } = predict(a, c.caps)
  const file = `${AGENTS_REL}/${agentFileName(a.id)}`
  let raw = ''
  try { raw = readFileSync(join(AGENTS_DIR, agentFileName(a.id)), 'utf8') } catch { throw new HttpError(404, `no roster file ${file}`) }
  const briefRow = ctx.rows.find(r => r.key === 'agent:brief')
  const own = briefRow?.note === file
  const all = books()
  const brief = agentBrief(a)
  return {
    id: a.id, name: a.name, mode: a.mode,
    prompt: append, promptTokens: ctx.appendTokens,
    brief: { path: briefRow?.note ?? file, text: brief.text, tokens: briefRow?.tokens ?? 0, editable: own, ...(own ? {} : { why: `the brief lives in ${briefRow?.note}: edit that book in the Library` }) },
    header: { model: a.model, effort: a.effort },
    boot: (a.boot ?? []).map(ref => {
      const row = ctx.rows.find(r => r.key === `boot:${ref}`)
      const r = bootRef(all, ref)
      return { ref, tokens: row?.tokens ?? null, state: row?.state ?? 'unknown', title: r ? (r.chapter ? `${r.book.title} - ${r.chapter.title}` : r.book.title) : ref }
    }),
    hash: hashOf(raw), file,
  }
}

export function register(r: Router) {
  r.get('/api/context', () => overview())
  r.get('/api/context/agent', ({ query }) => {
    const id = query.get('id')
    if (!id) throw new HttpError(400, 'need ?id=')
    return detail(id)
  })
  r.get('/api/context/drift', async ({ query }) => {
    const a = config.agents().find(x => x.id === query.get('id'))
    if (!a) throw new HttpError(404, `no agent ${query.get('id')}`)
    return driftOf(a)
  })
  r.post('/api/context/save', async ({ body }) => {
    const b = await body()
    const shelves = config.shelves()
    const saved = await saveAgent(b, {
      known: refKnown(ref => bootRef(books(), ref), p => bootableIndex(FUND_ROOT, shelves, p)),
      checkModel: async (model, effort) => { const m = await checkModel(model); if (effort !== undefined && m.efforts.length) checkEffort(m, effort) },
    })
    if (saved.written) { publish('config', { file: AGENTS_REL }); publish('library'); publish('git'); publish('context') }
    const out: CtxSaved = { ...saved, drift: null }
    // the count is a second question: a failure to ask it never undoes the save
    if (saved.written) {
      const a = config.agents().find(x => x.id === b.agent)
      try { if (a) out.drift = await driftOf(a) } catch (e) { out.driftError = (e as Error).message }
    }
    return out
  })
}

/** the room is a view, not a service */
export async function services(): Promise<ServiceGroup | null> { return null }
