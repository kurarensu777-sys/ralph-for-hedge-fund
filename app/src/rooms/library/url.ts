import type { Need, Read, Kind, View } from './state.ts'

// The Library's view in the URL hash, so a filtered view can be shared and reloaded: `#/library?shelf=law&type=guide&q=deny`.
// Pure (test/library-ui.test.ts). A key that is absent is the default; a value that is not one of the room's own
// is dropped, so an old or edited link opens the default view and never a state the room cannot draw.

export type UrlState = {
  view: View; shelf: string | null; agent: string | null; q: string; text: boolean
  topics: string[]; who: string | null; need: Need; read: Read; type: Kind; hide: boolean
}

const VIEWS: View[] = ['shelves', 'agents', 'readers', 'retire', 'drafts', 'links']
const NEEDS: Need[] = ['', 'boot', 'recall', 'must', 'opt']
const READS: Read[] = ['', 'p30', 'b30', 'never']
const KINDS: Kind[] = ['', 'guide', 'strategy']

export const DEFAULT_URL: UrlState = { view: 'shelves', shelf: null, agent: null, q: '', text: false, topics: [], who: null, need: '', read: '', type: '', hide: false }

/** the facets as a query string: only what differs from the default, in a fixed order (so equal views are equal strings) */
export function encodeFacets(s: UrlState): string {
  const p = new URLSearchParams()
  if (s.view !== DEFAULT_URL.view) p.set('view', s.view)
  if (s.shelf) p.set('shelf', s.shelf)
  if (s.type) p.set('type', s.type)
  for (const t of s.topics) p.append('topic', t)
  if (s.who) p.set('who', s.who)
  if (s.need) p.set('need', s.need)
  if (s.read) p.set('read', s.read)
  if (s.q.trim()) p.set('q', s.q)
  if (s.text) p.set('text', '1')
  if (s.hide) p.set('hide', '1')
  if (s.agent) p.set('agent', s.agent)
  return p.toString()
}

const pick = <T extends string>(v: string | null, ok: readonly T[], def: T): T => (v !== null && (ok as readonly string[]).includes(v) ? (v as T) : def)

/** the query string back to a full state (every field present: a link names the whole view) */
export function decodeFacets(query: string): UrlState {
  const p = new URLSearchParams(query)
  return {
    view: pick(p.get('view'), VIEWS, DEFAULT_URL.view),
    shelf: p.get('shelf') || null,
    agent: p.get('agent') || null,
    q: p.get('q') ?? '',
    text: p.get('text') === '1',
    topics: p.getAll('topic').filter(Boolean),
    who: p.get('who') || null,
    need: pick(p.get('need'), NEEDS, ''),
    read: pick(p.get('read'), READS, ''),
    type: pick(p.get('type'), KINDS, ''),
    hide: p.get('hide') === '1',
  }
}

export const sameFacets = (a: UrlState, b: UrlState) => encodeFacets(a) === encodeFacets(b)
