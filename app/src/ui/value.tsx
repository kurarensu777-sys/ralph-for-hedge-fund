import type { ReactNode } from 'react'
import { Dot, Icon } from './kit.tsx'

// The services rail's right-hand value: numbers and dots only. A server row writes a short
// sentence ("2 fail · 1 stale", "0 proposed · 24m", "local"); the rail keeps the figures, colours
// the counts that are trouble as chips, and leaves the words for the row's tooltip.

const FAIL = /^(fail|failed|down|failing|error)s?$/
const WARN = /^(missed|stale|warn|dirty|late|due|behind|worse|unknown)$/

export type Part = { n: string; tone?: 'fail' | 'warn' | 'faint' | 'ask'; icon?: string } | { dot: 'off' }

export function railParts(reading: string | undefined): Part[] {
  const r = (reading ?? '').trim().replace(/\s+-\s+local$/, '')
  if (!r) return []
  if (r === 'local' || r === 'clean') return [{ dot: 'off' }]
  if (/^(none|none due|0)$/.test(r)) return [{ n: '0', tone: 'faint' }]
  if (/^(never ran|no .*)$/.test(r)) return [{ n: '-', tone: 'faint' }]
  return r.split(/\s+·\s+|\s+-\s+|,\s+/).map((p): Part => {
    let m: RegExpExecArray | null
    if ((m = /^(\d+)\s+(\w+)/.exec(p))) {
      const w = m[2].toLowerCase()
      if (FAIL.test(w)) return { n: m[1], tone: m[1] === '0' ? 'faint' : 'fail' }
      if (w === 'behind') return { n: `↓${m[1]}`, tone: m[1] === '0' ? 'faint' : 'warn' }
      if (WARN.test(w)) return { n: m[1], tone: m[1] === '0' ? 'faint' : 'warn' }
      if (w === 'ahead') return { n: `↑${m[1]}` }
      if (w === 'waiting') return { n: m[1], tone: m[1] === '0' ? 'faint' : 'ask' }
      return { n: m[1] }
    }
    // "up 2m" keeps its word: a bare "2m" beside a name reads as a broken number
    if ((m = /^up\s+(\S+)$/.exec(p))) return { n: `up ${m[1]}` }
    // "59m ago": an age, drawn with a clock so it never reads as a count
    if ((m = /^(\S+)\s+ago$/.exec(p))) return { n: m[1], icon: 'clock' }
    return { n: p }
  })
}

export function RailValue({ reading }: { reading?: string }): ReactNode {
  const parts = railParts(reading)
  if (!parts.length) return null
  const chip = (p: Part) => !('dot' in p) && (p.tone === 'fail' || p.tone === 'warn' || p.tone === 'ask')
  const plain = (p: Part | undefined) => !!p && !('dot' in p) && !chip(p)
  return <span className="rd rd-v">{parts.map((p, i) => <span key={i}>
    {plain(p) && plain(parts[i - 1]) ? <span className="faint"> · </span> : null}
    {'dot' in p ? <Dot s="off" title={reading} /> : chip(p) ? <span className={`nchip ${p.tone}`}>{p.n}</span> : <span className={`${p.tone === 'faint' ? 'faint' : ''} ${p.icon ? 'rd-ic' : ''}`}>{p.icon && <Icon name={p.icon} />}{p.n}</span>}
  </span>)}</span>
}
