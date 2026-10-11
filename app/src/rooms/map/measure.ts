import type { MapNode } from '../../../shared/map.ts'

// THE MAP'S TEXT MEASURE (pure, tested in test/map.test.ts). A node's box is sized before it is
// drawn, so the width its text needs is estimated here from the fonts map.css sets, never read off
// the page. The estimate is deliberately WIDE (the widest face in each stack, a margin on top): a
// box a few pixels roomy is invisible, a label cut to 'libra...' is a defect. The render check reads
// the real widths back (scrollWidth against clientWidth) to hold the estimate honest.

/** the type sizes of src/styles.css (--fs-*), in px */
export const FS = { cap: 9.5, xs: 10.5, sm: 11.5, md: 12.5, lg: 13.5 } as const

// IBM Plex Sans / Segoe UI at 600, in em, by character class (the wider of the two faces)
const NARROW = new Set([...'iljI.,:;|!\'`'])
const SLIM = new Set([...'frt()[]{}/\-" '])
const WIDE = new Set([...'mwMW@%'])
function sansEm(ch: string): number {
  if (NARROW.has(ch)) return 0.3
  if (SLIM.has(ch)) return 0.4
  if (WIDE.has(ch)) return 0.9
  if (/[A-Z]/.test(ch)) return 0.7
  if (/[0-9]/.test(ch)) return 0.6
  if (/[a-z]/.test(ch)) return 0.58
  return 0.65
}
const SAFETY = 1.06

/** the width a string needs in the map's sans (600) or mono face at `px`; `track` = letter-spacing in em */
export function textWidth(s: string, px: number, face: 'sans' | 'mono', track = 0): number {
  const chars = [...s]
  // JetBrains Mono advances 0.6em per character (Consolas, the fallback, 0.55em)
  const em = face === 'mono' ? chars.length * 0.6 : chars.reduce((a, c) => a + sansEm(c), 0)
  return Math.ceil((em + track * chars.length) * px * SAFETY)
}

const MONO_KINDS: MapNode['kind'][] = ['dir', 'agent', 'worktree', 'remote']
const DOT = 7, GAP_H = 6, ALSO_D = 6, ALSO_GAP = 2
/** a leaf's horizontal chrome: 1px borders and 9px padding each side (map.css .map-n) */
export const LEAF_CHROME = 20
/** a group's title band: 1px borders, 12px padding each side, 7px between its parts (map.css .map-g, .map-g-h) */
export const GROUP_CHROME = 26

/** the label as the node draws it, in its face and size */
export function labelFont(n: Pick<MapNode, 'kind'>): { px: number; face: 'sans' | 'mono' } {
  return MONO_KINDS.includes(n.kind) ? { px: FS.sm, face: 'mono' } : { px: FS.md, face: 'sans' }
}

/** whether the node draws a status dot beside its label (Canvas.tsx Box / Group) */
const hasDot = (n: Pick<MapNode, 'state' | 'dashboard'>) => !!n.state || !!n.dashboard

/** the "also written by" dots the Owners overlay adds after a label: four at most, then `+N`. The
 *  room is kept whether the overlay is on or not, so turning it on never re-lays the map */
export function alsoWidth(also: string[] | undefined): number {
  const k = also?.length ?? 0
  if (!k) return 0
  const dots = Math.min(k, 4) * ALSO_D + (Math.min(k, 4) - 1) * ALSO_GAP
  const more = k > 4 ? 2 + textWidth(`+${k - 4}`, FS.cap, 'mono') : 0
  return GAP_H + dots + more
}

/** the width a leaf needs so its label and every sub line show whole */
export function leafWidth(n: Pick<MapNode, 'kind' | 'label' | 'sub' | 'also' | 'state' | 'dashboard'>): number {
  const f = labelFont(n)
  const head = (hasDot(n) ? DOT + GAP_H : 0) + textWidth(n.label, f.px, f.face) + alsoWidth(n.also)
  // a one-line box (an agent, a folder) draws no sub line: Canvas.tsx ONE_LINE
  const subs = n.kind === 'agent' || n.kind === 'dir' ? [] : (n.sub ?? []).map(s => textWidth(s, FS.xs, 'mono'))
  return LEAF_CHROME + Math.max(head, ...subs)
}

/** the width a group's (or a repo's) title band needs: dot, name, then its sub line (a repo's sits
 *  on a line of its own under the name) */
export function groupWidth(n: Pick<MapNode, 'kind' | 'label' | 'sub' | 'state' | 'parent'>): number {
  const top = !n.parent && n.kind === 'group'
  const name = top ? textWidth(n.label.toUpperCase(), FS.cap, 'mono', 0.1) : textWidth(n.label, FS.md, 'sans')
  const dot = n.state ? DOT + 7 : 0
  const sub = n.sub?.[0] ? textWidth(n.sub[0], FS.xs, 'mono') : 0
  return GROUP_CHROME + (n.kind === 'repo' ? Math.max(dot + name, sub) : dot + name + (sub ? 7 + sub : 0))
}

/** a stage's number, name and (Owners) glyph: map.css .map-stage-h */
function stageHead(n: Pick<MapNode, 'label' | 'n'>): number {
  return textWidth(String(n.n ?? ''), FS.sm, 'mono') + GAP_H + textWidth(n.label, FS.lg, 'sans') + GAP_H + 15
}
/** the down row's first column (map.css .map-stage-row: 190px | 118px | the holds) */
export const STAGE_COL1 = 190
const STAGE_COL2 = 118
/** the width a stage needs: side by side its name (what it holds wraps, holdLines); one under another
 *  its name must fit the row's first column (held by the test) and the holds the rest of the row */
export function stageWidth(n: Pick<MapNode, 'label' | 'n' | 'holds'>, pipe: 'right' | 'down'): number {
  if (pipe === 'right') return 22 + stageHead(n)
  return 26 + STAGE_COL1 + STAGE_COL2 + textWidth((n.holds ?? []).join(' · '), FS.sm, 'sans')
}

/** how many lines a text takes wrapped at `room` px, word by word (a word longer than the room
 *  breaks, map.css overflow-wrap: anywhere) */
export function wrapLines(text: string, room: number, px: number, face: 'sans' | 'mono'): number {
  let lines = 1, line = ''
  for (const w of text.split(/s+/).filter(Boolean)) {
    const next = line ? `${line} ${w}` : w
    if (textWidth(next, px, face) <= room) { line = next; continue }
    if (line) lines++
    line = w
    while (textWidth(line, px, face) > room && line.length > 1) {
      let k = line.length
      while (k > 1 && textWidth(line.slice(0, k), px, face) > room) k--
      lines++
      line = line.slice(k)
    }
  }
  return lines
}

/** the lines a side-by-side stage's holds take in a box `w` wide (.map-stage-holds li, wrapping) */
export function holdLines(n: Pick<MapNode, 'holds'>, w: number): number {
  return (n.holds ?? []).reduce((a, h) => a + wrapLines(h, w - 22, FS.sm, 'sans'), 0)
}
/** what a stage's name needs in the down row's first column */
export const stageLabelWidth = stageHead
