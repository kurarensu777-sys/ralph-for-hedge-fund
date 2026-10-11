import { execFile } from 'node:child_process'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { COCKPIT_MARK } from '../shared/cockpitmsg.ts'

/**
 * THE IDLE RESTART (B-0174 part 2): landed server code goes live without cutting anyone off.
 *
 * fundd notes when a commit touching server/ or shared/ landed after it started (the status bar's
 * `fundd stale`). Under a SUPERVISOR (scripts/prod.mjs, FUND_SUPERVISED=1) it then restarts at the
 * first idle moment: no chat turn running, no decision parked on the owner, no terminal running a
 * command, no UI build (the holders say why not, server/hooks.ts onRestart). Before it exits it saves
 * the open conversations to a live file and exits with RESTART_CODE; the supervisor starts a new
 * fundd, which reopens from its transcript each one that was cut, waiting on the owner or losing background work
 * (the runner resumes by transcript); a plain idle one stays closed until its next message (B-0420). A start
 * under CRASH_LOOP_MS after the previous one restores nothing: a fundd crash-looping on a bad commit
 * must not boot an agent per crash. A turn cut off anyway (a forced restart) gets a note.
 *
 * THE JOURNAL (B-0254): the idle restart is not the only way a fundd ends. At 12:54:46Z on
 * 2026-09-27 a session outside the cockpit ran `prod.mjs --stop` (a taskkill) over three running
 * turns: nothing was saved, nothing reopened, and the next fundd's idle restart truthfully logged
 * "0 saved". So fundd keeps the same live file current the whole time it runs (journal(), debounced
 * on every state change, a heartbeat each minute), marked JOURNAL: whatever kills it, the next
 * fundd reopens what was open, each cut turn with a note. A planned exit (go(), leave()) freezes
 * the journal and writes its own list. `prod.mjs --stop` asks fundd to leave (leave(), refused
 * while work runs unless forced) instead of killing it (stopProd()).
 *
 * BACKGROUND WORK (B-0254): a conversation between turns can still hold work its process owns - a
 * background command or subagent (holds the restart, like a turn), a watcher or a scheduled
 * wake-up (does not hold: a recurring cron would hold for ever). What a restart ends anyway is
 * saved as `lost` and named to the agent when its conversation reopens.
 *
 * THE BATCH (B-0254): agents land server code many times a day. New code alone restarts at most
 * once per RESTART_BATCH_MS after fundd's start; the owner's click (request()) skips the wait.
 *
 * AUTO-CONTINUE (B-0254 part 5, the owner's ask): after ANY restart a chat whose turn was cut gets
 * ONE cockpit-marked continue message (continueMessage()). Cut = the saved list's cutOff, plus a
 * boot scan of transcripts active in the last SCAN_WINDOW_MS that end mid-turn (a hard stop the
 * list missed). Guards: nothing inside CRASH_LOOP_MS of the previous start; never a chat parked on
 * the owner; never one whose cut turn was itself an auto-continue; never while floor/STOP exists;
 * CONTINUE_GAP_MS apart.
 *
 * Unsupervised (npm run fundd, npm start, npm run dev's tsx watch) fundd never exits on its own:
 * nothing would start it again. It still shows the tell.
 *
 * Why a supervisor and not an exec: Windows has no execve. A fundd that spawns its own successor
 * has to release the port first and then dies with the successor as an orphan: under
 * `prod.mjs --foreground` the window's script sees its child exit and quits, and the pid file
 * names a dead pid. A supervisor that waits for the exit and starts the next fundd keeps one
 * stable parent, one console, one pid file it rewrites, and the port is free before the rebind.
 *
 * scripts/prod.mjs imports this file straight through node's type stripping (like uibuild.ts):
 * node builtins only, erasable TypeScript only.
 */

/** the exit code that asks the supervisor for a new fundd (EX_TEMPFAIL); any other code stops it */
export const RESTART_CODE = 75
/** a start this soon after the previous one is a crash loop: nothing is reopened */
export const CRASH_LOOP_MS = 60_000
/** a saved live file older than this is not a restart: it is left from another day */
export const LIVE_MAX_AGE_MS = 10 * 60_000
/** new server code alone restarts at most once this long after fundd's start (the owner's click skips it) */
export const RESTART_BATCH_MS = 30 * 60_000
/** the journal's debounce and heartbeat */
export const JOURNAL_DEBOUNCE_MS = 1_000
export const JOURNAL_BEAT_MS = 60_000
/** the reason a live file carries while fundd runs: found at boot, it means fundd ended unplanned */
export const JOURNAL = 'fundd ended without saving (killed or crashed)'

/** the reason a cut found by the boot scan carries: no list said so, the transcript did */
export const SCANNED = 'found cut at boot: a kill, a crash, a closed window or a power loss'
/** the boot scan reads transcripts written this recently */
export const SCAN_WINDOW_MS = 30 * 60_000
/** auto-continues start this far apart */
export const CONTINUE_GAP_MS = 4_000

/** what a conversation whose turn was cut off says when it reopens, for whatever cut it */
export function cutNote(reason: string, continued = false): string {
  const how = reason === JOURNAL ? 'fundd was stopped underneath this turn (a kill, a crash or a closed window, not a planned restart)'
    : reason === SCANNED ? `fundd was stopped underneath this turn (${SCANNED})`
    : `fundd restarted underneath this turn (${reason})`
  return `${how}. Nothing after the cut was kept: ${continued ? 'the cockpit sent the agent a message to continue.' : 'say continue to pick it up.'}`
}
/** the forced restart's note (the cut the first note was written for) */
export const CUT_NOTE = cutNote('forced by the owner')

const hhmm = (at: number) => `${new Date(at).toISOString().slice(11, 16)}Z`
/** the ONE message a cut chat gets after a restart: the cockpit's, never read as the owner's */
export function continueMessage(at: number, lost: string[]): string {
  return [
    `${COCKPIT_MARK} The cockpit restarted at ${hhmm(at)} and cut your turn. This is not a new instruction from the owner.`,
    `Check git status for your uncommitted files${lost.length ? ', re-launch these lost background tasks:' : ', and continue where you stopped.'}`,
    ...(lost.length ? [...lost.map(l => `- ${l}`), 'and continue where you stopped.'] : []),
  ].join('\n')
}
/** the message a chat between turns gets when background work of its old process did not carry over */
export function lostMessage(at: number, lost: string[]): string {
  return [
    `${COCKPIT_MARK} The cockpit restarted at ${hhmm(at)} and this conversation's process was replaced. This is not a new instruction from the owner. Background work the old process held did not carry over:`,
    ...lost.map(l => `- ${l}`),
    'Re-arm what you still need (a wake-up or cron: create it again; a background command: run it again or read its output file; a background agent: the harness names it as unfinished and its transcript is saved, so resume it with SendMessage). If none of it matters now, say so in one line and stop.',
  ].join('\n')
}

/**
 * one open conversation: a turn running, a decision parked, and the work its process holds between
 * turns - `tasks` a background command or subagent (holds the restart), `later` a watcher or a
 * scheduled wake-up (does not hold; lost on a restart and named on reopen)
 */
export type LiveConv = { id: string; busy: boolean; waiting: boolean; tasks?: string[]; later?: string[]; auto?: boolean }
/** `waiting` a decision was parked on the owner; `auto` the running turn was itself an auto-continue */
export type SavedConv = { id: string; cutOff: boolean; lost?: string[]; waiting?: boolean; auto?: boolean }
export type SavedLive = { savedAt: number; reason: string; conversations: SavedConv[] }

/** the saved form of the open conversations: whether a turn was cut, and the background work that ends with the process */
export function savedList(convs: LiveConv[]): SavedConv[] {
  return convs.map(c => {
    const lost = [...(c.tasks ?? []), ...(c.later ?? [])]
    return { id: c.id, cutOff: c.busy || c.waiting, ...(lost.length ? { lost } : {}), ...(c.waiting ? { waiting: true } : {}), ...(c.busy && c.auto ? { auto: true } : {}) }
  })
}

export function readJson<T>(file: string, fallback: T): T {
  try { return JSON.parse(readFileSync(file, 'utf8')) as T } catch { return fallback }
}
export function writeAtomic(file: string, text: string) {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, text)
  renameSync(tmp, file)
}

export type TerminalState = { id: string; title: string | null; children: string[] | null }

/** why fundd is not idle, one reason per holder; [] = idle. An unreadable terminal holds (unknown is not idle) */
export function busyReasons(s: { convs: LiveConv[]; terminals: TerminalState[]; building?: boolean }): string[] {
  const out: string[] = []
  const turns = s.convs.filter(c => c.busy && !c.waiting).length
  const waiting = s.convs.filter(c => c.waiting).length
  if (turns) out.push(`${turns} turn${turns === 1 ? '' : 's'} running`)
  if (waiting) out.push(`${waiting} decision${waiting === 1 ? '' : 's'} waiting on the owner`)
  const bg = s.convs.filter(c => !c.busy && !c.waiting && c.tasks?.length)
  const names = bg.flatMap(c => c.tasks!)
  if (bg.length) out.push(`${bg.length} conversation${bg.length === 1 ? '' : 's'} waiting on background work (${names.slice(0, 3).join('; ')}${names.length > 3 ? '; ...' : ''})`)
  for (const t of s.terminals) {
    const name = t.title || t.id.slice(0, 8)
    if (t.children === null) out.push(`terminal ${name}: its processes could not be read`)
    else if (t.children.length) out.push(`terminal ${name} running ${t.children.join(', ')}`)
  }
  if (s.building) out.push('a UI build')
  return out
}

export type RestartDeps = {
  now: () => number
  started: number
  supervised: boolean
  /** the newest commit touching the daemon (server/, shared/), ms; null unread */
  serverCommit: () => Promise<number | null>
  /** why not now ([] = idle) */
  blockers: () => Promise<string[]>
  live: () => LiveConv[]
  save: (s: SavedLive) => void
  /** close every live thing (the conversations are saved already) */
  shutdown: () => Promise<void>
  exit: (code: number) => void
  log?: (m: string) => void
  /** new server code alone restarts at most once this long after the start (default RESTART_BATCH_MS) */
  batchMs?: number
  /** the journal's debounce timer (tests hand a fake) */
  setTimer?: (fn: () => void, ms: number) => unknown
}
export type RestartStatus = { stale: boolean; changedAt: number | null; supervised: boolean; requested: boolean; forced: boolean; waitingOn: string[]; restarting: boolean; batchUntil: number | null }
export type Tick = 'current' | 'unsupervised' | 'waiting' | 'restarting'
export type Leave = { left: boolean; waitingOn: string[] }

export class Restarter {
  d: RestartDeps
  status: RestartStatus
  constructor(d: RestartDeps) {
    this.d = d
    this.status = { stale: false, changedAt: null, supervised: d.supervised, requested: false, forced: false, waitingOn: [], restarting: false, batchUntil: null }
  }

  private journalDue: unknown = null
  /**
   * THE JOURNAL: keep the live file current while fundd runs, so an exit that never reaches go()
   * (a taskkill, a crash, Ctrl+C) still leaves what was open. Debounced (`now` writes at once); a
   * no-op once a planned exit froze it: closing the hands must not overwrite the list they were saved in.
   */
  journal(now = false) {
    if (this.status.restarting) return
    if (now) { this.writeJournal(); return }
    if (this.journalDue !== null) return
    const set = this.d.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms).unref())
    this.journalDue = set(() => { this.journalDue = null; this.writeJournal() }, JOURNAL_DEBOUNCE_MS)
  }
  private writeJournal() {
    if (this.status.restarting) return
    try { this.d.save({ savedAt: this.d.now(), reason: JOURNAL, conversations: savedList(this.d.live()) }) }
    catch (e) { this.d.log?.(`the live journal could not be written: ${(e as Error)?.message ?? e}`) }
  }
  /** a signal is ending fundd (Ctrl+C, SIGTERM): stop journaling, so the hands dying with it do not empty the list */
  freeze() { this.writeJournal(); this.status.restarting = true }

  /** one look: is there new server code, and is this an idle moment to take it? */
  async tick(): Promise<Tick> {
    const s = this.status
    if (s.restarting) return 'restarting'
    const now = this.d.now()
    const c = await this.d.serverCommit().catch(() => null)
    if (c !== null && c > this.d.started && c <= now) { s.stale = true; s.changedAt = c }
    if (!s.stale && !s.requested) { s.waitingOn = []; return 'current' }
    if (!this.d.supervised) { s.waitingOn = ['no supervisor: start the cockpit with start.cmd (scripts/prod.mjs) to restart on its own']; return 'unsupervised' }
    if (!s.forced) {
      if (now - this.d.started < CRASH_LOOP_MS) { s.waitingOn = ['fundd started under a minute ago']; return 'waiting' }
      const batch = this.d.batchMs ?? RESTART_BATCH_MS
      const until = this.d.started + batch
      s.batchUntil = !s.requested && now < until ? until : null
      if (s.batchUntil !== null) {
        s.waitingOn = [`the batch: new server code restarts at most once per ${Math.round(batch / 60_000)} min, next from ${new Date(until).toISOString().slice(11, 16)}Z (click to restart at the next idle moment)`]
        return 'waiting'
      }
      s.waitingOn = await this.d.blockers().catch(e => [`the idle check failed: ${(e as Error)?.message ?? e}`])
      if (s.waitingOn.length) return 'waiting'
    }
    return this.go()
  }

  /** the owner asks for a restart: at the next idle moment, or NOW (force) cutting off what runs */
  request(force = false): Promise<Tick> {
    this.status.requested = true
    if (force) this.status.forced = true
    return this.tick()
  }

  /**
   * STOP (prod.mjs --stop -> POST /api/system/leave): leave for good; the supervisor starts no other.
   * Refused while anything holds a restart, unless forced. The open conversations are saved, so a
   * start within LIVE_MAX_AGE_MS reopens them, a cut turn with a note.
   */
  async leave(force = false, who = 'stopped'): Promise<Leave> {
    if (this.status.restarting) return { left: true, waitingOn: [] }
    if (!force) {
      const waitingOn = await this.d.blockers().catch(e => [`the idle check failed: ${(e as Error)?.message ?? e}`])
      if (waitingOn.length) return { left: false, waitingOn }
    }
    await this.exitWith(force ? `${who}, forced` : who, 0)
    return { left: true, waitingOn: [] }
  }

  private async go(): Promise<Tick> {
    const s = this.status
    await this.exitWith(s.forced ? 'forced by the owner' : s.requested ? 'asked by the owner' : 'new server code', RESTART_CODE)
    return 'restarting'
  }

  private async exitWith(reason: string, code: number) {
    this.status.restarting = true   // freezes the journal before the hands close
    const conversations = savedList(this.d.live())
    this.d.save({ savedAt: this.d.now(), reason, conversations })
    const cut = conversations.filter(c => c.cutOff).length, lost = conversations.filter(c => c.lost).length
    this.d.log?.(`${code === RESTART_CODE ? 'restarting' : 'leaving'} (${reason}): ${conversations.length} conversation(s) saved to reopen${cut ? `, ${cut} cut off` : ''}${lost ? `, ${lost} losing background work` : ''}`)
    try { await this.d.shutdown() } catch { /* exiting regardless: the saved list is what matters */ }
    this.d.exit(code)
  }
}

/** what a reopened conversation is told: `note` on screen when its turn was cut, `say` the message it is sent */
export type Reopen = { note: string | null; lost: string[]; say: 'continue' | 'lost' | null; at: number }
/** a conversation the boot scan found cut: `waiting` its turn was parked on the owner, `auto` it was an auto-continue */
export type ScanHit = { id: string; waiting?: boolean; auto?: boolean }

export type BootDeps = {
  now: () => number
  pid: number
  bootFile: string
  liveFile: string
  reopen: (id: string, r: Reopen) => Promise<void>
  /** the hard-stop scan: conversations whose transcript, written since `since`, ends mid-turn (not in `exclude`) */
  scan?: (since: number, exclude: Set<string>) => Promise<ScanHit[]>
  /** floor/STOP exists: reopen, never message */
  stopped?: () => boolean
  sleep?: (ms: number) => Promise<void>
  log?: (m: string) => void
}
/** `idle`: saved conversations that were plain idle (nothing cut, waiting or lost), left closed: the next message reopens them */
export type BootResult = { rapid: boolean; saved: number; reopened: string[]; failed: string[]; skipped: string | null; scanned: string[]; continued: string[]; idle: string[] }

/**
 * at fundd's start: stamp this boot, consume the saved live file, reopen its conversations and find
 * the cuts it does not know (the scan); each cut turn is continued ONCE, under the guards. Nothing at
 * all on a crash loop (the previous boot under CRASH_LOOP_MS ago); a stale list is not reopened, but
 * the scan still finds what it cut.
 */
export async function restoreAtBoot(d: BootDeps): Promise<BootResult> {
  const now = d.now()
  const prev = readJson<{ bootAt?: number }>(d.bootFile, {})
  const rapid = typeof prev.bootAt === 'number' && now - prev.bootAt < CRASH_LOOP_MS
  writeAtomic(d.bootFile, JSON.stringify({ bootAt: now, pid: d.pid }))
  const saved = readJson<SavedLive | null>(d.liveFile, null)
  rmSync(d.liveFile, { force: true })   // consumed: a later crash never reopens the same list twice
  let list = Array.isArray(saved?.conversations) ? saved!.conversations.filter(c => c && typeof c.id === 'string') : []
  const out: BootResult = { rapid, saved: list.length, reopened: [], failed: [], skipped: null, scanned: [], continued: [], idle: [] }
  if (rapid) {
    out.skipped = `the previous start was ${Math.round((now - prev.bootAt!) / 1000)} s ago: a crash loop, nothing reopened or continued`
    const cut = list.filter(c => c.cutOff).map(c => c.id)
    d.log?.(`${out.skipped}${cut.length ? `; cut off and not reopened: ${cut.join(', ')}` : ''}`)
    return out
  }
  if (list.length && (typeof saved!.savedAt !== 'number' || now - saved!.savedAt > LIVE_MAX_AGE_MS)) {
    out.skipped = 'the saved list is older than 10 minutes: not a restart (the scan still looks for cut turns)'
    d.log?.(out.skipped)
    list = []
  }
  const reason = String(saved?.reason ?? JOURNAL)
  if (list.length && reason === JOURNAL) d.log?.(`the previous fundd ended without saving (killed or crashed): reopening its ${list.length} conversation(s) from the journal`)
  // B-0420: a conversation that was plain idle (no turn cut, no decision parked, no background work lost) is not
  // respawned: each open hand is a ~390 MB process, and a chat idle for a day needs none until its next message
  const todo: (SavedConv & { reason: string })[] = []
  for (const c of list) {
    if (!c.cutOff && !c.waiting && !(Array.isArray(c.lost) && c.lost.length)) out.idle.push(c.id)
    else todo.push({ ...c, reason })
  }
  if (d.scan) {
    try {
      for (const h of await d.scan(now - SCAN_WINDOW_MS, new Set(list.map(c => c.id)))) {
        out.scanned.push(h.id)
        todo.push({ id: h.id, cutOff: true, ...(h.waiting ? { waiting: true } : {}), ...(h.auto ? { auto: true } : {}), reason: SCANNED })
      }
    } catch (e) { d.log?.(`the boot scan failed: ${(e as Error)?.message ?? e}`) }
  }
  if (out.idle.length) d.log?.(`${out.idle.length} idle conversation(s) left closed: their next message reopens them`)
  if (!todo.length) return out
  const stopped = d.stopped?.() ?? false
  if (stopped) d.log?.('floor/STOP exists: conversations reopen, none is continued or messaged')
  for (const c of todo) {
    const lost = Array.isArray(c.lost) ? c.lost.map(String) : []
    const cont = c.cutOff && !c.waiting && !c.auto && !stopped
    const say: Reopen['say'] = cont ? 'continue' : !c.cutOff && lost.length && !stopped ? 'lost' : null
    if (c.cutOff && c.auto) d.log?.(`${c.id}: its cut turn was itself an auto-continue: not continued again`)
    if (say && out.continued.length) await (d.sleep ?? (ms => new Promise(r => setTimeout(r, ms))))(CONTINUE_GAP_MS)   // staggered
    try {
      await d.reopen(c.id, { note: c.cutOff ? cutNote(c.reason, cont) : null, lost, say, at: now })
      out.reopened.push(c.id)
      if (say) out.continued.push(c.id)
    } catch (e) { out.failed.push(c.id); d.log?.(`reopen ${c.id}: ${(e as Error)?.message ?? e}`) }
  }
  d.log?.(`reopened ${out.reopened.length} of ${todo.length} conversation(s)${out.scanned.length ? ` (${out.scanned.length} found cut by the boot scan)` : ''}${out.continued.length ? `, ${out.continued.length} messaged to continue` : ''}${out.failed.length ? `, ${out.failed.length} failed` : ''}`)
  return out
}

export type StopDeps = {
  /** POST /api/system/leave {force}: null when fundd could not be asked at all */
  leave: (force: boolean) => Promise<{ status: number; body: { left?: boolean; error?: string } } | null>
  /** is fundd gone? (polled after it agreed to leave) */
  gone: () => Promise<boolean>
  /** the old way: taskkill the supervisor and fundd's tree */
  kill: () => void | Promise<void>
  say: (m: string) => void
  waitMs?: number
}

/**
 * `prod.mjs --stop` (B-0254): ASK fundd to leave, so it saves what is open and refuses while a turn,
 * a parked decision, background work or a terminal command runs. Exit 1 on a refusal: nothing is
 * killed. --force cuts them (saved, reopened with a note at the next start). A fundd that cannot be
 * asked (older code without the route) is killed only when forced: its journal may not exist.
 */
export async function stopProd(d: StopDeps, force: boolean): Promise<number> {
  const r = await d.leave(force).catch(() => null)
  if (r && r.status === 409) {
    d.say(`refused: ${r.body.error ?? 'fundd is not idle'}. Nothing was stopped: wait, or pass --force to cut it (saved; the next start within 10 minutes reopens it with a note)`)
    return 1
  }
  if (r && r.status === 200 && r.body.left) {
    const until = Date.now() + (d.waitMs ?? 20_000)
    while (Date.now() < until) { if (await d.gone()) { d.say('stopped (the open conversations are saved to reopen)'); return 0 } await new Promise(res => setTimeout(res, 250)) }
    if (!force) { d.say('fundd agreed to leave but is still up (work may have started since): nothing was killed; run --stop again'); return 1 }
    await d.kill()
    d.say('fundd did not leave in time: killed (its conversations were saved first)')
    return 0
  }
  if (!force) {
    d.say(`fundd could not be asked to leave (${r ? `HTTP ${r.status}: older code without /api/system/leave` : 'no answer'}): killing it would cut whatever runs unsaved. Wait for it to restart onto current code, or pass --force`)
    return 1
  }
  await d.kill()
  d.say('stopped (forced kill: fundd could not be asked to leave)')
  return 0
}

export type Child = { pid: number | undefined; exited: Promise<number | null> }

/**
 * THE SUPERVISOR (scripts/prod.mjs): start fundd, and start it again each time it exits with
 * RESTART_CODE; any other exit ends the loop with that code (a crash, Ctrl+C, --stop).
 */
export async function supervise(o: { start: () => Child; started?: (pid: number | undefined, n: number) => void; log?: (m: string) => void }): Promise<number | null> {
  for (let n = 0; ; n++) {
    const c = o.start()
    o.started?.(c.pid, n)
    const code = await c.exited
    if (code !== RESTART_CODE) return code
    o.log?.(`fundd pid ${c.pid} exited to restart: starting the next one`)
  }
}

/**
 * the names of a process's DIRECT children, [] when it has none, null when unreadable. A terminal's
 * shell with no child sits at its prompt; one with a child is running a command (measured
 * 2026-09-27 on ConPTY: an idle powershell has none, `ping` shows PING.EXE). node-pty's `process`
 * cannot say it on Windows: there it is the terminal's name ('xterm-256color'), never the foreground.
 */
export function childNames(pid: number): Promise<string[] | null> {
  if (!Number.isInteger(pid) || pid <= 0) return Promise.resolve(null)
  const [file, args] = process.platform === 'win32'
    ? ['powershell', ['-NoProfile', '-NonInteractive', '-Command', `Get-CimInstance Win32_Process -Filter 'ParentProcessId=${pid}' | ForEach-Object { $_.Name }`]]
    : ['ps', ['-o', 'comm=', '--ppid', String(pid)]]
  return new Promise(res => {
    execFile(file as string, args as string[], { windowsHide: true, timeout: 10_000 }, (err, stdout) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : -1) : 0
      // ps exits 1 when the process has no children: that is an answer, not a failure
      if (code !== 0 && !(process.platform !== 'win32' && code === 1)) return res(null)
      res(String(stdout).split(/\r?\n/).map(s => s.trim()).filter(Boolean))
    })
  })
}
