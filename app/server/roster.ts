import { existsSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Agent } from '../shared/types.ts'
import { agentFileName, headerErrors, isAgentFileName, parseAgentFile, serializeAgentFile, type Header } from '../shared/agentfile.ts'

/**
 * THE ROSTER: one file per agent in app/agents/ (paths.ts AGENTS_DIR), a YAML header (the row every
 * reader uses: id, cwd, writes, boot, model, effort, ...) and the agent's brief as the body. It
 * replaced the fund root's agents.json and the separate brief files on 2026-09-25. The format is
 * shared/agentfile.ts; the python tools read the same files through app/tools/_root.py agents().
 *
 * A file that does not parse, or whose header is not a whole agent, is LEFT OUT and named in
 * `problems` (the System room shows it); the other agents still load. Two files claiming one id are
 * both named and the second is left out. Sorted by `order`, then id.
 */

export type RosterProblem = { path: string; error: string }
export type Roster = { agents: Agent[]; headers: Header[]; problems: RosterProblem[] }

const FIELDS = ['id', 'name', 'kind', 'mode', 'dept', 'dashboard', 'role', 'cwd', 'model', 'effort', 'order', 'writes', 'boot', 'reads'] as const

function toAgent(h: Header): Agent {
  const a: Record<string, unknown> = {}
  for (const k of FIELDS) if (h[k] !== undefined && h[k] !== null) a[k] = h[k]
  return a as Agent
}

export function readRoster(dir: string, rel = 'app/agents'): Roster {
  let names: string[] = []
  try { names = readdirSync(dir).filter(isAgentFileName).sort() } catch { return { agents: [], headers: [], problems: [] } }
  const rows: { h: Header; path: string }[] = []
  const problems: RosterProblem[] = []
  for (const name of names) {
    const path = `${rel}/${name}`
    let h: Header
    try { h = parseAgentFile(readFileSync(join(dir, name), 'utf8')).header } catch (e) { problems.push({ path, error: (e as Error).message }); continue }
    const errs = headerErrors(h, name)
    if (errs.length) { problems.push({ path, error: errs.join('; ') }); continue }
    const twin = rows.find(r => r.h.id === h.id)
    if (twin) { problems.push({ path, error: `id ${h.id} is also ${twin.path}` }); continue }
    rows.push({ h, path })
  }
  const ord = (h: Header) => (typeof h.order === 'number' ? h.order : Number.MAX_SAFE_INTEGER)
  rows.sort((a, b) => ord(a.h) - ord(b.h) || String(a.h.id).localeCompare(String(b.h.id)))
  return { agents: rows.map(r => toAgent(r.h)), headers: rows.map(r => r.h), problems }
}

/** write one file whole: temp + rename in the same folder, so a crash never leaves half a file */
function writeAtomic(file: string, text: string) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(tmp, text)
  try { renameSync(tmp, file) } catch (e) { if (existsSync(tmp)) unlinkSync(tmp); throw e }
}

/** the header an Agent writes: the known fields from `a`, every other key of the old header kept */
function headerOf(a: Agent, old: Header = {}): Record<string, unknown> {
  const h: Record<string, unknown> = { ...old }
  for (const k of FIELDS) {
    const v = (a as Record<string, unknown>)[k]
    if (v === undefined) delete h[k]
    else h[k] = v
  }
  return h
}

/**
 * Persist agent rows (a boot-list toggle, a model change): each agent's header is rewritten in place,
 * its brief and any key this code does not know (budgetTokensPerDay, ...) kept. A file whose header
 * would not change is not touched. An agent with no file is refused: the roster grows only through
 * addAgentFile. Returns the fund-relative files written.
 */
export function saveAgentFiles(dir: string, agents: Agent[], rel = 'app/agents'): string[] {
  const written: string[] = []
  for (const a of agents) {
    const name = agentFileName(a.id)
    const file = join(dir, name)
    if (!existsSync(file)) throw new Error(`no roster file ${rel}/${name} for ${a.id}`)
    const raw = readFileSync(file, 'utf8')
    const { header, body } = parseAgentFile(raw)
    const next = headerOf(a, header)
    const errs = headerErrors(next as Header, name)
    if (errs.length) throw new Error(`${rel}/${name}: ${errs.join('; ')}`)
    const text = serializeAgentFile(next, body)
    if (text === raw.replace(/\r\n/g, '\n')) continue
    writeAtomic(file, text)
    written.push(`${rel}/${name}`)
  }
  return written
}

/** a NEW agent: its file, header + brief. Refuses to overwrite; returns the absolute path written. */
export function addAgentFile(dir: string, a: Agent, brief: string): string {
  const name = agentFileName(a.id)
  const file = join(dir, name)
  if (existsSync(file)) throw new Error(`refusing to overwrite ${name}`)
  const h = headerOf(a)
  const errs = headerErrors(h as Header, name)
  if (errs.length) throw new Error(`${name}: ${errs.join('; ')}`)
  writeFileSync(file, serializeAgentFile(h, brief), { flag: 'wx' })
  return file
}

/** rollback: remove exactly one agent's file (no-op when absent) */
export function removeAgentFile(dir: string, id: string) {
  const file = join(dir, agentFileName(id))
  if (existsSync(file)) unlinkSync(file)
}

/** an agent's brief: the body of its file, or null when the file is missing or unreadable */
export function briefText(dir: string, id: string): string | null {
  try { return parseAgentFile(readFileSync(join(dir, agentFileName(id)), 'utf8')).body } catch { return null }
}
