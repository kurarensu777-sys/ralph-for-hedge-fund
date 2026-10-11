// ROOM: system - the HANDS line under Health (pure, tested in test/system-hands.test.ts): the agent
// processes fundd holds, what they weigh, what the idle reaper closed today (server/system/hands.ts).
// Three honest states: a figure the server could not read is absent, never 0 GB or "0 reaped".

export type HandsView = {
  open: number; idle: number; bytes: number | null; orphans: number | null
  terminals: { n: number; bytes: number } | null; reapedToday: number | null; idleMinutes: number; freeBytes: number | null
}

const gb = (b: number) => `${(b / 1024 ** 3).toFixed(1)} GB`
const idleText = (m: number) => m >= 120 && m % 60 === 0 ? `${m / 60} h` : `${m} min`

/** "48 hands open · 19.0 GB held · 3 reaped today" and its tooltip */
export function handsLine(v: HandsView): { text: string; title: string } {
  const text = [
    `${v.open} hand${v.open === 1 ? '' : 's'} open`,
    v.bytes === null ? 'memory unknown' : `${gb(v.bytes)} held`,
    v.reapedToday === null ? 'reaped unknown' : `${v.reapedToday} reaped today`,
  ].join(' · ')
  const title = [
    `${v.open} open agent processes, ${v.idle} with no turn and no decision waiting. Each is closed after ${idleText(v.idleMinutes)} idle, sooner under memory pressure or past the idle cap (app/reaper.json); its next message reopens it`,
    v.bytes === null ? 'memory: the process list could not be read' : `${gb(v.bytes)} held by the hands and the servers they started`,
    v.freeBytes === null ? '' : `${gb(v.freeBytes)} of RAM free`,
    v.orphans === null ? '' : v.orphans ? `${v.orphans} orphaned (their fundd is gone): the next fundd start closes them` : 'no orphaned hand',
    v.terminals === null ? '' : `${v.terminals.n} terminal claude session${v.terminals.n === 1 ? '' : 's'} (${gb(v.terminals.bytes)}): yours, never closed from here`,
  ].filter(Boolean).join('\n')
  return { text, title }
}
