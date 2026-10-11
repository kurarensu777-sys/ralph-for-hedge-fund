import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { HttpError } from '../http.ts'
import { FUND_ROOT, PYTHON } from '../paths.ts'

// The DATA room's door, a process (the cockpit never imports the python data layer):
//   the store    `python -m fund_db usage|tier|prune|cache --json` (cwd the fund root) - space,
//                retention and the cache (tier/prune --json: board B-0292)
// It prints ONE JSON object on its last stdout line: {ok: true, ...} or {ok: false, status, error}.
// FUND_STORE_CMD (a JSON array: the command and its first args) swaps the door for a fixture, so a
// test or a screenshot never touches the real lake.

export const STORE_CLI = ['-m', 'fund_db']
export const ACTOR = 'owner@cockpit'

/** a door that is not there (the module is missing, the venv is missing): NOT AVAILABLE, never a zero */
export class Unavailable extends Error {}

/** a door's own {ok: false} reply, kept whole: fund_db's part-way apply still lists what moved */
export class Refused extends HttpError {
  constructor(status: number, message: string, public reply: any) { super(status, message) }
}

type Door = { cmd: string; args: string[]; cwd: string; name: string }

function door(env: string | undefined, fallback: string[], cwd: string, name: string): Door {
  if (env) {
    const a = JSON.parse(env) as string[]
    return { cmd: a[0], args: a.slice(1), cwd, name }
  }
  return { cmd: existsSync(PYTHON) ? PYTHON : 'python', args: fallback, cwd, name }
}
export const storeDoor = () => door(process.env.FUND_STORE_CMD, STORE_CLI, FUND_ROOT, 'fund_db')

const lastLine = (s: string) => s.trim().split(/\r?\n/).pop() ?? ''
/** JSON.parse that keeps an integer past 2^53 as its exact digits (JSON.rawJSON), so it goes back to
 *  the child unchanged: a file's mtime_ns (~1.8e18) read with a plain parse is rounded, and a plan
 *  that digests it no longer matches its own id */
export const parseExact = (s: string): any => JSON.parse(s, (_k, v, ctx?: { source?: string }) =>
  typeof v === 'number' && Number.isInteger(v) && !Number.isSafeInteger(v) && ctx?.source ? (JSON as any).rawJSON(ctx.source) : v)

const MISSING = /No module named ['"]?fund_db['"]?|ENOENT|unrecognized arguments: --json|invalid choice/

/** the reply read off a finished child: its JSON, a refusal, or why there is none */
export function readReply(d: Door, code: number | null, stdout: string, stderr: string): any {
  let j: any = null
  try { j = parseExact(lastLine(stdout)) } catch {
    try { j = parseExact(stdout) } catch { /* below */ }   // an indented object (fund_db usage --json)
  }
  if (j && typeof j === 'object' && j.ok === true) return j
  // a CLI that predates the {ok} envelope: exit 0 and one object is its success
  if (code === 0 && j && typeof j === 'object' && !Array.isArray(j) && !('ok' in j)) return j
  if (j && typeof j === 'object' && j.ok === false) throw new Refused(Number.isInteger(j.status) && j.status >= 400 && j.status < 600 ? j.status : 500, String(j.error ?? `${d.name} refused`), j)
  const tail = lastLine(stderr) || lastLine(stdout)
  if (MISSING.test(stderr) || MISSING.test(tail)) throw new Unavailable(`${d.name} is not there yet: ${tail.slice(0, 240)}`)
  throw new HttpError(502, `${d.name} printed no JSON (exit ${code ?? 'killed'})${tail ? `: ${tail.slice(0, 240)}` : ''}`)
}

const childEnv = () => ({ ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' })

/** run one command to its end; stdin (when given) is written as JSON */
export function run(d: Door, args: string[], stdin?: unknown, timeoutMs = 180_000): Promise<any> {
  return new Promise((res, rej) => {
    let out = '', err = ''
    const child = spawn(d.cmd, [...d.args, ...args], { cwd: d.cwd, windowsHide: true, env: childEnv() })
    const timer = setTimeout(() => child.kill(), timeoutMs)
    child.stdout.on('data', b => { if (out.length < 64 * 1024 * 1024) out += b })
    child.stderr.on('data', b => { if (err.length < 256 * 1024) err += b })
    child.on('error', e => { clearTimeout(timer); rej(new Unavailable(`${d.name} could not start: ${e.message}`)) })
    child.on('close', code => {
      clearTimeout(timer)
      try { res(readReply(d, code, out, err)) } catch (e) { rej(e) }
    })
    child.stdin.on('error', () => { /* a child that exits before reading stdin reports through close */ })
    child.stdin.end(stdin === undefined ? '' : JSON.stringify(stdin))
  })
}
