#!/usr/bin/env node
// The fund's git guardrails, run by the pre-commit and commit-msg shims next to this file.
// Installed by fundd as core.hooksPath in the fund repo and every repo in repos.json.
//
//   node guard.mjs pre-commit          refuse out-of-scope, execution and secret stages, a book whose
//                                      topics are off its shelf's list and an added line holding a
//                                      control character (the owner: those two warned); warn on a
//                                      chapter added without its Read when line
//   node guard.mjs commit-msg <file>   append Agent / Conversation trailers from the env; warn
//                                      (never block) when a library book shrinks > 30% or loses any
//                                      `##` heading, unlabelled
//
// FUND_AGENT unset = the owner by hand: only the secret check applies. FUND_ROOT names the fund
// root (the launch contract sets it); otherwise it is derived from this file's location.
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { agentFileName, parseAgentFile } from '../../shared/agentfile.ts'
import { addedLines, chaptersWithoutReadWhen, controlFindings, isLibraryBook, missingTrailers, norm, parseNameStatusZ, secretFindings, shelfOfBook, shelfOfIndex, shrinkReport, shrinkWarnings, topicFindings, verdict } from './guard-lib.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
// <fund>/app -> <fund> (the grandparent only while a checkout still sits at <fund>/repos/app). The
// fund root carries repos.json (agents.json, the roster until 2026-09-25, still marks an old one).
const isFund = d => existsSync(join(d, 'repos.json')) || existsSync(join(d, 'agents.json'))
const fundAbove = app => (!isFund(resolve(app, '..')) && isFund(resolve(app, '..', '..'))) ? resolve(app, '..', '..') : resolve(app, '..')
const FUND_ROOT = process.env.FUND_ROOT ? resolve(process.env.FUND_ROOT) : fundAbove(resolve(HERE, '..', '..'))

function git(args, input) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, input, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
}

/** the agent's row: the header of its roster file, <fund>/app/agents/<id>.md (shared/agentfile.ts,
 *  the one format fundd reads too); null when the file is missing or its header does not parse */
function loadAgent(id) {
  const file = join(FUND_ROOT, 'app', 'agents', agentFileName(id))
  if (!existsSync(file)) return null
  try {
    const { header } = parseAgentFile(readFileSync(file, 'utf8'))
    return header.id === id ? header : null
  } catch { return null }
}

/** the main checkout of the repo this worktree belongs to (itself when it is the main checkout) */
function mainCheckout(top) {
  try {
    const common = resolve(top, git(['rev-parse', '--git-common-dir']).trim())
    const gitDir = resolve(top, git(['rev-parse', '--git-dir']).trim())
    if (norm(common).toLowerCase() === norm(gitDir).toLowerCase()) return top
    return /[\\/]\.git$/i.test(common) ? dirname(common) : top
  } catch { return top }
}

function preCommit() {
  const agentId = process.env.FUND_AGENT || null
  // A build worktree (~/fund-data/worktrees/<repo>/<conversation>) sits outside the fund root, but
  // its paths are the repo's paths: scope them from the MAIN checkout (the common git dir's parent).
  const top = mainCheckout(resolve(git(['rev-parse', '--show-toplevel']).trim()))
  const paths = git(['diff', '--cached', '--name-only', '--no-renames', '-z']).split('\0').filter(Boolean).map(norm)
  if (!paths.length) return 0
  const fold = s => (process.platform === 'win32' ? s.toLowerCase() : s)
  const rel = norm(relative(FUND_ROOT, top))
  const outsideFund = rel.startsWith('..') || /^[a-z]:/i.test(rel) || (fold(top) !== fold(FUND_ROOT) && rel === '')
  const prefix = rel && rel !== '.' ? rel + '/' : ''
  const fundPaths = paths.map(p => prefix + p)
  const added = addedLines(git(['diff', '--cached', '-U0', '--no-color', '--no-ext-diff', '--no-renames']))
  // a DELETION never carries secret material in: removing a committed .env is the fix after a leak
  const landing = git(['diff', '--cached', '--name-only', '--no-renames', '--diff-filter=ACMR', '-z']).split('\0').filter(Boolean).map(norm)
  const secrets = secretFindings(landing, added)
  const topics = topicCheck(landing, prefix)
  const controls = controlFindings(added)
  const chapters = chapterCheck(prefix)
  const v = verdict({ agentId, agent: agentId ? loadAgent(agentId) : null, fundPaths, secrets, outsideFund, topics, controls, chapters })
  for (const w of v.warnings) process.stderr.write(`fund guard: ${w}\n`)
  if (v.ok) return 0
  process.stderr.write(`fund guard: commit refused${agentId ? ` (agent ${agentId})` : ' (owner)'}\n`)
  for (const e of v.errors) process.stderr.write(`  ${e}\n`)
  if (v.unstage) process.stderr.write('  unstage the paths above; a cross-scope need is a board item for the owning agent\n')
  return 1
}

/**
 * THE TOPICS CHECK's reads: the STAGED text of every landing book or shelf top index (`landing` is
 * repo-relative, `prefix` makes it fund-relative), and each shelf's top index as this commit leaves it
 * (`:<path>` is the index entry: the staged version when staged, else HEAD's). An index in another
 * repo cannot be read from here and asks nothing.
 */
function topicCheck(landing, prefix) {
  const staged = []
  for (const p of landing) {
    const f = prefix + p
    if (shelfOfBook(f) || shelfOfIndex(f)) staged.push({ path: f, text: blob(`:${p}`) })
  }
  if (!staged.length) return []
  const seen = new Map()
  const indexText = f => {
    if (!f.startsWith(prefix)) return null
    if (!seen.has(f)) seen.set(f, blob(`:${f.slice(prefix.length)}`))
    return seen.get(f)
  }
  return topicFindings(staged, indexText)
}

/**
 * THE WRITE-BACK WARNING: a chapter a commit adds to a chaptered book without its `Read when:` line.
 * Reads each staged library book against HEAD. Never blocks: a failure here is swallowed.
 */
function chapterCheck(prefix) {
  try {
    const first = blob('HEAD:') === null
    const pairs = []
    for (const r of parseNameStatusZ(git(['diff', '--cached', '--name-status', '-M', '-z']))) {
      if (r.status === 'D' || !isLibraryBook(prefix + r.to)) continue
      pairs.push({ path: prefix + r.to, before: first || r.status === 'A' || r.status === 'C' ? null : blob(`HEAD:${r.from}`), after: blob(`:${r.to}`) })
    }
    return chaptersWithoutReadWhen(pairs)
  } catch { return [] }
}

/** a blob's text, or null when it does not exist (git show <rev>:<path>) */
function blob(spec) {
  try { return git(['show', spec]) } catch { return null }
}

/**
 * THE BOOK SHRINK WARNING: every staged library/**.md read at HEAD against its staged blob. A
 * book losing > 30% of its lines or of its ## sections, any `##` heading outright, or deleted, warns unless the message
 * carries a `Consolidation: <reason>` trailer. Never blocks: any failure here is swallowed.
 */
function shrinkCheck(msg) {
  try {
    if (blob('HEAD:') === null) return // the first commit: nothing to shrink from
    const rows = parseNameStatusZ(git(['diff', '--cached', '--name-status', '-M', '-z']))
    const pairs = []
    for (const r of rows) {
      if (!isLibraryBook(r.to) && !isLibraryBook(r.from)) continue
      const before = r.status === 'A' || r.status === 'C' ? null : blob(`HEAD:${r.from}`)
      const after = r.status === 'D' ? null : blob(`:${r.to}`)
      pairs.push({ path: r.status === 'D' ? r.from : r.to, before, after })
    }
    if (!pairs.length) return
    for (const w of shrinkWarnings(shrinkReport(pairs, msg))) process.stderr.write(`fund guard: ${w}\n`)
  } catch { /* a warning that cannot be computed is no warning; the commit goes on */ }
}

function commitMsg(file) {
  if (!file) return 0
  const msg = readFileSync(file, 'utf8')
  shrinkCheck(msg.split('\n').filter(l => !l.startsWith('#')).join('\n'))
  const add = missingTrailers(msg.split('\n').filter(l => !l.startsWith('#')).join('\n'), process.env)
  if (!add.length) return 0
  const args = ['interpret-trailers', '--in-place', '--if-exists', 'doNothing']
  for (const [k, v] of add) args.push('--trailer', `${k}: ${v}`)
  args.push(file)
  git(args)
  return 0
}

let code = 0
try {
  const [hook, arg] = process.argv.slice(2)
  if (hook === 'pre-commit') code = preCommit()
  else if (hook === 'commit-msg') code = commitMsg(arg)
  else { process.stderr.write(`fund guard: unknown hook ${hook}\n`); code = 2 }
} catch (e) {
  // A guard that cannot read git or the roster fails CLOSED for an agent and open for the owner.
  process.stderr.write(`fund guard: ${e?.message ?? e}\n`)
  code = process.env.FUND_AGENT ? 1 : 0
}
process.exit(code)
