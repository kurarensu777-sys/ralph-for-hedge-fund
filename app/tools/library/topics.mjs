// Book topics from a shell: suggest them, and write a reviewed map of them back (shared/bookmeta.ts is
// the grammar; a shelf's list is the `topics:` map of its top _series.md). Run from anywhere:
//   node app/tools/library/topics.mjs --suggest [--shelf <id>] [--all] [--json]
//       path | current | suggested | why, for every book on a shelf that names a list; --all every
//       shelf; --json the {path: [topics]} map of the non-empty suggestions, ready to review and hand
//       to --apply
//   node app/tools/library/topics.mjs --apply <file.json>
//       {"<fund-relative book path>": ["topic", ...]} written with setTopics; refuses the whole file
//       (writes nothing, exit 1) when any path is not a book of a shelf or any topic is off its list
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTopics, topicFault, topicsOf, vocabOf } from '../../shared/bookmeta.ts'

const FUND = process.env.FUND_ROOT ? resolve(process.env.FUND_ROOT) : resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const arg = k => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined }
const has = k => process.argv.includes(k)
const NOT_A_BOOK = new Set(['readme.md', 'agents.md', 'claude.md', '_series.md'])
const read = rel => { try { return readFileSync(join(FUND, rel), 'utf8') } catch { return null } }
const dirs = rel => { try { return readdirSync(join(FUND, rel), { withFileTypes: true }).filter(e => e.isDirectory() && !/^[._]/.test(e.name)).map(e => e.name) } catch { return [] } }

/** every shelf: id, its top index, its roots (fund-relative), its list (null = names none) */
function shelves() {
  const out = dirs('app/library').map(id => ({ id, index: `app/library/${id}/_series.md`, roots: [`app/library/${id}`] }))
  for (const s of out) s.list = vocabOf(read(s.index) ?? '')?.map(t => t.id) ?? null
  return out
}

function books(root) {
  const out = []
  const walk = rel => {
    for (const e of readdirSync(join(FUND, rel), { withFileTypes: true })) {
      if (e.isDirectory()) walk(`${rel}/${e.name}`)
      else if (/\.md$/i.test(e.name) && !NOT_A_BOOK.has(e.name.toLowerCase())) out.push(`${rel}/${e.name}`)
    }
  }
  walk(root)
  return out.sort()
}

const words = s => new Set(String(s).toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 3))

/** [suggested topics, why] for one book */
function suggest(shelf, path, text) {
  if (!shelf.list) return [[], 'the shelf names no list']
  // words of the path and title against each topic's id and what it holds
  const vocab = vocabOf(read(shelf.index) ?? '') ?? []
  const hay = words(`${path} ${/^#\s+(.+)$/m.exec(text)?.[1] ?? ''}`)
  const hits = vocab.map(t => ({ id: t.id, w: [...words(`${t.id} ${t.holds}`)].filter(w => hay.has(w)) })).filter(h => h.w.length)
    .sort((a, b) => b.w.length - a.w.length).slice(0, 3)
  return hits.length ? [hits.map(h => h.id), `words: ${[...new Set(hits.flatMap(h => h.w))].join(', ')}`] : [[], 'no word in common: a person decides']
}

function runSuggest() {
  const only = arg('--shelf')
  const rows = []
  for (const s of shelves()) {
    if (only ? s.id !== only : !has('--all') && !s.list) continue
    for (const root of s.roots) for (const p of books(root)) {
      const text = read(p) ?? ''
      const [sug, why] = suggest(s, p, text)
      rows.push({ path: p, current: topicsOf(text) ?? [], suggested: sug, why })
    }
  }
  if (has('--json')) {
    console.log(JSON.stringify(Object.fromEntries(rows.filter(r => r.suggested.length).map(r => [r.path, r.suggested])), null, 2))
    return 0
  }
  console.log('path | current | suggested | why')
  for (const r of rows) console.log(`${r.path} | ${r.current.join(', ') || '-'} | ${r.suggested.join(', ') || '-'} | ${r.why}`)
  console.log(`${rows.length} books · ${rows.filter(r => r.suggested.length).length} with a suggestion · ${rows.filter(r => r.current.length).length} already carry topics`)
  return 0
}

function runApply(file) {
  let map
  try { map = JSON.parse(readFileSync(file, 'utf8')) } catch (e) { console.error(`topics: cannot read ${file}: ${e.message}`); return 2 }
  const all = shelves()
  const plan = [], refused = []
  for (const [raw, topics] of Object.entries(map ?? {})) {
    const p = String(raw).replace(/\\/g, '/').replace(/^\.\//, '')
    const shelf = all.find(s => s.roots.some(r => p.startsWith(`${r}/`)))
    const text = read(p)
    if (!shelf || p.split('/').includes('..') || NOT_A_BOOK.has(p.split('/').pop().toLowerCase())) { refused.push(`${p}: not a book of a shelf`); continue }
    if (text === null) { refused.push(`${p}: no such file`); continue }
    if (!shelf.list) { refused.push(`${p}: shelf ${shelf.id} names no list (${shelf.index})`); continue }
    const fault = Array.isArray(topics) ? topicFault(topics.map(String), shelf.list.map(id => ({ id, holds: '' }))) : 'not a list of topics'
    if (fault) { refused.push(`${p}: ${fault}`); continue }
    plan.push([p, text, topics.map(String)])
  }
  if (refused.length) {
    for (const r of refused) console.error(`topics: refused ${r}`)
    console.error(`topics: nothing written (${refused.length} refused of ${Object.keys(map ?? {}).length})`)
    return 1
  }
  for (const [p, text, topics] of plan) {
    const next = setTopics(text, topics)
    if (next !== text) writeFileSync(join(FUND, p), next)
  }
  console.log(`topics: ${plan.length} books set`)
  return 0
}

if (has('--suggest')) process.exit(runSuggest())
else if (arg('--apply')) process.exit(runApply(arg('--apply')))
else { console.error('usage: topics.mjs --suggest [--shelf <id>] [--all] [--json] | --apply <file.json>'); process.exit(2) }
