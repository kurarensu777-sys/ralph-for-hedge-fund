import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { chaptersOf, slugOf } from '../../shared/bookmeta.ts'
import { ops, type Queryable } from '../db.ts'
import type { Agent } from '../../shared/types.ts'
import { ownerOf } from './metrics.ts'
import type { Lesson as GitLesson } from './sources.ts'

/**
 * CAPTURE - the lesson inbox. Two ways in:
 *   POST /api/loop/lesson {agent, conversation?, text, scope?, readWhen?}  (an agent or the chats room)
 *   a commit that ADDS a book under library/, or APPENDS a `## ` chapter to one   (read from git)
 * Both become a Captured row the proposal rules cluster.
 */

export type InboxLesson = { id: number; ts: number; agent: string; conversation: string | null; text: string; scope: string; readWhen: string | null; state: string; proposal: string | null }

export type Captured = {
  key: string              // "inbox:12" | "git:<sha>:<path>"
  source: 'inbox' | 'git'
  ts: number
  agent: string | null     // null = filed by the owner (no Agent: trailer) or not attributable
  title: string
  text: string
  readWhen: string | null
  ref: string              // the book path, or `<book>#<slug>` for an appended chapter (git); the conversation id (inbox)
  state: string            // open | promoted | dismissed (git: always open)
}

export const SCOPES = ['agent', 'role', 'fund'] as const

/** more books than this added in one commit reads as a reorganization, not a lesson */
export const MAX_BOOKS_PER_LESSON = 5

export class LessonError extends Error { constructor(public status: number, msg: string) { super(msg) } }

export async function addLesson(db: Queryable, agents: Pick<Agent, 'id'>[], body: Record<string, unknown>, now = Date.now()): Promise<InboxLesson> {
  const agent = String(body.agent ?? '').trim()
  const text = String(body.text ?? '').replace(/\r\n/g, '\n').trim()
  const scope = String(body.scope ?? 'agent').trim() || 'agent'
  const conversation = body.conversation ? String(body.conversation).trim() : null
  const readWhen = body.readWhen ? String(body.readWhen).trim().slice(0, 300) : null
  if (!agent) throw new LessonError(400, 'agent is required')
  if (!agents.some(a => a.id === agent)) throw new LessonError(400, `no agent ${agent} in the roster`)
  if (text.length < 12) throw new LessonError(400, 'text is required (at least a sentence)')
  if (text.length > 8000) throw new LessonError(413, 'text over 8000 characters: file a book instead')
  if (!(SCOPES as readonly string[]).includes(scope) && !/^[\w./-]+$/.test(scope)) throw new LessonError(400, 'scope is agent, role, fund or a fund-relative path')
  const id = await ops.addLesson(agent, text, { conversationId: conversation, scope, readWhen, ts: now }, db)
  return { id, ts: now, agent, conversation, text, scope, readWhen, state: 'open', proposal: null }
}

export async function listInbox(db: Queryable, sinceMs: number | null = null): Promise<InboxLesson[]> {
  const rows = await ops.lessonsSince({ since: sinceMs ?? 0, limit: 500 }, db)
  return rows.map(r => ({ id: r.id, ts: r.ts, agent: r.agent_id, conversation: r.conversation_id, text: r.text, scope: r.scope, readWhen: r.read_when, state: r.state, proposal: r.proposal }))
}

export async function setLessonState(db: Queryable, id: number, state: 'open' | 'promoted' | 'dismissed', proposal: string | null = null) {
  if (!Number.isSafeInteger(id)) throw new LessonError(404, `no lesson ${id}`)
  const r = await ops.setLessonState(id, state, proposal !== null ? { proposal } : {}, db)
  if (!r) throw new LessonError(404, `no lesson ${id}`)
}

/** a lesson's one-line title: its first sentence, cut at 90 characters */
export function titleOf(text: string): string {
  const first = text.replace(/^#+\s*/, '').split(/\n|(?<=[.!?])\s/)[0].trim()
  return first.length > 90 ? first.slice(0, 87).replace(/\s+\S*$/, '') + '...' : first
}

export function fromInbox(l: InboxLesson): Captured {
  return { key: `inbox:${l.id}`, source: 'inbox', ts: l.ts, agent: l.agent, title: titleOf(l.text), text: l.text, readWhen: l.readWhen, ref: l.conversation ?? '', state: l.state }
}

/** the book's H1 and its first prose paragraph, read from the tree as it is now */
export function bookGist(fundRoot: string, path: string): { title: string; text: string } | null {
  let raw: string
  try { raw = readFileSync(join(fundRoot, path), 'utf8') } catch { return null }
  const body = raw.replace(/\r\n/g, '\n').replace(/^---\n[\s\S]*?\n---\n/, '')
  const h1 = /^#\s+(.+)$/m.exec(body)?.[1]?.trim()
  const paras = body.split(/\n{2,}/).map(p => p.trim()).filter(p => p && !p.startsWith('#') && !p.startsWith('|') && !p.startsWith('```'))
  const name = path.split('/').pop()!.replace(/\.md$/i, '').replace(/[-_]+/g, ' ')
  return { title: h1 ?? name, text: (paras[0] ?? '').slice(0, 1200) }
}

/**
 * A chapter appended to a book, read from the tree as it is now: its title, its Read when line and its
 * first prose paragraph. null = the heading is gone (reworded or removed since) or sits in a code fence.
 */
export function chapterGist(fundRoot: string, path: string, heading: string): { slug: string; title: string; text: string; readWhen: string } | null {
  let raw: string
  try { raw = readFileSync(join(fundRoot, path), 'utf8') } catch { return null }
  const want = slugOf(heading)
  const ch = chaptersOf(raw.replace(/\r\n/g, '\n')).find(c => c.slug === want)
  if (!ch) return null
  const paras = ch.text.split(/\n{2,}/).map(p => p.trim()).filter(p => p && !p.startsWith('#') && !p.startsWith('|') && !p.startsWith('```') && !/^Read when:/i.test(p))
  return { slug: ch.slug, title: ch.title, text: (paras[0] ?? '').slice(0, 1200), readWhen: ch.readWhen }
}

/**
 * Every book ADDED by a commit, and every `## ` chapter APPENDED to an existing book (B-0347, the
 * library is one file of chapters per topic), is a captured lesson. The filer is the commit's Agent: trailer,
 * else the agent whose writes cover the book, else nobody (the owner filed it by hand).
 */
export function fromGit(fundRoot: string, commits: GitLesson[], agents: Agent[]): Captured[] {
  const out: Captured[] = []
  const seen = new Set<string>()
  for (const c of commits) {
    // a commit that adds many books at once is a move or a cut-over (2026-09-24 moved every book
    // into library/, 2026-09-25 carried it into app/library/ and platform/library/, and 2026-09-26 made app/library/
    // the one library), not a lesson learned; a desk-law.md is a desk's constitution, not a lesson
    const added = c.books.filter(b => b.status === 'A' && !b.index)
    const appended = c.books.filter(b => b.status === 'M' && !b.index && b.chapters?.length && !/(^|\/)desk-law\.md$/i.test(b.path))
    // the same bound for chapters: a commit that appends more than five is a reorganization
    if (added.length + appended.reduce((n, b) => n + b.chapters!.length, 0) > MAX_BOOKS_PER_LESSON) continue
    for (const b of c.books) {
      if (b.status !== 'A' || b.index || seen.has(b.path) || /(^|\/)desk-law\.md$/i.test(b.path)) continue
      seen.add(b.path)
      const gist = bookGist(fundRoot, b.path)
      if (!gist) continue    // added then deleted or moved: nothing left to promote
      const trailer = c.agent && agents.some(a => a.id === c.agent) ? c.agent : null
      const owner = trailer ?? (c.agent === null ? ownerOfBook(b.path, agents) : null)
      out.push({ key: `git:${c.sha.slice(0, 12)}:${b.path}`, source: 'git', ts: c.ts, agent: owner, title: gist.title, text: gist.text, readWhen: null, ref: b.path, state: 'open' })
    }
    for (const b of appended) {
      for (const heading of b.chapters!) {
        const ch = chapterGist(fundRoot, b.path, heading)
        if (!ch) continue    // reworded or removed since: nothing left to promote
        const ref = `${b.path}#${ch.slug}`
        if (seen.has(ref)) continue
        seen.add(ref)
        const trailer = c.agent && agents.some(a => a.id === c.agent) ? c.agent : null
        const owner = trailer ?? (c.agent === null ? ownerOfBook(b.path, agents) : null)
        out.push({ key: `git:${c.sha.slice(0, 12)}:${ref}`, source: 'git', ts: c.ts, agent: owner, title: ch.title, text: ch.text, readWhen: ch.readWhen || null, ref, state: 'open' })
      }
    }
  }
  return out
}

/** a write scope over a WHOLE library home (the fund agent's app/library/, the old root library/):
 *  it owns every shelf, so it names no book's filer */
const BLANKET = new Set(['library/', 'app/library/'])

/** an agent whose OWN writes cover the book (a blanket over a whole library home does not count) */
function ownerOfBook(path: string, agents: Agent[]): string | null {
  return ownerOf(path, agents.map(a => ({ ...a, writes: (a.writes ?? []).filter(w => !BLANKET.has(w.replace(/\\/g, '/'))) })))
}
