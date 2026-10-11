import { execFile } from 'node:child_process'

export type Out = { code: number; stdout: string; stderr: string }

/**
 * Run git with no prompt ever: a fetch that wants credentials fails instead of hanging the
 * daemon (GIT_TERMINAL_PROMPT=0, GCM_INTERACTIVE=never). Never throws; the exit code is data.
 *
 * fundd commits as the OWNER, whoever launched it: FUND_AGENT / FUND_CONVERSATION are dropped from
 * the env, so a fundd started from an agent's shell never has the guard hooks scope its commits
 * (loop apply/revert, library save, chat revert) to that agent or stamp that conversation's trailer.
 */
export function gitEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' }
  delete out.FUND_AGENT
  delete out.FUND_CONVERSATION
  return out
}

/** run git (see gitEnv for the environment it gets) */
export function git(cwd: string, args: string[], timeoutMs = 30_000): Promise<Out> {
  return new Promise(resolve => {
    execFile('git', args, {
      cwd,
      timeout: timeoutMs,
      maxBuffer: 32 * 1024 * 1024,
      windowsHide: true,
      env: gitEnv(),
    }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as any).code === 'number' ? (err as any).code : 1) : 0
      resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') || (err && !stderr ? String(err.message) : '') })
    })
  })
}
