import { isAbsolute, resolve } from 'node:path'
import { within } from '../paths.ts'

/**
 * A dashboard.json start command, split into argv WITHOUT a shell. Whitespace separates arguments;
 * double or single quotes group; a backslash is a literal (Windows paths). Nothing in the
 * string is ever interpreted: `&`, `|`, `>` are plain characters handed to the program.
 */
export function splitCmd(cmd: string): string[] {
  const out: string[] = []
  let cur = ''
  let quote: '"' | "'" | null = null
  let has = false
  for (const ch of cmd) {
    if (quote) {
      if (ch === quote) quote = null
      else cur += ch
      continue
    }
    if (ch === '"' || ch === "'") { quote = ch; has = true; continue }
    if (/\s/.test(ch)) {
      if (has) { out.push(cur); cur = ''; has = false }
      continue
    }
    cur += ch
    has = true
  }
  if (quote) throw new Error(`unterminated ${quote} in command`)
  if (has) out.push(cur)
  return out
}

export type Launch = { exe: string; args: string[]; cwd: string }

/**
 * Resolve a dashboard.json `start` block into a launch. The executable is fund-relative when it
 * carries a path separator (`.venv/Scripts/python.exe`), else a bare program name
 * found on PATH. The cwd is fund-relative and must stay under the fund root. Batch files
 * are refused: running one needs cmd.exe, which re-parses the line as a shell would.
 */
export function resolveLaunch(cmd: string, cwd: string, fundRoot: string): Launch {
  const argv = splitCmd(cmd)
  if (argv.length === 0) throw new Error('empty command')
  let exe = argv[0]
  if (/\.(bat|cmd)$/i.test(exe)) throw new Error(`refusing a batch file (${exe}): it needs a shell`)
  if (/[\\/]/.test(exe)) {
    if (isAbsolute(exe)) throw new Error(`executable must be fund-relative: ${exe}`)
    const abs = resolve(fundRoot, exe)
    if (!within(abs, fundRoot)) throw new Error(`executable escapes the fund root: ${exe}`)
    exe = abs
  }
  if (isAbsolute(cwd)) throw new Error(`cwd must be fund-relative: ${cwd}`)
  const absCwd = resolve(fundRoot, cwd || '.')
  if (!within(absCwd, fundRoot)) throw new Error(`cwd escapes the fund root: ${cwd}`)
  return { exe, args: argv.slice(1), cwd: absCwd }
}
