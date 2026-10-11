// The git guardrails' rules, as pure functions over strings and lists. No I/O here: guard.mjs
// reads git and the roster, this file decides. Plain ESM (no TypeScript, no deps) because git
// runs it through `node` from a hook, outside the cockpit's build. Its one import is the book-topics
// grammar (shared/bookmeta.ts, type annotations only: node strips them, as for guard.mjs's agentfile.ts).
import { chaptersOf, topicFault, topicsOf, typeFault, vocabFaults, vocabOf } from '../../shared/bookmeta.ts'

/** a fund-relative path, forward slashes, no leading ./ or / */
export function norm(p) {
  return String(p).replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/^\/+/, '')
}

/**
 * Does a writes entry cover a fund-relative path? An entry ending in "/" is a folder prefix;
 * any other entry covers that exact file, or that folder when the path continues under it.
 * "." or "" covers everything (never granted today, but honest if it is).
 */
export function covers(entry, path) {
  const e = norm(entry)
  const p = norm(path)
  if (e === '' || e === '.' || e === './') return true
  if (e.endsWith('/')) return p.startsWith(e)
  return p === e || p.startsWith(e + '/')
}

/** the staged fund-relative paths no entry of `writes` covers */
export function outOfScope(writes, paths) {
  return paths.filter(p => !writes.some(w => covers(w, p)))
}

/**
 * The execution layer, two spellings, fund-relative: the fund-execution repo at the fund root
 * (`execution/`, since 2026-09-24) and the old platform shim `api/execution` at any depth (an old
 * clone still has it). Only the ROOT `execution/` counts for the repo: a book ABOUT execution
 * (a library chapter) is a book, not the order path.
 */
export function isExecution(path) {
  const p = norm(path)
  return /^execution(\/|$)/.test(p) || isLegacyExecution(p)
}

/**
 * The old shim `api/execution`: still refused to every agent whatever its `writes` say (B-0077).
 * The repo at the fund root is not: the owner's word of 2026-10-04 ("this repo, agents can
 * commit") makes its scope follow `writes` like any other repo (B-0427). The live-trading rails
 * are not in this file: the root deny rows and the arm-flag rows in .claude/settings.json.
 */
export function isLegacyExecution(path) {
  return /(^|\/)api\/execution(\/|$)/.test(norm(path))
}

/**
 * A board item file (app/board/B-NNNN.md) is every agent's to stage: filing work for another agent
 * is the cross-scope channel itself, so the guard cannot tell the filer to file it for someone else.
 * Only the item files: config.json (the owner's switches), done/ and every other path keep their scope.
 */
export function isBoardItem(path) {
  return /^app\/board\/B-\d{4,}\.md$/.test(norm(path))
}

const SECRET_FILE_OK = /\.env\.(example|sample|template|dist)$/i

/** a file whose NAME says it holds key material, whatever its content */
export function secretFileReason(path) {
  const base = norm(path).split('/').pop() ?? ''
  if (/^\.env(\..+)?$/i.test(base) && !SECRET_FILE_OK.test(base)) return 'env file'
  if (/\.(pem|key|p12|pfx|jks|keystore)$/i.test(base)) return 'key file'
  if (/^id_(rsa|dsa|ecdsa|ed25519)$/i.test(base)) return 'ssh private key'
  if (/^\.(netrc|pgpass)$/i.test(base)) return 'credential file'
  return null
}

// Lines that look like live credentials. Each is a shape published by its issuer (AWS key id,
// GitHub token prefixes, Slack, the sk- family, PEM private-key armour), plus one generic rule:
// a key-ish name assigned a QUOTED literal of 20+ chars carrying both letters and digits.
const SHAPES = [
  ['private key block', /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/],
  ['aws access key id', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ['github token', /\bgh[pousr]_[A-Za-z0-9]{36,}\b/],
  ['github token', /\bgithub_pat_[A-Za-z0-9_]{40,}\b/],
  ['slack token', /\bxox[abposr]-[A-Za-z0-9-]{10,}/],
  // the sk- family: a vendor prefix (sk-ant-, sk-proj-, sk-svcacct-, sk-admin-), or a legacy
  // hyphen-free body of 32+ letters AND digits. A hyphenated slug (sk-hynix-four-leg-...) is not a key.
  ['sk- api key', /\bsk-(?:ant|proj|svcacct|admin)-[A-Za-z0-9_-]{24,}/],
  ['sk- api key', /\bsk-(?:live_|test_)?(?=[A-Za-z0-9]*[0-9])(?=[A-Za-z0-9]*[A-Za-z])[A-Za-z0-9]{32,}(?![A-Za-z0-9_-])/],
  ['google api key', /\bAIza[0-9A-Za-z_-]{35}\b/],
]
const GENERIC = /(?:api[_-]?key|api[_-]?secret|secret[_-]?key|access[_-]?key|auth[_-]?token|private[_-]?key|passw(?:or)?d|secret|token)["']?\s*[:=]\s*["'`]([A-Za-z0-9_\-/+=.]{20,})["'`]/i
const PLACEHOLDER = /^(x+|\*+|0+)$|your|example|placeholder|changeme|dummy|redacted|<|\$\{/i

/** why a line looks like a credential, or null */
export function secretLineReason(line) {
  for (const [why, re] of SHAPES) if (re.test(line)) return why
  const m = GENERIC.exec(line)
  if (m) {
    const v = m[1]
    if (/[A-Za-z]/.test(v) && /[0-9]/.test(v) && !PLACEHOLDER.test(v)) return 'key-like assignment'
  }
  return null
}

/**
 * `git diff --cached -U0 --no-color` -> the ADDED lines per file (b/ side). Only what this commit
 * adds is judged, so a line that was already in history does not block every later commit.
 */
export function addedLines(diff) {
  const out = new Map()
  let file = null
  let lineNo = 0
  for (const raw of diff.split('\n')) {
    const line = raw.replace(/\r$/, '')
    if (line.startsWith('diff --git ')) { file = null; continue }
    if (line.startsWith('+++ ')) {
      const t = line.slice(4)
      file = t === '/dev/null' ? null : norm(t.replace(/^b\//, '').replace(/^"b\//, '').replace(/"$/, ''))
      if (file && !out.has(file)) out.set(file, [])
      continue
    }
    if (line.startsWith('--- ')) continue
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
    if (h) { lineNo = Number(h[1]); continue }
    if (!file) continue
    if (line.startsWith('+')) { out.get(file).push({ n: lineNo, text: line.slice(1) }); lineNo++ }
  }
  return out
}

/**
 * every secret finding in a staged set: file names first, then added lines. `paths` must be the
 * files the commit ADDS OR CHANGES (--diff-filter=ACMR): a deletion is never refused.
 */
export function secretFindings(paths, added) {
  const out = []
  for (const p of paths) {
    const why = secretFileReason(p)
    if (why) out.push({ path: p, line: null, why })
  }
  for (const [p, lines] of added) {
    for (const l of lines) {
      const why = secretLineReason(l.text)
      if (why) { out.push({ path: p, line: l.n, why }); break }
    }
  }
  return out
}

/**
 * THE CONTROL-CHARACTER CHECK (the owner, 2026-09-28): an ADDED line holding a C0 control
 * character other than tab and form feed, or DEL. An escape typed through two interpreters (a tool
 * call, then bash, then a python or sed one-liner) lands as the raw byte: `\b` in a regex became a
 * literal backspace (0x08) in FigViewer.tsx and typecheck stayed green, because a regex holding a
 * backspace still compiles. Book: app/library/platform/engineering.md#escapes-cross-every-interpreter.
 * A snapshot (any `snapshots/` folder) is provenance copied byte for byte and is never judged.
 */
const CONTROL = /[\x00-\x08\x0b\x0e-\x1f\x7f]/
const CONTROL_NAMES = { 0x00: 'NUL', 0x08: 'backspace', 0x0b: 'vertical tab', 0x1b: 'escape', 0x7f: 'DEL' }

/** why a line is refused: the first control character, named, with its column; null = clean */
export function controlLineReason(text) {
  const m = CONTROL.exec(text)
  if (!m) return null
  const c = m[0].charCodeAt(0)
  const hex = c.toString(16).toUpperCase().padStart(4, '0')
  return `control character U+${hex}${CONTROL_NAMES[c] ? ` (${CONTROL_NAMES[c]})` : ''} at column ${m.index + 1}`
}

export const isSnapshot = path => /(^|\/)snapshots\//.test(norm(path))

/** the first control-character line of every file the commit adds to (one finding per file) */
export function controlFindings(added) {
  const out = []
  for (const [p, lines] of added) {
    if (isSnapshot(p)) continue
    for (const l of lines) {
      const why = controlLineReason(l.text)
      if (why) { out.push({ path: p, line: l.n, why }); break }
    }
  }
  return out
}

/**
 * THE WRITE-BACK GATE, as a warning (B-0347): a learning is a `## ` chapter, and a chapter says when
 * to read it on its own `Read when:` line, so the check reads the chapter, not a _series.md row.
 * `pairs` = [{ path, before, after }] (before null = a new file) over the library books a commit
 * changes. In a book written as chapters (some chapter carries a Read when line), every chapter the
 * commit ADDS must carry one; a plain book (no chapter has one) asks nothing. Returns
 * [{ book, heading }] for the chapters added without.
 */
export function chaptersWithoutReadWhen(pairs) {
  const out = []
  for (const { path, before, after } of pairs) {
    const p = norm(path)
    if (after == null || !isLibraryBook(p) || p.split('/').pop() === '_series.md') continue
    const now = chaptersOf(after)
    if (!now.some(c => c.readWhen)) continue
    const had = new Set(before == null ? [] : chaptersOf(before).map(c => c.slug))
    for (const c of now) if (!c.readWhen && !had.has(c.slug)) out.push({ book: p, heading: c.title })
  }
  return out
}

/**
 * The pre-commit verdict. `agent` is null when FUND_AGENT is unset (the owner by hand): only
 * the secret check blocks then. For an agent: scope, the old api/execution shim, secrets, book topics and control
 * characters all block; the owner's book-topic and control-character findings are warnings. `unstage` = some error is cured by unstaging (scope,
 * shim, secrets), not by an edit to a book's frontmatter.
 */
export function verdict({ agentId, agent, fundPaths, secrets, outsideFund, topics = [], controls = [], chapters = [] }) {
  const errors = []
  if (secrets.length) {
    errors.push('secret material staged:')
    for (const s of secrets) errors.push(`  ${s.path}${s.line ? `:${s.line}` : ''}  (${s.why})`)
  }
  if (agentId) {
    if (outsideFund) errors.push(`this repo is outside the fund root; agent ${agentId} may not commit here`)
    else if (!agent) errors.push(`agent ${agentId} is not in the roster (app/agents/); nothing is in its scope`)
    else {
      const exec = fundPaths.filter(isLegacyExecution)
      if (exec.length) {
        errors.push('execution is guarded; only the owner commits there:')
        for (const p of exec) errors.push(`  ${p}`)
      }
      const writes = Array.isArray(agent.writes) ? agent.writes : []
      const out = outOfScope(writes, fundPaths.filter(p => !isLegacyExecution(p) && !isBoardItem(p)))
      if (out.length) {
        errors.push(`outside ${agentId}'s writes (${writes.join(', ') || 'none'}):`)
        for (const p of out) errors.push(`  ${p}`)
      }
    }
  }
  const unstage = errors.length > 0
  const warnings = chapters.map(c => `chapter "${c.heading}" of ${c.book} has no Read when: line (the moment the next hand reads it; warning only, not a block)`)
  if (topics.length && agentId) {
    errors.push("book frontmatter off its shelf's rules (topics from its top _series.md; type: guide or strategy):")
    for (const t of topics) errors.push(`  ${topicLine(t)}`)
  } else for (const t of topics) warnings.push(`${topicLine(t)} (the owner: a warning, not a block)`)
  if (controls.length && agentId) {
    errors.push('control characters in added lines (an escape eaten on the way in? write the file with an editor, not a one-liner):')
    for (const c of controls) errors.push(`  ${c.path}:${c.line}  (${c.why})`)
  } else for (const c of controls) warnings.push(`${c.path}:${c.line} ${c.why} (the owner: a warning, not a block)`)
  return { ok: errors.length === 0, errors, warnings, unstage }
}

// ---- book topics: a shelf names a closed list in its top _series.md, every book on it 1 to 3 ----

const NOT_A_BOOK = new Set(['readme.md', 'agents.md', 'claude.md', '_series.md'])
/**
 * The shelf a fund-relative book sits on and that shelf's top index: app/library/<shelf>/** ->
 * app/library/<shelf>/_series.md. null = not a book of a shelf (a _series.md, README, CLAUDE.md, a
 * loose file at app/library's top).
 */
export function shelfOfBook(path) {
  const p = norm(path)
  if (!/\.md$/i.test(p) || NOT_A_BOOK.has((p.split('/').pop() ?? '').toLowerCase())) return null
  const m = /^app\/library\/([^/]+)\/.+$/.exec(p)
  if (m) return { shelf: m[1], index: `app/library/${m[1]}/_series.md` }
  return null
}

/** a shelf's top index (app/library/<shelf>/_series.md) -> the shelf id, else null */
export function shelfOfIndex(path) {
  const p = norm(path)
  return /^app\/library\/([^/]+)\/_series\.md$/.exec(p)?.[1] ?? null
}

const topicLine = t => `${t.path}: ${t.why}`

/**
 * THE TOPICS CHECK over what a commit lands. `staged` = [{ path, text }]: fund-relative, the staged
 * text of every file added or changed (anything else is skipped). A shelf's top index must name a
 * sound list (vocabFaults); a book on a shelf whose list is non-empty must carry 1 to 3 of it
 * (topicFault); a `type:` line, when present, must be one of guide | strategy (typeFault).
 * `indexText(indexPath)` = the index as this commit leaves it (staged, else HEAD), null
 * = none; a shelf whose index names no list asks nothing. Returns [{ path, why }].
 */
export function topicFindings(staged, indexText) {
  const out = []
  for (const { path, text } of staged) {
    const p = norm(path)
    const shelf = shelfOfIndex(p)
    if (shelf) {
      const vocab = vocabOf(text ?? '')
      if (vocab) for (const f of vocabFaults(vocab, shelf)) out.push({ path: p, why: `topics list: ${f}; fix the topics: map in its frontmatter` })
      continue
    }
    const home = shelfOfBook(p)
    if (!home) continue
    // `type:` is checked on every shelf book, whether or not its shelf names topics (B-0345)
    const tf = typeFault(text ?? '')
    if (tf) out.push({ path: p, why: `${tf}; set type: guide or strategy in its frontmatter (or drop the line)` })
    const idx = indexText(home.index)
    const vocab = idx == null ? null : vocabOf(idx)
    if (!vocab || !vocab.length) continue
    const fault = topicFault(topicsOf(text ?? ''), vocab)
    if (!fault) continue
    const bad = (fault.match(/^("[^"]*"(?:, )?)+/)?.[0].match(/"[^"]*"/g) ?? []).length
    const why = bad ? `topic${bad > 1 ? 's' : ''} ${fault}` : fault
    out.push({ path: p, why: `${why}; set topics: [...] in its frontmatter` })
  }
  return out
}

/** the trailers commit-msg appends: only the ones missing, only for env vars that are set */
export function missingTrailers(message, env) {
  const want = []
  if (env.FUND_AGENT) want.push(['Agent', env.FUND_AGENT])
  if (env.FUND_CONVERSATION) want.push(['Conversation', env.FUND_CONVERSATION])
  const has = k => new RegExp(`^${k}:\\s*\\S`, 'im').test(message)
  return want.filter(([k]) => !has(k))
}

// ---- the book shrink warning: a commit that guts a library book or a _series.md ----

/** a library book or series index: any .md under a library/ folder (fund or a repo's own shelf) */
export function isLibraryBook(path) {
  const p = norm(path)
  return /(^|\/)library\/.+\.md$/i.test(p)
}

/** more than this fraction of a book's lines, or of its ## sections, gone = flagged; so is ANY `##` heading
 *  lost outright (a chapter is a learning: renamed and reworded ones are not lost) */
export const SHRINK_LIMIT = 0.3

const lines = t => {
  const s = String(t).replace(/\r\n/g, '\n').replace(/\n+$/, '')
  return s === '' ? 0 : s.split('\n').length
}

/** the `## ` headings of a markdown text, in order (fenced code blocks skipped) */
export function headings(text) {
  const out = []
  let fence = false
  for (const raw of String(text).replace(/\r\n/g, '\n').split('\n')) {
    if (/^\s*(```|~~~)/.test(raw)) { fence = !fence; continue }
    if (fence) continue
    const m = /^##\s+(.+?)\s*#*\s*$/.exec(raw)
    if (m && !raw.startsWith('###')) out.push(m[1])
  }
  return out
}

/** the `## ` sections of a markdown text: [{ heading, body: non-blank body lines, trimmed }] */
export function sections(text) {
  const out = []
  let fence = false, cur = null
  for (const raw of String(text).replace(/\r\n/g, '\n').split('\n')) {
    if (/^\s*(```|~~~)/.test(raw)) fence = !fence
    const m = !fence && !raw.startsWith('###') ? /^##\s+(.+?)\s*#*\s*$/.exec(raw) : null
    if (m) { cur = { heading: m[1], body: [] }; out.push(cur); continue }
    if (cur && raw.trim()) cur.body.push(raw.trim())
  }
  return out
}

const STOP = new Set(['a', 'an', 'and', 'the', 'of', 'to', 'in', 'on', 'for', 'at', 'by', 'is', 'with', 'or'])
const words = h => {
  const all = String(h).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean)
  const content = all.filter(w => !STOP.has(w))
  return new Set(content.length ? content : all)
}

/**
 * Word overlap of two headings, 0..1: Jaccard over lower-cased alphanumeric words (stop words
 * dropped), and 1 when one heading's words all survive inside the other ("Fees" -> "Fees and rebates").
 */
export function headingSimilarity(a, b) {
  const x = words(a), y = words(b)
  if (!x.size && !y.size) return 1
  if (!x.size || !y.size) return 0
  let n = 0
  for (const w of x) if (y.has(w)) n++
  if (n === Math.min(x.size, y.size)) return 1
  return n / (x.size + y.size - n)
}

/** share of `a`'s body lines still present in `b` (multiset), 0..1; an empty `a` is 0 */
function bodyKept(a, b) {
  if (!a.length) return 0
  const pool = new Map()
  for (const l of b) pool.set(l, (pool.get(l) ?? 0) + 1)
  let n = 0
  for (const l of a) { const k = pool.get(l); if (k) { n++; pool.set(l, k - 1) } }
  return n / a.length
}

/** a heading renamed rather than lost: its words mostly survive, or its body moved under the new one */
export const RENAME_WORDS = 0.5
export const RENAME_BODY = 0.5

/**
 * How much one book lost. `before` null = a new file (never flagged); `after` null = deleted
 * (-100%). linesPct / sectionsPct are signed whole percents (negative = shrank); lostHeadings are
 * the `##` headings the before text had that the after text no longer carries; a heading REWORDED
 * (its words mostly kept, or its body moved under the new heading) is in renamedHeadings instead.
 */
export function bookShrink(beforeText, afterText) {
  if (beforeText == null) return { linesPct: 0, sectionsPct: 0, lostHeadings: [], renamedHeadings: [], deleted: false, added: true, flagged: false }
  const hb = headings(beforeText)
  if (afterText == null) return { linesPct: -100, sectionsPct: hb.length ? -100 : 0, lostHeadings: hb, renamedHeadings: [], deleted: true, added: false, flagged: true }
  const lb = lines(beforeText), la = lines(afterText)
  const sb = sections(beforeText), sa = sections(afterText)
  const left = sa.slice()
  const missing = []
  for (const s of sb) {
    const i = left.findIndex(x => x.heading === s.heading)
    if (i >= 0) left.splice(i, 1)
    else missing.push(s)
  }
  // a reworded heading is a rename, not a loss: pair each missing section with the unmatched new
  // one that best keeps its words or its body (greedy, best score first; each new heading used once)
  const cands = []
  for (const [mi, m] of missing.entries()) {
    for (const [li, l] of left.entries()) {
      const w = headingSimilarity(m.heading, l.heading), b = bodyKept(m.body, l.body)
      if (w >= RENAME_WORDS || b >= RENAME_BODY) cands.push({ mi, li, score: Math.max(w, b) })
    }
  }
  cands.sort((a, b) => b.score - a.score || a.mi - b.mi || a.li - b.li)
  const usedM = new Set(), usedL = new Set(), renamed = []
  for (const c of cands) {
    if (usedM.has(c.mi) || usedL.has(c.li)) continue
    usedM.add(c.mi); usedL.add(c.li)
    renamed.push({ from: missing[c.mi].heading, to: left[c.li].heading })
  }
  const lostHeadings = missing.filter((_, i) => !usedM.has(i)).map(s => s.heading)
  const lineLoss = lb ? (lb - la) / lb : 0
  const secLoss = hb.length ? lostHeadings.length / hb.length : 0
  return {
    linesPct: lb ? Math.round((la - lb) / lb * 100) : 0,
    sectionsPct: secLoss ? -Math.round(secLoss * 100) : 0,
    lostHeadings,
    renamedHeadings: renamed,
    deleted: false,
    added: false,
    flagged: lineLoss > SHRINK_LIMIT || secLoss > SHRINK_LIMIT || lostHeadings.length > 0,
  }
}

/** the reason in a `Consolidation: <reason>` trailer line, or null */
export function consolidationReason(message) {
  const m = /^Consolidation:[ \t]*(\S.*)$/im.exec(String(message ?? ''))
  return m ? m[1].trim() : null
}

/**
 * One commit's shrink verdict over its changed books: `pairs` = [{ path, before, after }] (before
 * null = added, after null = deleted). Returns every FLAGGED file, the worst signed percent, and
 * ok = the message carries a Consolidation trailer (the shrink is declared, not an accident).
 */
export function shrinkReport(pairs, message) {
  const files = []
  for (const p of pairs) {
    const s = bookShrink(p.before, p.after)
    if (s.flagged) files.push({ path: norm(p.path), linesPct: s.linesPct, sectionsPct: s.sectionsPct, lostHeadings: s.lostHeadings, renamedHeadings: s.renamedHeadings, deleted: s.deleted })
  }
  const reason = consolidationReason(message)
  const worst = files.length ? Math.min(...files.map(f => Math.min(f.linesPct, f.sectionsPct))) : null
  return { files, worst, ok: !!reason, reason }
}

/** the stderr lines for an unlabelled shrink; [] when nothing was flagged or it was declared */
export function shrinkWarnings(report) {
  if (!report.files.length || report.ok) return []
  const out = []
  for (const f of report.files) {
    const what = f.deleted ? 'deleted' : `${f.linesPct}% lines, ${f.sectionsPct}% sections`
    out.push(`book ${f.path} shrank (${what})${f.lostHeadings.length ? `; lost: ${f.lostHeadings.map(h => `## ${h}`).join(', ')}` : ''}`)
  }
  out.push('add a "Consolidation: <reason>" trailer if this is deliberate (warning only, not a block)')
  return out
}

/**
 * `git diff --name-status -z -M` (or diff-tree) -> [{ status, from, to }]: R/C carry two paths,
 * A/M/D/T one (from == to). Only the letter of the status is kept.
 */
export function parseNameStatusZ(out) {
  const parts = String(out).split('\0')
  const rows = []
  let i = 0
  while (i < parts.length) {
    const st = parts[i]
    if (!st) { i++; continue }
    const letter = st[0]
    if (letter === 'R' || letter === 'C') { rows.push({ status: letter, from: norm(parts[i + 1] ?? ''), to: norm(parts[i + 2] ?? '') }); i += 3 }
    else { rows.push({ status: letter, from: norm(parts[i + 1] ?? ''), to: norm(parts[i + 1] ?? '') }); i += 2 }
  }
  return rows
}
