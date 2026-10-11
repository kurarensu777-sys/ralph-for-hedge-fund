import type { ComponentType, ReactNode } from 'react'
import type { Nav, RoomId } from '../shell/nav.tsx'

export type PaletteItem = { kind: string; label: string; hint?: string; run: () => void; /** the agent this row belongs to, so the command bar marks it with that agent's letters */ agent?: string }

/**
 * A room = one button on the activity bar. Each room lives in src/rooms/<id>/ and exports
 * `room: RoomDef`. Explorer = the left list; Main = the centre. Head = optional controls in
 * the main header (right of the title). Badge = the count on the activity-bar button.
 */
export type RoomDef = {
  id: RoomId
  label: string          // ONE short word, shown under the icon
  title: string          // the main header title
  icon: ReactNode        // an <svg> path set (24x24 viewBox, stroke)
  /** the side list's width as a CSS length, when the room's list is wider than the shell's default (research: a table) */
  explorerWidth?: string
  /** the narrowest the side list may be dragged, in px (default 200) */
  explorerMin?: number
  Explorer: ComponentType
  Main: ComponentType
  Head?: ComponentType
  useBadge?: () => { n: number; tone?: 'fail' | 'ask' } | null
  palette?: (nav: Nav) => Promise<PaletteItem[]>
  /** live results for the palette's current query (e.g. book bodies); already matched server-side */
  search?: (q: string) => Promise<PaletteItem[]>
}
