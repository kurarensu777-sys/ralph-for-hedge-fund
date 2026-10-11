import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { FUND_ROOT } from '../../paths.ts'
import type { EngineId } from '../../../shared/engines.ts'

// A PROVIDER KEY reaches ONE provider's spawn and nothing else. agentEnv (env.ts) scrubs every credential-shaped
// variable out of the env a hand inherits, so a key is never in the parent env a Claude, Codex or Grok hand sees;
// this file is where fundd reads one on purpose, for the single engine that needs it, at the moment it spawns.
// Where: the machine env first (DEEPSEEK_API_KEY), then the dotenv file at the fund root, taking ONLY the variable
// the provider names. The file is never loaded into process.env and none of its other lines is kept or passed on.
// Never printed, logged, stored in a repo or returned by a route: callers get the value, the UI gets `have()`.
//
// Codex and Grok hold their own login (their CLIs' own auth files), so they have no key here.

const KEYED: Partial<Record<EngineId, { env: string }>> = {
  deepseek: { env: 'DEEPSEEK_API_KEY' },
}
export const DOTENV_NAME = '.env'

/** the variable and the root dotenv file that name this provider's key, for the line that says what is missing (null = it needs none) */
export const keyHome = (e: EngineId, root: string = FUND_ROOT): { env: string; file: string } | null => {
  const k = KEYED[e]
  return k ? { env: k.env, file: join(root, DOTENV_NAME) } : null
}

/** the value of ONE variable in dotenv text: KEY=VALUE lines, `#` comments and blanks skipped, `export ` allowed, one pair of quotes stripped; empty = absent */
export function dotenvValue(text: string, name: string): string | null {
  let found: string | null = null
  for (const raw of text.replace(/^﻿/, '').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line)
    if (!m || m[1] !== name) continue
    let v = m[2].trim()
    if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v[v.length - 1] === v[0]) v = v.slice(1, -1).trim()
    found = v || null
  }
  return found
}

export function providerKey(e: EngineId, env: Record<string, string | undefined> = process.env, root: string = FUND_ROOT): string | null {
  const k = KEYED[e]
  if (!k) return null
  const fromEnv = (env[k.env] ?? '').trim()
  if (fromEnv) return fromEnv
  try { return dotenvValue(readFileSync(join(root, DOTENV_NAME), 'utf8'), k.env) } catch { return null }
}

export const haveKey = (e: EngineId, env?: Record<string, string | undefined>, root?: string): boolean => providerKey(e, env, root) !== null

/** the line that says what is missing: names the variable and the file, never a value */
export const noKeyLine = (e: EngineId, root: string = FUND_ROOT): string => {
  const h = keyHome(e, root)!
  return `${h.env} is not set (machine env, or the line ${h.env}=... in the dotenv file ${h.file})`
}
