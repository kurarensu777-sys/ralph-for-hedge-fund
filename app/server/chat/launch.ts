import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import type { McpServerConfig, Options } from '@anthropic-ai/claude-agent-sdk'
import type { Agent } from '../../shared/types.ts'
import { briefBody } from '../../shared/agentfile.ts'
import { chapterOf, splitRef } from '../../shared/bookmeta.ts'
import { FUND_ROOT, LEGACY_CWD, MCP_FILES_REL, briefOf, inFund, legacyDeskFragment } from '../paths.ts'
import { agentEnv, prependPath } from './env.ts'
import { worktreeCwd } from '../git/wtpath.ts'
import { exactOf, permittedNow } from './models.ts'
import { bareModel, engineOf, nearestEffort, type EngineId } from '../../shared/engines.ts'
import { DEEPSEEK_DECLARED, providersNow } from './engines/catalog.ts'
import { noKeyLine, providerKey } from './engines/keys.ts'

// THE LAUNCH CONTRACT (app/CLAUDE.md), defined ONCE, here. Ported from machine/server/org.ts
// buildSpawnOptions, where each clause was learned the hard way:
//
//   cwd                    the agent's `cwd` from its roster file (app/agents/<id>.md), fund-relative, resolved under
//                          FUND_ROOT. The cwd IS the CLAUDE.md chain: where it stands is what it read.
//   settings               <fund>/.claude/settings.json passed EXPLICITLY. Claude Code reads
//                          .claude/settings.json from the launch dir only, so an agent whose cwd is
//                          a subfolder never had the fund's law in the room (measured 2026-09-21).
//                          Under bypassPermissions the DENY list in that file is the whole gate.
//   additionalDirectories  the fund root (+ the agent's own `reads`), so any agent reads the law.
//   systemPrompt.append    the agent's role, then its BRIEF (app/agents/<id>.md), then the
//                          FULL TEXT of every book in its boot list.
//   permissionMode         'bypassPermissions' - the owner's standing setting (2026-09-22).
//   perTaskStopAffordance  true: Stop (interrupt) aborts the turn and spares background commands and subagents; the CLI
//                          kills them all without it (B-0560). One task is stopped through runner.stopTask.
//   env                    the parent env, scrubbed (env.ts), + FUND_AGENT / FUND_CONVERSATION /
//                          FUND_ROOT, with the fund root and the fund venv (<fund>/.venv) on PATH so an agent
//                          types plain `fund ...` / `python ...`, which is what the allow list matches.
//   model / effort         its roster file, unless this conversation overrides them. The model is an EXACT
//                          id from Claude Code's own permitted list (models.ts); an alias still stored boots
//                          on the exact id it resolves to, and a model that takes no effort is sent none.
//   mcpServers             every server in the fund root's .mcp.json, then app/.mcp.json (a name the
//                          root already gave is not overridden), passed EXPLICITLY for every boot: a
//                          project .mcp.json is read from the cwd only, and every agent's cwd is a
//                          sub-repo. A relative `command` is made absolute against the folder of the
//                          file that names it (../.venv/Scripts/python.exe in app/.mcp.json is
//                          <fund>/.venv/Scripts/python.exe); its `env` is kept, minus anything
//                          credential-shaped (env.ts).

export const SETTINGS_FILE = join(FUND_ROOT, '.claude', 'settings.json')
export const SEAT_MODE: NonNullable<Options['permissionMode']> = 'bypassPermissions'
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const

/** Claude Code slugs a cwd by replacing EVERY non-alphanumeric byte with '-'. */
export const projectSlug = (p: string) => p.replace(/[^A-Za-z0-9-]/g, '-')
export const transcriptDir = (cwdAbs: string) => join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'projects', projectSlug(cwdAbs))
export const transcriptFile = (cwdAbs: string, uuid: string) => join(transcriptDir(cwdAbs), `${uuid}.jsonl`)

export const pathDirs = (): string[] =>
  [FUND_ROOT, join(FUND_ROOT, '.venv', 'Scripts'), join(FUND_ROOT, '.venv', 'bin')].filter(d => existsSync(d))

// THE 2026-09-24 CUT-OVER moved every agent's cwd (crypto -> platform, crypto/research ->
// research, desks -> lab), and 2026-09-25 lifted repos/<x> to <x>. Claude Code files a transcript under the slug of the cwd it ran
// in, so history begun before the cut-over sits under the OLD slugs. These map a new fund-relative
// cwd to the old ones it replaced, newest rule first; only used to FIND history.
// new -> old, built from the ONE cwd table in paths.ts (LEGACY_CWD), plus lab/ <- desks/
const LEGACY_PREFIX: [string, string][] = [...LEGACY_CWD.map(([then, now]) => [now, then] as [string, string]), ['lab', 'desks']]
/** the fund-relative cwds this one replaced at the cut-over ('' prefix-free input returns []) */
export function legacyCwds(rel: string): string[] {
  const r = (rel || '.').replace(/\\/g, '/').replace(/\/+$/, '')
  const out: string[] = []
  for (const [now, then] of LEGACY_PREFIX) {
    const old = then + r.slice(now.length)
    if ((r === now || r.startsWith(now + '/')) && !out.includes(old)) out.push(old)
  }
  // a lab desk renamed after the cut-over (lab/platform/data was lab/api/data, and desks/api/data
  // before that): its history sits under both old slugs
  if (r.startsWith('lab/')) {
    const old = legacyDeskFragment(r.slice(4))
    if (old) return [`lab/${old}`, `desks/${old}`]
  }
  return out
}
/** is this absolute cwd one of the retired trees (crypto/, machine/, desks/, repos/)? */
export function isLegacyCwd(abs: string): boolean {
  const rel = abs.slice(FUND_ROOT.length).replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase()
  if (!abs.toLowerCase().startsWith(FUND_ROOT.toLowerCase()) || !rel) return false
  return ['crypto', 'machine', 'desks', 'repos'].some(p => rel === p || rel.startsWith(p + '/'))
}

export function agentCwd(a: Agent): string {
  const abs = inFund(a.cwd || '.')
  if (!abs) throw new Error(`${a.id}: cwd ${a.cwd} escapes the fund root`)
  return abs
}

/**
 * Where a conversation launches: its build worktree when it is on a branch (the Git room cut one,
 * ~/fund-data/worktrees/<repo>/<conversation>), else the agent's own cwd. The worktree is on disk
 * exactly while the branch is unlanded, so this is read at every boot, never cached.
 */
export function launchCwd(a: Agent, conversationId: string): string {
  const home = agentCwd(a)
  return worktreeCwd(home, conversationId) ?? home
}

/** the system-prompt paragraph a conversation on a build branch gets (null = on main) */
export function branchNote(cwd: string, home: string): string | null {
  if (cwd.toLowerCase() === home.toLowerCase()) return null
  return '# You are on a build branch\n\n' + `Your cwd is a git worktree of your repo on its own branch, not the main checkout (${home}). Edit, test and commit HERE, on this branch, with explicit paths. Do not touch the main checkout, do not switch branches, rebase or push: the owner lands the branch from the Git room's land queue (rebase onto main, the repo's verify, fast-forward, push). A red land comes back to this conversation with the failure.`
}

/**
 * THE TRADING GUARD for a CLI engine (Codex, Grok). A Claude seat is fenced by the fund's deny list in
 * <fund>/.claude/settings.json; Grok is handed that same list as --deny rules (engines/grok.ts) and Codex runs in its
 * own workspace-write sandbox, but neither fence is the one the deny list is for execution/. So a seat whose folder is
 * execution/, or the fund root (which holds it), or whose writes include execution/, never gets a foreign engine.
 * Returns the reason, or null when the seat may run on one.
 */
export function foreignRefusal(a: Pick<Agent, 'cwd' | 'writes'>): string | null {
  const rel = (a.cwd || '.').replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '')
  if (rel === '' || rel === '.') return 'its folder is the fund root, which holds execution/ (a Claude seat only)'
  if (rel === 'execution' || rel.startsWith('execution/')) return 'its folder is execution/ (a Claude seat only)'
  if ((a.writes ?? []).some(w => /^(\.\/)?execution(\/|$)/.test(w.replace(/\\/g, '/')))) return 'it may write under execution/ (a Claude seat only)'
  return null
}

export type McpRead = {
  servers: Record<string, McpServerConfig>
  from: string[]                  // the fund-relative files that were read, in order
  problems: string[]              // a file that does not parse, a server with no command or url, a command not on disk
}

/**
 * The MCP servers every seat carries: each file of `files` (fund-relative, paths.ts MCP_FILES_REL:
 * the root's .mcp.json, then app/.mcp.json) that exists, merged in order, the first to name a
 * server keeping it. A stdio server's relative `command` (one with a path separator) is resolved
 * against its file's folder; a bare command (`python`) is left to PATH. Its `env` is scrubbed with
 * agentEnv, so a .mcp.json can never carry a credential across the spawn boundary. A problem is
 * named and the rest still load; a server whose command is not on disk is still passed (the
 * session then reports it failed, which is the honest reading).
 */
export function mcpServers(fundRoot: string = FUND_ROOT, files: readonly string[] = MCP_FILES_REL): McpRead {
  const servers: Record<string, McpServerConfig> = {}
  const from: string[] = []
  const problems: string[] = []
  for (const rel of files) {
    const abs = join(fundRoot, rel)
    if (!existsSync(abs)) continue
    let doc: any
    try { doc = JSON.parse(readFileSync(abs, 'utf8')) } catch (e) { problems.push(`${rel}: unreadable (${(e as Error).message})`); continue }
    from.push(rel)
    const list = doc?.mcpServers
    if (!list || typeof list !== 'object' || Array.isArray(list)) { problems.push(`${rel}: no mcpServers object`); continue }
    for (const [name, raw] of Object.entries(list as Record<string, any>)) {
      if (name in servers) continue
      if (raw && typeof raw.command === 'string' && raw.command.trim()) {
        const cmd = raw.command.trim()
        const command = !isAbsolute(cmd) && /[\\/]/.test(cmd) ? resolve(dirname(abs), cmd) : cmd
        if (/[\\/]/.test(command) && !existsSync(command)) problems.push(`${rel}: ${name} command ${command} is not on disk`)
        const args = Array.isArray(raw.args) ? raw.args.map(String) : []
        const env = raw.env && typeof raw.env === 'object' ? agentEnv(Object.fromEntries(Object.entries(raw.env).map(([k, v]) => [k, String(v)]))) as Record<string, string> : undefined
        servers[name] = { type: 'stdio', command, args, ...(env ? { env } : {}) }
      } else if (raw && typeof raw.url === 'string' && (raw.type === 'http' || raw.type === 'sse')) {
        servers[name] = { type: raw.type, url: raw.url } as McpServerConfig
      } else {
        problems.push(`${rel}: ${name} has neither a command nor an http/sse url`)
      }
    }
  }
  return { servers, from, problems }
}

/** text null = not loaded; `missing` says why: the file is not on disk, or it has no such chapter (B-0345) */
export type BootBook = { path: string; text: string | null; missing?: 'disk' | 'chapter' }

/** every book in the boot list, read whole, or ONE chapter when the entry is `<book>#<slug>`; a missing book or
 *  chapter is named, never silently dropped */
export function bootBooks(a: Agent): BootBook[] {
  return (a.boot ?? []).map((ref): BootBook => {
    const { path, slug } = splitRef(ref)
    const abs = inFund(path)
    let text: string | null = null
    try { text = abs ? readFileSync(abs, 'utf8') : null } catch { text = null }
    if (text === null) return { path: ref, text: null, missing: 'disk' }
    if (!slug) return { path: ref, text }
    const c = chapterOf(text, slug)
    return c ? { path: ref, text: c.text.replace(/\s+$/, '') } : { path: ref, text: null, missing: 'chapter' }
  })
}

/** the agent's brief: the body of its roster file, app/agents/<id>.md, under the YAML header (a
 *  `brief` in the header may name another file); a missing one is named, never dropped */
export function agentBrief(a: Agent): BootBook {
  const path = briefOf(a)
  const abs = inFund(path)
  try { return { path, text: abs ? briefBody(readFileSync(abs, 'utf8')) : null } } catch { return { path, text: null } }
}

/** identity, then the brief, then the boot books - in that order, so the brief frames what follows */
export function systemAppend(a: Agent, books: BootBook[], brief: BootBook | null = null): string {
  const parts = [`# You are ${a.name} (${a.id})\n\nRole: ${a.role}\nDepartment: ${a.dept}\nYou may commit only under: ${a.writes.length ? a.writes.join(', ') : '(nothing)'}`]
  if (brief) parts.push(brief.text === null ? `# Your brief ${brief.path}\n\n(missing on disk)` : `# Your brief ${brief.path}\n\n${brief.text}`)
  for (const b of books) {
    parts.push(b.text === null ? `# Boot book ${b.path}\n\n(missing ${b.missing === 'chapter' ? 'chapter' : 'on disk'})` : `# Boot book ${b.path}\n\n${b.text}`)
  }
  return parts.join('\n\n---\n\n')
}

export type LaunchInput = {
  agent: Agent
  conversationId: string
  uuid: string
  resume: boolean                 // the transcript exists: resume it, else start it under this uuid
  model?: string | null
  effort?: string | null
  resumeAt?: string | null        // rewind: resume only up to this chain entry, forked
  env?: Record<string, string | undefined>
  fundRoot?: string               // where the provider key's dotenv file is looked for (tests); default the live fund root
}

export type Launch = {
  cwd: string; brief: BootBook; books: BootBook[]; mcp: McpRead; options: Options
  engine: EngineId
  /** the id the engine itself takes: the routing prefix off */
  bare: string
  /** the effort that lands on this model's ladder ('' = the model takes none) */
  effort: string
  /** the scrubbed env this engine's process gets: a provider key is in it only for that provider */
  env: Record<string, string | undefined>
  /** role + brief + boot books (+ the branch note): the SDK path appends it to its system prompt, a CLI gets it before its first message */
  preamble: string
}

/** Anthropic's own credentials and routing are the one thing agentEnv keeps (a Claude hand needs them); no other provider's
 *  process may hold them: a Grok, Codex or DeepSeek spawn would otherwise carry the owner's Claude key to a third party. */
export function withoutAnthropic(env: Record<string, string | undefined>, engine: EngineId): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {}
  for (const [k, v] of Object.entries(env)) {
    if (/^ANTHROPIC_/.test(k) || k === 'CLAUDE_CODE_OAUTH_TOKEN' || (engine !== 'deepseek' && /^CLAUDE_CODE_(USE|MAX|SUBAGENT)_/.test(k))) continue
    out[k] = v
  }
  return out
}

/**
 * DEEPSEEK = the SAME Claude Code hand pointed at DeepSeek's Anthropic-compatible endpoint (documented by DeepSeek
 * itself): base URL, token and model are env, and env is per spawn. Every model slot is pinned to the one chosen id,
 * because Claude Code makes background calls to a small "haiku" model and subagents ask for their own - left alone
 * those would send a Claude model name to DeepSeek and fail. The key is read here, for this spawn only.
 */
export function deepseekEnv(env: Record<string, string | undefined>, bare: string, key: string): Record<string, string | undefined> {
  return {
    ...env,
    ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
    ANTHROPIC_AUTH_TOKEN: key,
    ANTHROPIC_API_KEY: undefined,          // would outrank the token and 401 against DeepSeek
    ANTHROPIC_MODEL: bare,
    ANTHROPIC_SMALL_FAST_MODEL: bare,
    ANTHROPIC_DEFAULT_OPUS_MODEL: bare,
    ANTHROPIC_DEFAULT_SONNET_MODEL: bare,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: bare,
    CLAUDE_CODE_SUBAGENT_MODEL: bare,
    // Claude Code does not know DeepSeek's window and would auto-compact at an assumed 200k (1,048,576 per DeepSeek's docs)
    CLAUDE_CODE_MAX_CONTEXT_TOKENS: '1048576',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  }
}

/**
 * The SDK hooks every seat carries. Callbacks import their stores lazily, so building a launch
 * (and this module) never opens the database.
 *   SessionStart / 'compact'   put back the full text of the books this conversation PULLED
 *                              (reread.ts); boot books survive in systemPrompt.append already.
 *   InstructionsLoaded         one law_loads row per instruction file that entered the context (law.ts).
 *   Stop                       the wake-ups and crons that will wake this session later (session_crons),
 *                              read at each turn's end: the only report of them (background.ts, B-0254).
 */
export function seatHooks(conversationId: string, agentId: string): NonNullable<Options['hooks']> {
  return {
    SessionStart: [{
      matcher: 'compact',
      hooks: [async () => {
        try {
          const { rereadContext } = await import('./reread.ts')
          const r = await rereadContext(conversationId)
          if (!r.text) return { continue: true }
          return { continue: true, hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: r.text } }
        } catch (e) {
          console.error('[chats] reread', conversationId, (e as Error).message)
          return { continue: true }
        }
      }],
    }],
    InstructionsLoaded: [{
      hooks: [async (input: any) => {
        try { const { recordLoad } = await import('./law.ts'); await recordLoad(conversationId, agentId, input) }
        catch (e) { console.error('[chats] law', conversationId, (e as Error).message) }
        return { continue: true }
      }],
    }],
    Stop: [{
      hooks: [async (input: any) => {
        try { const { setCrons } = await import('./background.ts'); setCrons(conversationId, input?.session_crons) }
        catch (e) { console.error('[chats] crons', conversationId, (e as Error).message) }
        return { continue: true }
      }],
    }],
  }
}

/** EVERYTHING a conversation needs to boot, in one object. Pure except for reading the books. */
export function buildLaunch(i: LaunchInput): Launch {
  const a = i.agent
  if (a.mode === 'dormant') throw new Error(`${a.name} is dormant - the owner has to arm it in its roster file (app/agents/) first`)
  const home = agentCwd(a)
  const cwd = launchCwd(a, i.conversationId)
  if (!existsSync(cwd)) throw new Error(`${a.name}: ${a.cwd} is not on disk`)
  const onBranch = branchNote(cwd, home)
  const books = bootBooks(a)
  const brief = agentBrief(a)
  const base: Record<string, string | undefined> = prependPath(agentEnv({
    ...(i.env ?? process.env),
    FUND_AGENT: a.id,
    FUND_CONVERSATION: i.conversationId,
    FUND_ROOT,
  }), pathDirs())
  const env: Record<string, string | undefined> = { ...base }
  const extra = [FUND_ROOT, ...(a.reads ?? []).map(r => inFund(r)).filter((d): d is string => !!d)]
    .filter((d, n, all) => d.toLowerCase() !== cwd.toLowerCase() && existsSync(d) && all.indexOf(d) === n)
  const wanted = i.model || a.model
  const engine = engineOf(wanted)
  const bare = bareModel(wanted)
  const want = String(i.effort || a.effort)
  let model: string, takes: readonly string[] | undefined, effort: string | undefined
  if (engine === 'claude') {
    model = exactOf(wanted)
    takes = permittedNow().models.find(m => m.id === model)?.efforts
    effort = (EFFORTS as readonly string[]).includes(want) && (!takes || takes.includes(want)) ? want : undefined
  } else {
    model = bare
    takes = engine === 'deepseek'
      ? DEEPSEEK_DECLARED.find(d => d.id === bare)?.efforts
      : providersNow().find(p => p.id === engine)?.read.models.find(m => m.id === wanted)?.efforts
    // an effort the model's ladder lacks lands on the nearest rung at or below it; a model that takes none gets none
    effort = takes ? nearestEffort(takes, want) || undefined : undefined
  }
  if (engine !== 'claude') {
    for (const k of Object.keys(env)) delete env[k]
    Object.assign(env, withoutAnthropic(base, engine))
  }
  if (engine === 'deepseek') {
    const key = providerKey('deepseek', i.env ?? process.env, i.fundRoot)
    if (!key) throw new Error(`DeepSeek has no key: ${noKeyLine('deepseek', i.fundRoot)}`)
    Object.assign(env, deepseekEnv(env, bare, key))
  }
  const resume = i.resume
    ? { resume: i.uuid, ...(i.resumeAt ? { resumeSessionAt: i.resumeAt, forkSession: true } : {}) }
    : { sessionId: i.uuid }
  const mcp = mcpServers()
  const preamble = systemAppend(a, books, brief) + (onBranch ? '\n\n---\n\n' + onBranch : '')
  return {
    cwd, brief, books, mcp, engine, bare, effort: effort ?? '', env, preamble,
    options: {
      cwd,
      env,
      additionalDirectories: extra,
      systemPrompt: { type: 'preset', preset: 'claude_code', append: preamble },
      model,
      ...(effort ? { effort: effort as Options['effort'] } : {}),
      permissionMode: SEAT_MODE,
      settingSources: ['user', 'project', 'local'],
      settings: SETTINGS_FILE,
      includePartialMessages: true,
      // Stop aborts the turn and nothing else: without this the CLI kills every background command and subagent on an interrupt (B-0560)
      perTaskStopAffordance: true,
      hooks: seatHooks(i.conversationId, a.id),
      ...(Object.keys(mcp.servers).length ? { mcpServers: mcp.servers } : {}),
      ...resume,
    } as Options,
  }
}
