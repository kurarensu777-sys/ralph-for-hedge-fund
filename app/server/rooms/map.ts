import type { Router } from '../http.ts'
import type { ServiceGroup } from '../../shared/types.ts'
import { cachedMap } from '../map/read.ts'

// ROOM: map - the fund as a graph (B-0207): Repos, System, Pipeline, generated from the files.
export function register(r: Router) {
  r.get('/api/map', ({ query }) => cachedMap(query.get('fresh') === '1'))
}

/** the map is a picture, not a service */
export async function services(): Promise<ServiceGroup | null> { return null }
