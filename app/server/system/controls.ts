import type { Agent } from '../../shared/types.ts'
import { readConfig as readBoardConfig } from '../board/config.ts'
import { runningItems } from '../board/auto.ts'
import { listAllItems } from '../board/store.ts'
import { readConfig as readLoopConfig } from '../loop/config.ts'
import { BOARD_CONFIG_FILE, BOARD_DIR, CONFIG_FILES, CONTROLS_FILE, STOP_FILE } from '../paths.ts'
import { floorStopped } from './floor.ts'
import { readStopState } from './stop.ts'
import { capState } from './cap.ts'
import { readControls } from './controlsfile.ts'

/**
 * THE CONTROLS VIEW (System > Controls): the few decisions that govern what runs unattended and what
 * it spends, read in one place. Every row has ONE home for its setting and ONE route that writes it;
 * this module only READS them together, so the page never holds a second copy that could drift.
 *
 *   id            what it is                                   setting lives in            written by
 *   pause         the scheduler, the board and dashboard       floor/STOP                  POST /api/system/halt
 *                 wakes held (chats keep going)
 *   board         auto-pickup Auto / Manual, its model, how    app/board/config.json       POST /api/board/config
 *                 many at once
 *   loop          the loop's Auto / Manual                     app/loop/config.json        POST /api/loop/config
 *   wakes         a failing dashboard calls its agent          app/controls.json           POST /api/system/controls
 *   tokenCap      the daily billable-token ceiling per agent   app/controls.json           POST /api/system/controls
 *   defaultModel  the model every roster agent boots on        app/agents/<id>.md          POST /api/system/controls
 *
 * Not here, on purpose: arming `execution` and the permission mode. Neither is ever one click.
 * test/controls.test.ts holds this table to the code: each id has a UI row, each writer a route.
 */
export const CONTROLS = [
  { id: 'pause', write: 'POST /api/system/halt', file: 'floor/STOP' },
  { id: 'board', write: 'POST /api/board/config', file: 'app/board/config.json' },
  { id: 'loop', write: 'POST /api/loop/config', file: 'app/loop/config.json' },
  { id: 'wakes', write: 'POST /api/system/controls', file: 'app/controls.json' },
  { id: 'tokenCap', write: 'POST /api/system/controls', file: 'app/controls.json' },
  { id: 'defaultModel', write: 'POST /api/system/controls', file: 'app/agents/' },
] as const

export type ControlId = typeof CONTROLS[number]['id']

export type ControlsState = {
  paused: boolean
  pausedUntil: number | null                      // the end time floor/STOP carries (ms); null = until someone resumes
  board: { auto: boolean; model: string | null; max: number; perDay: number; running: number }
  loop: { auto: boolean }
  wakes: boolean
  tokenCap: { value: number | null; capped: string[] }   // the agents at today's ceiling right now
  defaultModel: { model: string | null; mixed: string[] } // the model every agent shares, else null and who differs from the commonest
}

/** the model every agent shares, or null and the ids that differ from the commonest one */
export function modelSummary(agents: Pick<Agent, 'id' | 'model'>[]): ControlsState['defaultModel'] {
  if (!agents.length) return { model: null, mixed: [] }
  const count = new Map<string, number>()
  for (const a of agents) count.set(a.model, (count.get(a.model) ?? 0) + 1)
  const [top] = [...count.entries()].sort((a, b) => b[1] - a[1])
  const mixed = agents.filter(a => a.model !== top[0]).map(a => a.id)
  return mixed.length ? { model: null, mixed } : { model: top[0], mixed: [] }
}

export async function readControlsState(agents: Agent[]): Promise<ControlsState> {
  const board = readBoardConfig(BOARD_CONFIG_FILE)
  const cf = readControls(CONTROLS_FILE)
  const capped: string[] = []
  if (cf.tokenCap) {
    for (const a of agents) { const s = await capState(a.id).catch(() => null); if (s?.capped) capped.push(a.id) }
  }
  return {
    paused: floorStopped(),
    pausedUntil: readStopState(STOP_FILE).until,
    board: { auto: board.auto, model: board.model, max: board.max, perDay: board.perDay, running: runningItems(listAllItems(BOARD_DIR)).length },
    loop: { auto: readLoopConfig(CONFIG_FILES).autoApply },
    wakes: cf.wakes,
    tokenCap: { value: cf.tokenCap, capped },
    defaultModel: modelSummary(agents),
  }
}
