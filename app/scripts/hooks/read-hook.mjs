#!/usr/bin/env node
// Claude Code PostToolUse hook (matcher: Read). When an agent the cockpit booted reads a .md under
// a shelf home (app/library - the one library, the legacy root library/)
// or the lab (platform/lab, the legacy root lab/), tell fundd so the library can show who pulled which book:
//   POST http://127.0.0.1:4689/api/library/read  {agent, conversation, path}
// It NEVER blocks and never fails the tool call: every failure path (bad stdin, no FUND_AGENT, a
// file outside those, fundd down or slow) exits 0 silently.
import { existsSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const done = () => process.exit(0)
process.on('uncaughtException', done)
process.on('unhandledRejection', done)
setTimeout(done, 2500).unref()   // hard cap: a hook must never hang the agent

// <fund>/app -> <fund> (the grandparent only while a checkout still sits at <fund>/repos/app)
const isFund = d => existsSync(join(d, 'repos.json')) || existsSync(join(d, 'agents.json'))   // the fund root carries repos.json
const fundAbove = app => (!isFund(resolve(app, '..')) && isFund(resolve(app, '..', '..'))) ? resolve(app, '..', '..') : resolve(app, '..')
const FUND_ROOT = process.env.FUND_ROOT ? resolve(process.env.FUND_ROOT) : fundAbove(resolve(dirname(fileURLToPath(import.meta.url)), '..', '..'))
const PORT = Number(process.env.FUNDD_PORT || 4689)
const agent = process.env.FUND_AGENT
const conversation = process.env.FUND_CONVERSATION || null

/** server/library/reads.ts TRACKED, the same pattern, character for character (test/library-plus.test.ts
 *  reads this line and holds the two together); fundd turns a platform/lab path into its logical lab/
 *  spelling on arrival */
const TRACKED = /^(library|lab|app\/library|platform\/lab)\/.+\.md$/i

/** the fund-relative path of a tracked .md, or null */
function tracked(file, root = FUND_ROOT) {
  if (typeof file !== 'string' || !file) return null
  const abs = isAbsolute(file) ? file : resolve(process.cwd(), file)
  let rel = relative(root, abs)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null
  rel = rel.split('\\').join('/')
  return TRACKED.test(rel) ? rel : null
}


async function main() {
  if (!agent) return done()            // not a cockpit agent (the owner's own session): nothing to record
  let raw = ''
  process.stdin.setEncoding('utf8')
  for await (const chunk of process.stdin) { raw += chunk; if (raw.length > 4_000_000) return done() }
  let ev
  try { ev = JSON.parse(raw) } catch { return done() }
  if (ev?.tool_name !== 'Read') return done()
  const path = tracked(ev?.tool_input?.file_path)
  if (!path) return done()
  try {
    await fetch(`http://127.0.0.1:${PORT}/api/library/read`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agent, conversation, path }),
      signal: AbortSignal.timeout(1500),
    })
  } catch { /* fundd down: the read is lost, the agent is not */ }
  done()
}

main()
