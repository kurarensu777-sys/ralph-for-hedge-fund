import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import type { SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import type { ContextUse, ForeignHand } from './types.ts'

// A FOREIGN HAND: one CLI process per turn. The Agent SDK holds ONE long-lived child per conversation and streams
// both ways down it; `codex exec` and `grok -p` are one-shot, with continuity carried by a session id the CLI hands
// back and takes again on resume. So this hand is a LOOP: wait for the owner's message, run the CLI, translate its
// stream line by line into SDK-shaped messages (the adapter each engine supplies), let it exit, wait again. The
// conversation lives in the CLI's own store, so a crashed turn takes nothing else with it, and fundd restarting
// between turns costs nothing. What it costs is mid-turn control: no live model swap, no parked decision, one
// interrupt that ends the turn. shared/engines.ts CAPS says so, and the screen says it.

export type ForeignState = {
  sessionId?: string          // the CLI's own thread id - what resume takes
  usage?: ContextUse          // how full the window is, as the engine itself reports it
  turn: number                // this process's turn count: 0 = nothing sent to this session yet
  model?: string
  tag: string                 // unique per turn: a CLI that restarts its message ids at msg_0 every turn must not overwrite the last turn's rows
  started?: Set<string>       // tool items announced but not answered (codex)
  cum?: { cost: number; models: Record<string, Record<string, number>> }   // usage is cumulative per hand: the runner diffs it, a one-shot CLI reports per turn
  lastIn?: number             // the last request's whole input, for the gauge
}

export type ForeignSpec = {
  label: string               // 'Grok', for the lines that name it
  bin: string
  cwd: string
  env: Record<string, string | undefined>
  model: string               // bare, the routing prefix off
  /** argv for ONE turn; `promptFile` is set when prompt === 'file' */
  argv: (a: { model: string; resumeId: string | undefined; promptFile?: string }) => string[]
  prompt: 'stdin' | 'file'
  adapt: (raw: Record<string, unknown>, st: ForeignState) => SDKMessage[]
  /** the role, brief and boot books: the SDK path appends them to its system prompt; a CLI gets them in front of
   *  the first message of a fresh session only (a resumed one already holds them) */
  preamble?: string
  signal: AbortSignal
  seed?: { sessionId?: string }
}

/** the owner's message as the CLI wants it: flat text (the runner refuses an image before it gets here) */
export function promptText(m: SDKUserMessage): string {
  const c = (m as { message?: { content?: unknown } }).message?.content
  if (typeof c === 'string') return c
  if (!Array.isArray(c)) return ''
  return c.filter((b): b is { type: 'text'; text: string } => !!b && typeof b === 'object' && (b as { type?: string }).type === 'text').map(b => b.text).join('\n')
}

/** a .cmd/.bat shim (npm installs Codex as one) cannot be spawned without a shell on current Node: quote for cmd.exe then */
export function spawnPlan(bin: string, args: string[], win = process.platform === 'win32'): { cmd: string; args: string[]; shell: boolean } {
  if (!win || !/\.(cmd|bat)$/i.test(bin)) return { cmd: bin, args, shell: false }
  const q = (s: string) => (/[\s"&|<>^%]/.test(s) || s === '' ? `"${s.replace(/"/g, '\\"')}"` : s)
  return { cmd: q(bin), args: args.map(q), shell: true }
}

function killTree(c: ChildProcessWithoutNullStreams) {
  if (c.pid && process.platform === 'win32') { try { spawnSync('taskkill', ['/pid', String(c.pid), '/T', '/F'], { windowsHide: true }) } catch { /* gone already */ } }
  else c.kill('SIGTERM')
}

const failed = (sid: string, text: string, subtype = 'error_during_execution'): SDKMessage =>
  ({ type: 'result', subtype, is_error: true, session_id: sid, uuid: `fx-${Date.now().toString(36)}`, result: text }) as unknown as SDKMessage

export function spawnForeign(spec: ForeignSpec, prompts: AsyncIterable<SDKUserMessage>): ForeignHand {
  const st: ForeignState = { turn: spec.seed?.sessionId ? 1 : 0, sessionId: spec.seed?.sessionId, model: spec.model, tag: '' }
  let child: ChildProcessWithoutNullStreams | null = null
  let interrupted = false
  let n = 0
  spec.signal.addEventListener('abort', () => { if (child) killTree(child) }, { once: true })

  async function* run(): AsyncGenerator<SDKMessage> {
    for await (const user of prompts) {
      if (spec.signal.aborted) return
      interrupted = false
      let text = promptText(user)
      if (!text.trim()) continue
      if (st.turn === 0 && spec.preamble) text = `${spec.preamble}\n\n---\n\n${text}`
      st.turn++
      st.tag = `${Date.now().toString(36)}${(n++).toString(36)}-`

      let dir: string | null = null
      let promptFile: string | undefined
      if (spec.prompt === 'file') { dir = mkdtempSync(join(tmpdir(), 'fund-turn-')); promptFile = join(dir, 'prompt.txt'); writeFileSync(promptFile, text) }
      const plan = spawnPlan(spec.bin, spec.argv({ model: spec.model, resumeId: st.sessionId, promptFile }))
      const c = spawn(plan.cmd, plan.args, { cwd: spec.cwd, env: spec.env as NodeJS.ProcessEnv, stdio: ['pipe', 'pipe', 'pipe'], shell: plan.shell, windowsHide: true })
      child = c
      // A failed spawn (ENOENT: the CLI is not there) reaches us twice, and both must be caught or one turn takes
      // fundd down: the `error` event (attached first, unconditionally) and a synchronous throw from the write.
      let spawnErr: Error | null = null
      const errored = new Promise<Error>(r => c.once('error', (e: Error) => { spawnErr = e; r(e) }))
      try {
        if (spec.prompt === 'stdin') c.stdin.write(text)
        c.stdin.end()
      } catch {
        const err = spawnErr ?? await errored
        child = null
        if (dir) rmSync(dir, { recursive: true, force: true })
        yield failed(st.sessionId ?? '', `${spec.label}: ${spec.bin} is not available (${err.message})`)
        continue
      }
      c.stdin.on('error', () => { /* the CLI closed its stdin early: the exit code says why */ })

      // stderr is drained and kept, never streamed: only a turn that produced nothing has anything to report from it
      let errTail = ''
      c.stderr.on('data', (b: Buffer) => { errTail = (errTail + b.toString()).slice(-2000) })

      let sawAny = false, sawResult = false
      const lines = createInterface({ input: c.stdout, crlfDelay: Infinity })
      for await (const line of lines) {
        const s = line.trim()
        if (!s || s[0] !== '{') continue            // human chatter on stdout
        let raw: Record<string, unknown>
        try { raw = JSON.parse(s) } catch { continue }
        for (const m of spec.adapt(raw, st)) { sawAny = true; if (m.type === 'result') sawResult = true; yield m }
      }
      const code: number = await new Promise(r => { if (c.exitCode !== null) r(c.exitCode); else c.on('close', x => r(x ?? 0)) })
      child = null
      if (dir) rmSync(dir, { recursive: true, force: true })
      if (spec.signal.aborted) return
      // the owner's Stop: close the turn the way the SDK does (an error result the runner swallows) so busy clears
      if (interrupted) { yield failed(st.sessionId ?? '', 'Interrupted'); continue }
      if (!sawResult) {
        const why = spawnErr ? `${spec.bin} is not available (${(spawnErr as Error).message})` : errTail.trim() || `${spec.bin} exited ${code} ${sawAny ? 'before the turn finished' : 'without output'}`
        yield failed(st.sessionId ?? '', `${spec.label}: ${why}`)
      }
    }
  }

  const stream = run()
  return {
    [Symbol.asyncIterator]: () => stream[Symbol.asyncIterator](),
    sessionId: () => st.sessionId ?? null,
    async getContextUsage() { if (!st.usage) throw new Error('no usage reported yet'); return st.usage },
    // both knobs are per-INVOCATION on a one-shot CLI: the runner reboots the hand on a change, so there is nothing to push
    async setModel() { throw new Error(`${spec.label} takes its model at the next boot`) },
    async stopTask() { throw new Error(`${spec.label} holds no background tasks the cockpit can stop`) },
    // ends the TURN; the loop stays open, so the next message spawns a fresh invocation that resumes the same session
    async interrupt() { if (!child) return; interrupted = true; killTree(child) },
  }
}
