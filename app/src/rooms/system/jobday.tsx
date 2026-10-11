import { useEffect } from 'react'
import { useApi } from '../../lib/api.ts'
import { HeatBlank, HeatStrip } from '../../ui/kit.tsx'
import { dayCells, type Mark } from './jobcells.ts'

// ROOM: system - each job's LAST 24 HOURS as the one heat strip (Schedule > Table): one cell per
// clock hour, the hour in progress on the right, from the cadence wall's own marks
// (GET /api/system/schedule/wall?days=1, server/system/wall.ts). Four drawn states: ok green (a run
// ended ok), fail red (a run failed), missed amber (an occurrence the scheduler never ran), no
// reading grey (nothing ran, only owed, skipped, still running, or before the run record began).
// Never green by default: an hour is green only when a run in it ended ok.

type Lane = { id: string; kind: string; enabled: boolean; marks: Mark[] }
type Wall = { now: number; since: number | null; found: boolean; lanes: Lane[] }

export function useJobDay() {
  const q = useApi<Wall>('/api/system/schedule/wall?days=1', ['system'])
  useEffect(() => { const t = setInterval(q.reload, 60_000); return () => clearInterval(t) }, [q.reload])
  return q
}

/** one job's strip; the day's read failed or has no lane for it: grey cells that say why */
export function JobStrip({ q, id, enabled }: { q: ReturnType<typeof useJobDay>; id: string; enabled: boolean }) {
  if (q.error && !q.data) return <HeatBlank state="unknown" why={`runs failed: ${q.error}`} />
  if (!q.data) return <HeatBlank why="loading" />
  const lane = q.data.lanes.find(l => l.id === id && l.kind === 'job')
  if (!lane) return <HeatBlank state="unknown" why={`${id}: no lane in the run record`} />
  const cells = dayCells(lane.marks, q.data.now, q.data.since)
  return <HeatStrip label={`${id}: runs, last 24h`} cells={cells.map(c => ({ cls: `hc-${c.s === 'missed' ? 'warn' : c.s}`, title: `${id}  ${c.title}${enabled ? '' : '\noff in schedule.json'}` }))} />
}
