// The command bar's model (pure, tested in test/shell-command.test.ts): every row the rooms offer,
// sorted into a few fixed sections, matched against the query, capped per section. The view
// (Palette.tsx) only draws what `arrange` returns and walks it with the arrow keys.

export type SectionId = 'Recent' | 'Agents' | 'Dashboards' | 'Board' | 'Books' | 'Runs' | 'Actions' | 'Keys'
export const SECTION_ORDER: SectionId[] = ['Recent', 'Agents', 'Dashboards', 'Board', 'Books', 'Runs', 'Actions', 'Keys']

/** EVERY key the cockpit binds (Shell.tsx), listed in the command bar's Keys section. There are
 *  only these; a new one is a decision, not a convenience */
export const KEYS = [
  { id: 'bar', label: 'Command bar', keys: 'Ctrl K · Ctrl P' },
  { id: 'list', label: 'Side list', keys: 'Ctrl B' },
  { id: 'close', label: 'Close', hint: 'drawer, bar or a focused column', keys: 'Esc' },
] as const

export type Cmd = {
  section: SectionId
  label: string
  hint?: string
  /** the square on the left: two letters (or one glyph) in a colour */
  mark?: { text: string; color?: string }
  /** a live dot on the right: run / ask / ok / off */
  dot?: string
  /** a key hint on the right, always shown ("Ctrl B") */
  keys?: string
  /** what Enter does on this row, shown only while it is the highlighted row ("Open") */
  verb?: string
  /** pinned to the top of the idle list (the few actions the owner reaches for first) */
  pin?: boolean
  run: () => void
}

/** a room's PaletteItem.kind -> the section it lands in ('chat' is built by the shell itself) */
export function sectionOf(kind: string): SectionId {
  switch (kind) {
    case 'dash': return 'Dashboards'
    case 'board': return 'Board'
    case 'book': case 'text': return 'Books'
    case 'run': return 'Runs'
    default: return 'Actions'
  }
}

/** rows per section when nothing is typed, and when something is */
const CAP_IDLE: Record<SectionId, number> = { Recent: 6, Agents: 6, Dashboards: 8, Board: 5, Books: 4, Runs: 3, Actions: 14, Keys: 3 }
const CAP_QUERY = 8

/** every word of the query must appear in the row's label or hint (never the section's name:
 *  "board" must not match every Dashboards row) */
export function matches(c: Cmd, q: string): boolean {
  const hay = `${c.label} ${c.hint ?? ''} ${c.keys ?? ''}`.toLowerCase()
  return q.toLowerCase().split(/\s+/).filter(Boolean).every(w => hay.includes(w))
}

/** 0 = the label (or, for "Go to X", the room name X) IS the query, 1 = starts with it, 2 = neither */
export function nameRank(c: Cmd, t: string): number {
  const l = c.label.toLowerCase()
  const names = [l, l.replace(/^go to /, '')]
  return names.includes(t) ? 0 : names.some(n => n.startsWith(t)) ? 1 : 2
}

export type Group = { section: SectionId; items: Cmd[] }

/** `extra` = rows already matched server-side (full-text book hits): never re-filtered */
export function arrange(all: Cmd[], q: string, extra: Cmd[] = []): Group[] {
  const t = q.trim().toLowerCase()
  const out: Group[] = []
  // nothing typed: the pinned actions lead, so they are on the first screen
  const pinned = t ? [] : all.filter(c => c.pin)
  if (pinned.length) out.push({ section: 'Actions', items: pinned.slice(0, 3) })
  for (const s of SECTION_ORDER) {
    let rows = all.filter(c => c.section === s && !(pinned.length && c.pin))
    if (t) {
      rows = rows.filter(c => matches(c, t))
      rows = rows.map(c => ({ c, r: nameRank(c, t) })).sort((a, b) => a.r - b.r).map(x => x.c)
      const seen = new Set(rows.map(c => c.label))
      rows = [...rows, ...extra.filter(c => c.section === s && !seen.has(c.label))]
    }
    rows = rows.slice(0, t ? CAP_QUERY : CAP_IDLE[s])
    if (rows.length) out.push({ section: s, items: rows })
  }
  if (!t) return out
  // a typed query: the section holding an exact name, then a name that starts with the query,
  // leads the whole list, so "board" goes to the Board room and not to a book that merely
  // mentions it. On a tie a room leads, and an Agents row (Enter = a NEW conversation) never leads: a plain search
  // must not start a chat as its first result (sort is stable: otherwise SECTION_ORDER stands)
  // and on a tie a room ("Go to X") leads everything else
  const rank = (g: Group) => Math.min(...g.items.map(c => nameRank(c, t) * 3 + (/^go to /i.test(c.label) ? 0 : g.section === 'Agents' ? 2 : 1)))
  return out.map(g => ({ g, r: rank(g) })).sort((a, b) => a.r - b.r).map(x => x.g)
}

/** the flat order the arrow keys walk */
export const flat = (gs: Group[]): Cmd[] => gs.flatMap(g => g.items)

/** a conversation's state -> its live dot */
export const convDot = (state: string): string => (state === 'live' ? 'run' : state === 'waiting' ? 'ask' : state === 'idle' ? 'ok' : 'off')
