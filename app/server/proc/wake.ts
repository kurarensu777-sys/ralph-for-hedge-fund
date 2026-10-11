// on_fail: wake_agent. When a dashboard TURNS failing, start a conversation with its agent.
// Pure decision + prompt here (unit-tested); the room wires the POST and the event log.

export const WAKE_DEBOUNCE_MS = 6 * 3_600_000

export type WakeInput = {
  prev: string | undefined          // the state at the previous check; undefined = first check since boot
  next: string                      // the state now
  onFail: string | null | undefined // the dashboard's on_fail
  lastWake: number | null           // when this dashboard last woke its agent (ms), from the record
  now: number
  stopped?: boolean                 // floor/STOP is set: the fund is halted, nothing unattended starts
}

/**
 * Why a wake that shouldWake() allowed is held anyway, or null when it may go: floor/STOP (the fund is
 * halted) or the owner's switch on System > Controls (app/controls.json `wakes: false`). Said in the
 * event the room logs, so a missing wake is never a silence.
 */
export function wakeHeld(stopped: boolean, wakesOn: boolean): string | null {
  if (stopped) return 'stopped (floor/STOP)'
  if (!wakesOn) return 'dashboard wakes are off (System > Controls)'
  return null
}

/**
 * Wake only on a TRANSITION into failing (a dashboard that stays failing is one failure), only
 * when on_fail says so, and at most once per debounce window. A first check after a daemon
 * restart counts as a transition; the persisted lastWake is what stops a restart loop re-waking.
 * Never while floor/STOP is set: the scheduler and board auto-pickup honour STOP, and so does this.
 */
export function shouldWake(i: WakeInput, debounceMs = WAKE_DEBOUNCE_MS): boolean {
  if (i.stopped) return false
  if (i.onFail !== 'wake_agent') return false
  if (i.next !== 'failing') return false
  if (i.prev === 'failing') return false
  if (i.lastWake !== null && i.now - i.lastWake < debounceMs) return false
  return true
}

export type FailingCheck = { id: string; check: string; target: string; status: string; reading: string }

export function wakePrompt(name: string, checks: FailingCheck[]): string {
  const bad = checks.filter(c => c.status === 'fail' || c.status === 'warn')
  const lines = bad.map(c => `${c.id} (${c.check} ${c.target}): ${c.status}${c.reading ? ` - ${c.reading}` : ''}`)
  return `${name} is failing: ${lines.length ? lines.join('; ') : 'no check named'}. Diagnose and fix it; if you cannot, file a board item for the owner.`
}

export const wakeTitle = (name: string) => `${name} failing`
