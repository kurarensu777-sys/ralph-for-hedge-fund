import type { CSSProperties } from 'react'

// The one colour per agent category (the owner's approved card groups, 2026-09-25). Every place
// that paints an agent - the chats side list, the command bar, the activity island, the board -
// reads it here. A category colour means "whose work this is", never a state: state keeps the
// ok / warn / fail / run / ask dots.

export type CategoryId = 'fund' | 'app' | 'platform' | 'database' | 'research' | 'dashboards' | 'execution'

export type Category = {
  id: CategoryId
  /** lower-case id-like label */
  label: string
  /** display name for a header */
  name: string
  /** two letters for the icon square */
  abbr: string
  /** the category colour (hex, so a caller can mix alpha: `${color}22`) */
  color: string
  /** a 16x16 stroke path (viewBox 0 0 16 16), for a place that wants a glyph instead of letters */
  icon: string
}

export const CATEGORIES: Record<CategoryId, Category> = {
  fund: { id: 'fund', label: 'fund', name: 'Fund', abbr: 'FU', color: '#d9b35b', icon: 'M8 2l5.5 3v1H2.5V5zM3.5 7v5M6.5 7v5M9.5 7v5M12.5 7v5M2 13.5h12' },
  app: { id: 'app', label: 'app', name: 'App', abbr: 'AP', color: '#8b8cf7', icon: 'M2.5 3.5h11v9h-11zM2.5 6h11M6 6v6.5' },
  platform: { id: 'platform', label: 'platform', name: 'Platform', abbr: 'PL', color: '#4fb3c9', icon: 'M8 2.5c3 0 5.5.9 5.5 2s-2.5 2-5.5 2-5.5-.9-5.5-2 2.5-2 5.5-2zM2.5 4.5v7c0 1.1 2.5 2 5.5 2s5.5-.9 5.5-2v-7M2.5 8c0 1.1 2.5 2 5.5 2s5.5-.9 5.5-2' },
  database: { id: 'database', label: 'database', name: 'Database', abbr: 'DB', color: '#c98a5b', icon: 'M3 3h10v4H3zM3 9h10v4H3zM5.5 5h.01M5.5 11h.01' },
  research: { id: 'research', label: 'research', name: 'Research', abbr: 'RS', color: '#6fd49a', icon: 'M6 2.5h4M6.5 2.5v4L3 12.5c-.4.7.1 1 .8 1h8.4c.7 0 1.2-.3.8-1L9.5 6.5v-4M5 10h6' },
  dashboards: { id: 'dashboards', label: 'dashboards', name: 'Dashboards', abbr: 'DA', color: '#e0739c', icon: 'M2.5 2.5h5v5h-5zM8.5 2.5h5v3h-5zM8.5 6.5h5v7h-5zM2.5 8.5h5v5h-5z' },
  execution: { id: 'execution', label: 'execution', name: 'Execution', abbr: 'EX', color: '#8a8f98', icon: 'M4.5 7.5h7v6h-7zM6 7.5V5.5a2 2 0 0 1 4 0v2' },
}

const BY_DEPT: Record<string, CategoryId> = { hq: 'fund', research: 'research', execution: 'execution', dashboards: 'dashboards' }

type AgentLike = { id: string; kind?: string; dept?: string }

/** the category of an agent (id or roster row): `dash:*` / kind dashboard -> dashboards, a standing
 *  agent is its own, then its dept; unknown -> fund */
export function categoryOf(agent: string | AgentLike | null | undefined): Category {
  const a: AgentLike = typeof agent === 'string' || agent == null ? { id: agent ?? '' } : agent
  if (a.kind === 'dashboard' || a.id.startsWith('dash:') || a.id === 'dashboards') return CATEGORIES.dashboards
  const own = (CATEGORIES as Record<string, Category>)[a.id]
  if (own) return own
  const d = a.dept ? BY_DEPT[a.dept.toLowerCase()] : undefined
  return CATEGORIES[d ?? 'fund']
}

/** two letters for an avatar: `dash:vol` -> VO, `research` -> RE, `platform` -> PL */
export function initials(agentId: string | null | undefined): string {
  const id = (agentId ?? '').replace(/^dash:/, '')
  const w = id.split(/[^a-z0-9]+/i).filter(Boolean)
  if (w.length >= 2) return (w[0][0] + w[1][0]).toUpperCase()
  return (w[0] ?? '?').slice(0, 2).toUpperCase()
}

/** the inline style that hands the colour to CSS as `--c` */
export const catVar = (c: Category): CSSProperties => ({ '--c': c.color }) as CSSProperties

/** a neutral mark for an agent id no category claims (never gold by default: gold is "fund") */
export const UNKNOWN_COLOR = '#6b7078'

function hexToHsl(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16)
  const r = (n >> 16 & 255) / 255, g = (n >> 8 & 255) / 255, b = (n & 255) / 255
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2
  if (mx === mn) return [0, 0, l * 100]
  const d = mx - mn, s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn)
  const h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4
  return [h * 60, s * 100, l * 100]
}

function hslToHex(h: number, s: number, l: number): string {
  s /= 100; l /= 100
  const k = (n: number) => (n + h / 30) % 12
  const a = s * Math.min(l, 1 - l)
  const f = (n: number) => Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1))))
  return `#${[f(0), f(8), f(4)].map(x => x.toString(16).padStart(2, '0')).join('')}`
}

/** lightness steps around a category colour: the family a chart uses when one category holds
 *  several series (the dashboards). TINTS ONLY - the hue never moves, so no member drifts toward
 *  the fail red or another category's colour; they stay one family and still tell apart */
const FAMILY: number[] = [0, 12, -8, 20, -13, 6, -4, 16]

/** the i-th member of a category's colour family (i = 0 is the category colour itself) */
export function familyShade(c: Category, i: number): string {
  if (i <= 0) return c.color
  const [h, s, l] = hexToHsl(c.color)
  const dl = FAMILY[i % FAMILY.length]
  const lap = Math.floor(i / FAMILY.length)
  return hslToHex(h, s, Math.max(52, Math.min(86, l + dl - lap * 3)))
}

/** is this id an agent a category claims (a standing category agent or a dashboard)? */
export function isKnownAgent(id: string): boolean {
  return id in CATEGORIES || id.startsWith('dash:')
}

/** the one colour for an agent in a chart: a standing agent its category, each dashboard one shade of
 *  the dashboards family (stable by its place among `peers` sorted), anything else neutral */
export function agentColor(id: string, peers: string[] = []): string {
  if (!isKnownAgent(id)) return UNKNOWN_COLOR
  const cat = categoryOf(id)
  if (cat.id !== 'dashboards') return cat.color
  const dashes = [...new Set([...peers, id])].filter(p => p.startsWith('dash:')).sort()
  return familyShade(cat, dashes.indexOf(id))
}

/** the fixed order the Board room lists the categories in - every CategoryId, once; repo-order.test.ts pins it */
export const CATEGORY_ORDER: CategoryId[] = ['fund', 'app', 'platform', 'database', 'research', 'execution', 'dashboards']
