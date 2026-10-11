import type { RoomDef } from './types.ts'
import { room as chats } from './chats/index.tsx'
import { room as board } from './board/index.tsx'
import { room as dash } from './dash/index.tsx'
import { room as data } from './data/index.tsx'
import { room as library } from './library/index.tsx'
import { room as context } from './context/index.tsx'
import { room as lab } from './lab/index.tsx'
import { room as research } from './research/index.tsx'
import { room as loop } from './loop/index.tsx'
import { room as git } from './git/index.tsx'
import { room as system } from './system/index.tsx'
import { room as map } from './map/index.tsx'

/** activity-bar order */
export const ROOMS: RoomDef[] = [chats, board, dash, data, library, context, lab, research, loop, git, system, map]
