// The CEO board's shapes and its one ordering (pure: the cockpit's lane and the rail dock both
// draw from it, and test/board-ceo.test.ts holds it). The store is server/board/ceo.ts.

export const CEO_STATUSES = ['open', 'done'] as const
export const CEO_PRIORITIES = ['p0', 'p1', 'p2'] as const

export type CeoItem = {
  id: string                       // C-0001
  title: string
  status: (typeof CEO_STATUSES)[number]
  priority: (typeof CEO_PRIORITIES)[number]
  due: string                      // YYYY-MM-DD, or '' for none
  agent: string                    // the roster agent whose chat this issue gets, or '' until one is picked
  conversation: string             // the ONE chat of this issue, or '' until it is first opened
  from: string                     // who filed it: 'you', or the agent the owner told to
  told: string                     // the owner's words an agent filed on, or ''
  created: string
  updated: string
  body: string
}
export type CeoListed = CeoItem & { notes: number }
export type CeoFull = CeoItem & { text: string; notes: { ts: string; who: string; text: string }[] }

/** a chat's state as the Chats room reports it; null = no chat yet, or the list has not named it */
export type ChatState = 'live' | 'waiting' | 'idle' | 'closed' | null

const PRI = { p0: 0, p1: 1, p2: 2 } as const

/** an issue in order: its chat is waiting on the owner first, then p0 before p1 before p2, then the
 *  earliest due date (none last), then the newest. Done issues are not ordered here (they fold). */
export function ceoOrder<T extends Pick<CeoItem, 'id' | 'priority' | 'due' | 'created'>>(items: T[], stateOf: (i: T) => ChatState): T[] {
  const key = (i: T) => [stateOf(i) === 'waiting' ? 0 : 1, PRI[i.priority] ?? 2, i.due || '9999-99-99']
  return [...items].sort((a, b) => {
    const ka = key(a), kb = key(b)
    for (let n = 0; n < ka.length; n++) if (ka[n] !== kb[n]) return ka[n] < kb[n] ? -1 : 1
    return b.created.localeCompare(a.created) || b.id.localeCompare(a.id, 'en', { numeric: true })
  })
}

/** a quick-add line: "@research check the gate" files for research (when it is on the roster), anything else
 *  for `pick`. null when there is no title to file. */
export function parseQuickAdd(text: string, known: string[], pick: string): { title: string; agent: string; named: boolean } | null {
  const m = /^@(\S+)\s+(.+)$/s.exec(text.trim())
  const named = !!m && known.includes(m[1])
  const title = (named ? m![2] : text).trim()
  return title ? { title, agent: named ? m![1] : pick, named } : null
}

/** local YYYY-MM-DD of a moment (the owner's day, as the cockpit counts spend) */
export const localDay = (t: number) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }

/** how a due date reads against today: 'late', 'today', or 'soon' (within 3 days); '' when none or later */
export function dueTone(due: string, now: number = Date.now()): 'late' | 'today' | 'soon' | '' {
  if (!/^\d{4}-\d\d-\d\d$/.test(due)) return ''
  const today = localDay(now)
  if (due < today) return 'late'
  if (due === today) return 'today'
  return due <= localDay(now + 3 * 86_400_000) ? 'soon' : ''
}

/** the chip's word for a due date: 'today', 'late', a weekday inside a week, else the date */
export function dueLabel(due: string, now: number = Date.now()): string {
  const tone = dueTone(due, now)
  if (!tone && !/^\d{4}-\d\d-\d\d$/.test(due)) return ''
  if (tone === 'today') return 'today'
  if (tone === 'late') return `late ${due.slice(5)}`
  const days = Math.round((Date.parse(`${due}T00:00:00`) - Date.parse(`${localDay(now)}T00:00:00`)) / 86_400_000)
  return days < 7 ? new Date(`${due}T00:00:00`).toLocaleDateString('en', { weekday: 'short' }) : due.slice(5)
}
