import type { CSSProperties } from 'react'
import { UNKNOWN_COLOR, agentColor } from '../../ui/categories.ts'

// ROOM: git - the room's small charts, inline SVG (no chart library): a repo card's day sparkline,
// the log's commits-per-day stacked by agent, and the land pipeline. A value nobody measured draws
// hollow (a dashed rule), never a zero bar.

/** "2026-09-26" -> "Sep 26" */
export const dayLabel = (d: string) => {
  const [, m, dd] = d.split('-').map(Number)
  return `${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][m - 1]} ${dd}`
}

/** one bar per day in the repo colour (--c); a zero day is a faint tick; null = git could not say */
export function Spark({ counts, days }: { counts: number[] | null; days: string[] }) {
  if (!counts) return <svg className="git-spark none" viewBox="0 0 56 20" preserveAspectRatio="none" aria-label="activity unknown">
    <title>activity unknown: git could not read this repo's log</title><line x1="0" y1="19" x2="56" y2="19" /></svg>
  const max = Math.max(1, ...counts)
  const w = 4
  const total = counts.reduce((a, b) => a + b, 0)
  return <svg className="git-spark" viewBox={`0 0 ${counts.length * w} 20`} preserveAspectRatio="none" role="img" aria-label={`${total} commits in ${counts.length} days`}>
    {counts.map((n, i) => {
      const h = n ? Math.max(2, (n / max) * 19) : 1
      return <rect key={i} className={n ? 'on' : 'z'} x={i * w + .5} y={20 - h} width={w - 1} height={h}><title>{`${dayLabel(days[i] ?? '')}: ${n} commit${n === 1 ? '' : 's'}`}</title></rect>
    })}
  </svg>
}

export type Series = { id: string; counts: number[] }

/** the chart colour of an agent key: '-' (no Agent trailer) and any id no category claims are neutral */
export const seriesColor = (id: string, peers: string[]) => id === '-' ? 'var(--line3)' : id === OTHER ? UNKNOWN_COLOR : agentColor(id, peers)

/** the one series every Agent trailer naming no roster agent folds into (never letters that pose as an agent) */
export const OTHER = '~'

/** a series' words for a tooltip */
export const seriesName = (id: string) => id === '-' ? 'no Agent trailer' : id === OTHER ? 'not in the roster' : id

/** commits per day, one stacked column per day, a segment per agent in its category colour. `focus`
 *  dims every other agent; clicking a column's segment picks its agent */
export function DayBars({ days, series, focus, onPick }: { days: string[]; series: Series[]; focus: string; onPick: (id: string) => void }) {
  const totals = days.map((_, i) => series.reduce((t, s) => t + (s.counts[i] ?? 0), 0))
  const max = Math.max(1, ...totals)
  const peers = series.map(s => s.id)
  const W = 10, H = 56
  // the axis: first, middle and last day, and today's mark
  const ticks = days.length <= 1 ? [0] : [0, Math.floor((days.length - 1) / 2), days.length - 1]
  return <div className="git-days">
    <span className="git-days-max" title="the busiest day">{max}</span>
    <svg className="git-days-svg" viewBox={`0 0 ${days.length * W} ${H}`} preserveAspectRatio="none" role="img" aria-label="commits per day by agent">
      {[0.5, 1].map(f => <line key={f} className="git-days-grid" x1="0" x2={days.length * W} y1={H - f * H + .5} y2={H - f * H + .5} />)}
      {days.map((d, i) => {
        let y = H
        const parts = series.filter(s => s.counts[i])
        return <g key={d}>
          <rect className="git-days-hit" x={i * W} y="0" width={W} height={H}>
            <title>{[`${dayLabel(d)}: ${totals[i]} commit${totals[i] === 1 ? '' : 's'}`, ...parts.map(s => `  ${seriesName(s.id)} ${s.counts[i]}`)].join('\n')}</title>
          </rect>
          {parts.map(s => {
            const h = (s.counts[i] / max) * (H - 2)
            y -= h
            return <rect key={s.id} className={`git-days-seg ${focus && focus !== s.id ? 'dim' : ''}`} x={i * W + 1.5} y={y} width={W - 3} height={Math.max(h - .6, .8)}
              style={{ fill: seriesColor(s.id, peers) } as CSSProperties} onClick={() => onPick(s.id)}>
              <title>{`${dayLabel(d)}  ${seriesName(s.id)}: ${s.counts[i]}`}</title>
            </rect>
          })}
          {!totals[i] && <rect className="git-days-zero" x={i * W + 1.5} y={H - 1} width={W - 3} height={1} />}
        </g>
      })}
    </svg>
    <div className="git-days-axis">{ticks.map(i => <span key={i} style={{ left: `${((i + .5) / days.length) * 100}%` }}>{dayLabel(days[i])}</span>)}</div>
  </div>
}

// THE LAND PIPELINE: one node per step, in order. `commits` (the branch has commits main lacks) is
// part of the first check, so it folds into `clean`.
export type StepName = 'clean' | 'main' | 'commits' | 'rebase' | 'verify' | 'land' | 'push' | 'cleanup'
export type Step = { name: StepName; ok: boolean; detail: string; ms?: number }
export type LandState = 'queued' | 'running' | 'landed' | 'red' | 'blocked'

export const PIPES: { id: StepName; also?: StepName; abbr: string; label: string }[] = [
  { id: 'clean', also: 'commits', abbr: 'cln', label: 'clean worktree, commits to land' }, { id: 'main', abbr: 'main', label: 'main current with origin' },
  { id: 'rebase', abbr: 'reb', label: 'rebase onto main' }, { id: 'verify', abbr: 'ver', label: 'the repo verify' },
  { id: 'land', abbr: 'ff', label: 'fast-forward main' }, { id: 'push', abbr: 'push', label: 'push main' }, { id: 'cleanup', abbr: 'rm', label: 'remove worktree + branch' },
]

export type Node = { tone: 'ok' | 'fail' | 'ask' | 'run' | ''; steps: Step[] }

/** each pipeline node's tone: ok green; a failed step red, or blue when the land is BLOCKED (main's
 *  state: the owner's to clear); the next step of a running land the accent pulse; else not reached */
export function pipeNodes(steps: Step[], state: LandState | null): Node[] {
  let next = true
  return PIPES.map(p => {
    const mine = steps.filter(s => s.name === p.id || s.name === p.also)
    const failed = mine.some(s => !s.ok)
    if (failed) { next = false; return { tone: state === 'blocked' ? 'ask' : 'fail', steps: mine } }
    if (mine.length) return { tone: 'ok', steps: mine }
    const run = next && state === 'running'
    next = false
    return { tone: run ? 'run' : '', steps: mine }
  })
}

const ms = (n: number) => n < 1000 ? `${n} ms` : `${(n / 1000).toFixed(1)} s`

/** the pipeline as connected nodes; the rule between two nodes is lit when the left one passed */
export function Pipe({ steps, state }: { steps: Step[]; state: LandState | null }) {
  const nodes = pipeNodes(steps, state)
  return <span className="git-pipe" role="img" aria-label="land steps">{nodes.map((n, i) => {
    const p = PIPES[i]
    const s = n.steps.at(-1)
    const tip = `${p.label}: ${n.tone === 'ok' ? 'ok' : n.tone === 'fail' ? 'failed' : n.tone === 'ask' ? 'blocked (main)' : n.tone === 'run' ? 'running' : state ? 'not reached' : 'not run'}${s?.ms != null ? `  ${ms(s.ms)}` : ''}${s && (!s.ok || n.tone === 'ok') ? `\n${n.steps.map(x => x.detail).filter(Boolean).join('\n')}` : ''}`
    return <span key={p.id} className={`git-node ${n.tone}`} title={tip}><i /></span>
  })}</span>
}

/** the step names once, over a list's pipeline column */
export function PipeHead() {
  return <span className="git-pipe head">{PIPES.map(p => <span key={p.id} className="git-node" title={p.label}>{p.abbr}</span>)}</span>
}

export { ms as fmtMs }
