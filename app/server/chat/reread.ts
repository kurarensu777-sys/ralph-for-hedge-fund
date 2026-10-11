import { readFileSync } from 'node:fs'
import { ops, settled } from '../db.ts'
import { inFund } from '../paths.ts'
import { agent as configAgent } from '../config.ts'
import { getRow } from './store.ts'

// RE-READ AFTER COMPACTION. When a seat's context is compacted the books it PULLED during the
// conversation are summarised away; the boot books, the brief and the persona survive in
// systemPrompt.append. So the SessionStart hook (matcher 'compact', launch.ts) hands back the full
// text of every library book this conversation pulled (reads.at_boot = 0), newest pull first, up
// to the library's boot token budget; past the cap the rest are LISTED so the seat can re-read
// them. A book gone from disk is named, never dropped. No user message is ever sent.

/** the RE-READ budget after a compaction, in tokens: how much of the pulled books goes back into the context. It is
 *  not the boot cap (context-caps.json "boot": what a boot may load before the first word); it was the old boot
 *  budget's number and stays so, so moving the boot cap never changes what compaction restores. */
export const REREAD_STANDING = 12_000
export const REREAD_DASHBOARD = 8_000
export const rereadBudgetFor = (a: { kind: string }) => (a.kind === 'dashboard' ? REREAD_DASHBOARD : REREAD_STANDING)

export type RereadBook = { path: string; title: string; tokens: number; state: 'restored' | 'listed' | 'missing' }
export type Reread = { text: string; books: RereadBook[]; restored: number; budget: number }

const tok = (s: string) => Math.round(s.length / 4)

/** a book's display title: its first `# ` heading, else the file name */
export function titleOf(path: string, text: string | null): string {
  const h = text?.match(/^#\s+(.+?)\s*$/m)?.[1]
  return h || (path.split('/').pop() ?? path).replace(/\.md$/i, '')
}

/** the conversation's pulled books, most recent pull first (one row per path) */
export async function pulledBooks(conversationId: string): Promise<string[]> {
  await settled()
  return ops.booksReadInConversation(conversationId)
}

/** the re-read budget of the conversation's seat (standing when unknown) */
async function budgetOf(conversationId: string): Promise<number> {
  try {
    const row = await getRow(conversationId)
    const a = row ? configAgent(row.agent_id) : null
    return a ? rereadBudgetFor(a) : REREAD_STANDING
  } catch { return REREAD_STANDING }
}

type Reader = (path: string) => string | null
const readFund: Reader = p => { const abs = inFund(p); if (!abs) return null; try { return readFileSync(abs, 'utf8') } catch { return null } }

/** PURE over (paths, reader, budget): what goes back into the context, and the ledger of it */
export function assemble(paths: string[], read: Reader, budget: number): Reread {
  const books: RereadBook[] = []
  const parts: string[] = []
  let used = 0
  for (const p of paths) {
    const text = read(p)
    if (text === null) { books.push({ path: p, title: titleOf(p, null), tokens: 0, state: 'missing' }); continue }
    const t = tok(text)
    if (used + t <= budget) {
      used += t
      books.push({ path: p, title: titleOf(p, text), tokens: t, state: 'restored' })
      parts.push(`# Book ${p}\n\n${text}`)
    } else books.push({ path: p, title: titleOf(p, text), tokens: t, state: 'listed' })
  }
  const listed = books.filter(b => b.state === 'listed')
  const missing = books.filter(b => b.state === 'missing')
  const restored = books.length - listed.length - missing.length
  if (!books.length) return { text: '', books, restored: 0, budget }
  const head = `# Books you pulled earlier in this conversation (restored after compaction)\n\n${restored} restored in full, newest pull first.`
  const tail: string[] = []
  if (listed.length) tail.push(`## Pulled earlier, re-read if needed\n\n${listed.map(b => `- ${b.path} (~${b.tokens} tok)`).join('\n')}`)
  if (missing.length) tail.push(`## Pulled earlier, missing on disk now\n\n${missing.map(b => `- ${b.path}`).join('\n')}`)
  return { text: [head, ...parts, ...tail].join('\n\n---\n\n'), books, restored, budget }
}

/** the additionalContext for a compacted seat (empty text when it pulled nothing) */
export async function rereadContext(conversationId: string, read: Reader = readFund, budget?: number): Promise<Reread> {
  return assemble(await pulledBooks(conversationId), read, budget ?? await budgetOf(conversationId))
}

/** the feed divider for a compaction: one line, the titles ride in meta.books */
export function dividerText(r: Pick<Reread, 'restored'>): string {
  return `compacted · ${r.restored} book${r.restored === 1 ? '' : 's'} restored`
}
