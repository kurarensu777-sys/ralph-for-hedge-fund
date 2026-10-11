import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Router } from '../http.ts'
import { HttpError } from '../http.ts'
import type { ServiceGroup } from '../../shared/types.ts'
import { publish } from '../events.ts'
import { FUND_ROOT, VET_FILE_REL } from '../paths.ts'
import { bookDetail, bookOutcomesPayload, editBook, listAgents, listBooks, retireBook, searchBooks, setBoot, startLibrary, unretireBook, vetList } from '../library/core.ts'
import { dismissDraft, editDraft, haiku, listDrafts, saveDraft, scan } from '../library/drafts.ts'
import { db } from '../db.ts'
import { config } from '../config.ts'
import { transcriptPath } from '../chat/store.ts'
import { recordRead } from '../library/reads.ts'
import { links } from '../library/links.ts'

// a burst of reads (an agent paging through a series) refetches the room once
let readPub: ReturnType<typeof setTimeout> | null = null
function readPublish() {
  if (readPub) return
  readPub = setTimeout(() => { readPub = null; publish('library') }, 1500)
}

// ROOM: library - the shelves, the books, and which agent must read what at boot.
export function register(r: Router) {
  startLibrary()
  r.get('/api/library/books', () => listBooks())
  r.get('/api/library/book', ({ query }) => {
    const path = query.get('path')
    if (!path) throw new HttpError(400, 'need ?path=')
    return bookDetail(path)
  })
  r.get('/api/library/agents', async () => ({ agents: await listAgents() }))
  r.patch('/api/library/boot', async ({ body }) => {
    const b = await body()
    return setBoot(b?.agent, b?.path, b?.on)
  })
  // the Read hook (scripts/hooks/read-hook.mjs): one pull of a library/ or lab/ .md by an agent
  r.post('/api/library/read', async ({ body }) => {
    const out = await recordRead(await body())
    if (out.recorded) readPublish()
    return out
  })
  r.get('/api/library/search', ({ query }) => {
    const q = (query.get('q') ?? '').slice(0, 200)
    const limit = Math.max(1, Math.min(200, Number(query.get('limit')) || 50))
    return searchBooks(q, limit)
  })
  r.post('/api/library/save', async ({ body }) => editBook(await body()))
  // helpful / harmful per book + the retire queue
  r.get('/api/library/outcomes', () => bookOutcomesPayload())
  r.post('/api/library/retire', async ({ body }) => { const b = await body(); return retireBook(b?.path, b?.note) })
  r.post('/api/library/unretire', async ({ body }) => { const b = await body(); return unretireBook(b?.path) })

  // drafted books from owner corrections: nothing is written until the owner saves one
  r.get('/api/library/drafts', () => listDrafts(db))
  r.post('/api/library/drafts/scan', async () => {
    const res = await scan({ db, agents: config.agents(), shelves: config.shelves(), fundRoot: FUND_ROOT, llm: haiku, now: Date.now(), fileOf: transcriptPath })
    if (res.found) publish('library')
    return { ...res, notes: res.notes.map(n => ({ ...n })) }
  })
  r.post('/api/library/drafts/:id/:action', async ({ params, body }) => {
    const id = Number(params.id)
    if (!Number.isInteger(id)) throw new HttpError(400, 'draft id is a number')
    let out
    switch (params.action) {
      case 'save': out = await saveDraft(db, id, FUND_ROOT, config.shelves()); publish('git'); break
      case 'dismiss': out = await dismissDraft(db, id); break
      case 'edit': out = await editDraft(db, id, await body(), config.shelves()); break
      default: throw new HttpError(404, 'action is save, dismiss or edit')
    }
    publish('library')
    return out
  })
  // the link audit: read-only, cached, cleared by the library watcher
  r.get('/api/library/links', () => links(FUND_ROOT, config.shelves(), config.agents()))
  r.get('/api/library/vet', () => ({ present: existsSync(join(FUND_ROOT, VET_FILE_REL)), rows: vetList() }))
}

/** the library is not a service */
export async function services(): Promise<ServiceGroup | null> { return null }
