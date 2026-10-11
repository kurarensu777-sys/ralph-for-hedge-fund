import type { Queryable } from '../db.ts'
import { HttpError, type Router } from '../http.ts'
import { GradeError, grade, gradesOf, queue } from './turns.ts'

/**
 * The review routes, on any store handle (the room passes the cockpit's; a test its own database):
 *   GET  /api/loop/queue               open turns newest first, then the last graded (for undo)
 *   POST /api/loop/grade               {conv, turn, value: good|bad|null (undo), label?}
 *   GET  /api/loop/grades?conv=<id>    one conversation's turns and their grades (Chats dots)
 */
export function registerReview(r: Router, o: { db: Queryable; sweep?: () => Promise<unknown>; publish?: (topic: string, data?: unknown) => void }) {
  r.get('/api/loop/queue', async () => {
    if (o.sweep) await o.sweep()
    return queue(o.db)
  })

  r.post('/api/loop/grade', async ({ body }) => {
    const b = await body().catch(() => ({}))
    try {
      const g = await grade(o.db, b ?? {})
      o.publish?.('loop', { grade: `${g.conv}#${g.turn}` })
      return g
    } catch (e) {
      if (e instanceof GradeError) throw new HttpError(e.status, e.message)
      throw e
    }
  })

  r.get('/api/loop/grades', async ({ query }) => {
    const conv = query.get('conv') ?? ''
    if (!conv) throw new HttpError(400, 'conv is required')
    return { conv, turns: await gradesOf(o.db, conv) }
  })
}
