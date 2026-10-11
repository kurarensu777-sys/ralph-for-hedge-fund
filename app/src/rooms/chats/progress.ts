import type { Progress, ProgressKind } from '../../../server/chat/progress.ts'
import type { Light } from './mark.ts'

// THE LIGHT IN A TAB: each conversation's tab fills left to right with its own turn's progress
// (server/chat/progress.ts). A running turn always shows: measured (done of total) when the agent
// keeps a todo list, a sweep with the step count when it does not. An ended turn shows only while
// its tab is lit (new since the owner looked, mark.ts), or, in the tab he is watching, for FADE_MS
// after it ended and then fades. Pure; index.tsx draws it.

export type TabProgress = {
  kind: ProgressKind
  /** filled share, 0-100; null = no todo list while working: the tab sweeps */
  pct: number | null
  /** '2/5', '7 steps', or '' */
  count: string
  /** what the agent is on (the open tab says it) */
  now: string
  /** the tooltip line */
  tip: string
  /** the watched tab's ended turn: fading out */
  fade: boolean
}

export const FADE_MS = 5000

const WORD: Record<ProgressKind, string> = { work: 'working', ask: 'waiting on you', done: 'finished', open: 'ended with items open', stop: 'stopped', fail: 'ended on an error' }

const steps = (n: number) => `${n} step${n === 1 ? '' : 's'}`
const clock = (ms: number) => { const s = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` }

export function tabProgress(p: Progress | undefined, o: { light: Light; watched: boolean; now: number }): TabProgress | null {
  if (!p) return null
  const running = p.kind === 'work' || p.kind === 'ask'
  let fade = false
  if (!running && !o.light) {
    if (o.watched && o.now - p.at < FADE_MS) fade = true
    else return null
  }
  const list = p.total != null && p.total > 0 && p.done != null
  const pct = list ? Math.min(100, (p.done! / p.total!) * 100) : p.kind === 'work' ? null : 100
  const count = list ? `${p.done}/${p.total}` : p.kind === 'work' ? steps(p.steps) : ''
  const now = p.kind === 'work' ? p.now : p.kind === 'ask' ? 'waiting on you' : ''
  const open = list ? p.total! - p.done! : 0
  const head = list ? `${p.done} of ${p.total} done` : `${steps(p.steps)}, no todo list`
  const word = p.kind === 'open' ? `ended with ${open} open` : WORD[p.kind]
  const tip = [`${word}: ${head}`, p.kind === 'work' && p.now ? `now: ${p.now}` : '', `${clock((running ? o.now : p.at) - p.since)} this turn`].filter(Boolean).join(' - ')
  return { kind: p.kind, pct, count, now, tip, fade }
}
