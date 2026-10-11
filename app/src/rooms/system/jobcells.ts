// ROOM: system - the pure half of a job's 24h strip (jobday.tsx): the wall's marks bucketed into
// 24 clock hours, the hour in progress last. fail > missed > ok > nothing; never ok by default.

export type Mark = { t: number; end: number | null; kind: 'run' | 'owed' | 'missed' | 'skipped'; status: string; manual?: boolean; detail?: string }

const H = 3_600_000
const hh = (t: number) => new Date(t).toISOString().slice(11, 16)

export type DayCell = { s: 'ok' | 'fail' | 'missed' | 'none'; title: string }

/** 24 cells for one lane's marks, ending in the hour that holds `now` */
export function dayCells(marks: Mark[], now: number, since: number | null): DayCell[] {
  const last = Math.floor(now / H) * H
  const from = last - 23 * H
  return Array.from({ length: 24 }, (_, i) => {
    const a = from + i * H
    const at = `${hh(a)}-${hh(a + H)}Z`
    const inHour = marks.filter(m => m.t >= a && m.t < a + H)
    const n = (f: (m: Mark) => boolean) => inHour.filter(f).length
    const fail = n(m => m.kind === 'run' && m.status === 'fail'), miss = n(m => m.kind === 'missed'), ok = n(m => m.kind === 'run' && m.status === 'ok')
    const other = inHour.filter(m => !(m.kind === 'run' && (m.status === 'fail' || m.status === 'ok')) && m.kind !== 'missed').map(m => m.kind === 'run' ? m.status : m.kind)
    const words = [ok && `ok ${ok}`, fail && `fail ${fail}`, miss && `missed ${miss}`, ...[...new Set(other)].map(w => `${w} ${other.filter(x => x === w).length}`)].filter(Boolean).join(' · ')
    if (!inHour.length && since !== null && a + H <= since) return { s: 'none', title: `${at}  no run record yet` }
    const s: DayCell['s'] = fail ? 'fail' : miss ? 'missed' : ok ? 'ok' : 'none'
    return { s, title: `${at}  ${words || 'nothing ran'}` }
  })
}

