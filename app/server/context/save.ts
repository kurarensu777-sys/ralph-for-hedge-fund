import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { agentFileName, headerErrors, parseAgentFile, serializeAgentFile, type Header } from '../../shared/agentfile.ts'
import type { CtxSaved } from '../../shared/context.ts'
import { splitRef } from '../../shared/bookmeta.ts'
import { AGENTS_DIR, AGENTS_REL, FUND_ROOT } from '../paths.ts'
import { HttpError } from '../http.ts'
import { hashOf, saveFiles } from '../library/edit.ts'
import { repoFor } from '../library/scan.ts'

// THE CONTEXT ROOM'S SAVE: an agent's brief, boot list, model and effort all live in ONE file, its roster
// file (app/agents/<id>.md), so every edit is one file through saveFiles (library/edit.ts): the caller's
// `base` hash is checked (409 when the file moved), and exactly that path is committed as the owner
// (`Agent: you`). A brief-only edit leaves the header's bytes alone; a header edit rewrites it in the
// roster's own format (shared/agentfile.ts), keeping every key this code does not know.

export type Edit = { brief?: string; boot?: string[]; model?: string; effort?: string }

/** pure: the file's text with `e` applied, and the names of the parts that changed (empty = nothing to write).
 *  `known(ref)` says whether a boot ref added now names a book, a chapter or a shelf index; a ref already in
 *  the list stays even when it is stale (removing it is the owner's click, not ours). */
export function applyEdit(raw: string, file: string, e: Edit, known: (ref: string) => boolean): { text: string; changed: string[] } {
  const lf = raw.replace(/^﻿/, '').replace(/\r\n/g, '\n')
  let parsed: { header: Header; body: string }
  try { parsed = parseAgentFile(lf) } catch (err) { throw new HttpError(409, `${file} does not parse: ${(err as Error).message}`) }
  const header: Header = { ...parsed.header }
  const changed: string[] = []
  let body = parsed.body
  if (e.brief !== undefined) {
    if (typeof header.brief === 'string' && header.brief) throw new HttpError(400, `${file} keeps its brief in ${header.brief}: edit that book in the Library`)
    if (!e.brief.trim()) throw new HttpError(400, 'the brief is empty')
    const next = e.brief.replace(/\r\n/g, '\n').replace(/^\n+/, '').replace(/\n*$/, '\n')
    if (next !== body.replace(/\n*$/, '\n')) { body = next; changed.push('brief') }
  }
  if (e.boot !== undefined) {
    if (!Array.isArray(e.boot) || e.boot.some(x => typeof x !== 'string' || !x.trim())) throw new HttpError(400, 'boot is a list of book refs')
    const next = [...new Set(e.boot.map(x => x.trim()))]
    const had = Array.isArray(header.boot) ? header.boot : []
    for (const r of next) if (!had.includes(r) && !known(r)) throw new HttpError(400, `not a book or chapter: ${r}`)
    if (next.join('\n') !== had.join('\n')) { header.boot = next; changed.push('boot') }
  }
  if (e.model !== undefined && e.model !== header.model) { header.model = e.model; changed.push('model') }
  if (e.effort !== undefined && e.effort !== header.effort) { header.effort = e.effort; changed.push('effort') }
  if (!changed.length) return { text: lf, changed }
  const errs = headerErrors(header, file.split('/').pop())
  if (errs.length) throw new HttpError(400, `${file}: ${errs.join('; ')}`)
  if (changed.every(c => c === 'brief')) {
    // the header is the file's own bytes: only what is under the closing --- line moves
    const end = lf.indexOf('\n---', 3)
    const close = lf.indexOf('\n', end + 1)
    return { text: `${lf.slice(0, close < 0 ? lf.length : close)}\n\n${body}`, changed }
  }
  return { text: serializeAgentFile(header, body), changed }
}

export type SaveIn = { agent?: unknown; base?: unknown; brief?: unknown; boot?: unknown; model?: unknown; effort?: unknown }

/** a model and an effort must be ones Claude Code permits (chat/models.ts), the model's own effort list included */
export type ModelCheck = (model: string, effort: string | undefined) => Promise<void>

export async function saveAgent(i: SaveIn, deps: { known: (ref: string) => boolean; checkModel: ModelCheck; dir?: string; rel?: string; fundRoot?: string }): Promise<Omit<CtxSaved, 'drift' | 'driftError'>> {
  const dir = deps.dir ?? AGENTS_DIR, rel = deps.rel ?? AGENTS_REL, fundRoot = deps.fundRoot ?? FUND_ROOT
  if (typeof i.agent !== 'string' || !i.agent) throw new HttpError(400, 'need agent')
  if (typeof i.base !== 'string') throw new HttpError(400, 'need base (the hash the editor opened)')
  const e: Edit = {}
  if (i.brief !== undefined) { if (typeof i.brief !== 'string' || i.brief.length > 200_000) throw new HttpError(400, 'brief must be text'); e.brief = i.brief }
  if (i.boot !== undefined) e.boot = i.boot as string[]
  if (i.model !== undefined) { if (typeof i.model !== 'string') throw new HttpError(400, 'model must be text'); e.model = i.model }
  if (i.effort !== undefined) { if (typeof i.effort !== 'string') throw new HttpError(400, 'effort must be text'); e.effort = i.effort }
  if (e.brief === undefined && e.boot === undefined && e.model === undefined && e.effort === undefined) throw new HttpError(400, 'nothing to save')
  const name = agentFileName(i.agent)
  const abs = join(dir, name)
  const path = `${rel}/${name}`
  let raw: string
  try { raw = readFileSync(abs, 'utf8') } catch { throw new HttpError(404, `no roster file ${path}`) }
  if (hashOf(raw) !== i.base) throw new HttpError(409, `${path} changed on disk; reload`)
  const { text, changed } = applyEdit(raw, path, e, deps.known)
  if (!changed.length) return { written: false, committed: false, hash: i.base, paths: [path], note: 'no change', changed }
  if (changed.includes('model') || changed.includes('effort')) {
    const h = parseAgentFile(text).header
    try { await deps.checkModel(String(h.model), typeof h.effort === 'string' ? h.effort : undefined) } catch (err) { throw new HttpError(400, (err as Error).message) }
  }
  const r = await saveFiles({
    repoAbs: repoFor(fundRoot, path), subject: `context: ${i.agent} ${changed.join(', ')}`,
    files: [{ abs, path, content: text, base: i.base }],
  })
  return { written: r.written, committed: r.committed, sha: r.sha, hash: hashOf(readFileSync(abs, 'utf8')), paths: r.paths, changed }
}

/** a ref's chapter slug must name a heading and its book a shelf book: asked of the library's own index */
export const refKnown = (bootRef: (ref: string) => unknown, index: (path: string) => unknown) => (ref: string): boolean =>
  !!bootRef(ref) || (!splitRef(ref).slug && !!index(ref))
