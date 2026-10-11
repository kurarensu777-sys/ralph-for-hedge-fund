import type { Router } from '../http.ts'
import type { ServiceGroup } from '../../shared/types.ts'
import * as A from '../data/archive.ts'
import * as S from '../data/storage.ts'

// ROOM: data - the storage view (B-0327: the cache against its budget, the pins, the archive; evict
// to budget) and the archive's retention. Every route is behind the one gate (server/gate.ts:
// loopback Host, a cockpit Origin on anything that changes, a JSON body); every change is a plan the
// server holds, then an apply that names it. Server: server/data/ (storage.ts the cache, pins and
// eviction; archive.ts the usage read and retention; plans.ts the pure half; job.ts the door, a
// process). UI: src/rooms/data/.

const flag = (q: URLSearchParams, k: string) => q.get(k) === '1'

export function register(r: Router) {
  r.get('/api/data/usage', ({ query }) => A.usage(flag(query, 'fresh')))
  r.get('/api/data/storage', () => S.storage())

  r.post('/api/data/retention/plan', async ({ body }) => A.retentionPlan(await body()))
  r.post('/api/data/retention/apply', async ({ body }) => A.retentionApply(await body()))
  r.post('/api/data/cache/evict/plan', async ({ body }) => S.evictPlan(await body()))
  r.post('/api/data/cache/evict/apply', async ({ body }) => S.evictApply(await body()))
}

/** the archive is not a service the cockpit runs */
export async function services(): Promise<ServiceGroup | null> { return null }
