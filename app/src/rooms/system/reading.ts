// ROOM: system - a probe's reading as a number and a tag. The probes write sentences (they are
// read by people and by the retro); the Health table shows the figure and keeps the sentence in the
// tooltip. A reading no rule knows stays as written, parentheticals dropped.

export type Tone = 'ok' | 'warn' | 'fail' | 'faint'
/** chips: counts drawn as coloured chips (the word each stands for rides in its tooltip); `of` their total */
/** value: the figure drawn beside the chips (dim), when a reading has both ("16/24" beside "red 3") */
export type Short = { text: string; tone?: Tone; chips?: { n: string; tone: Tone; word: string }[]; of?: string; unit?: string; value?: string }
const CHIP_TONE: Record<string, Tone> = { fail: 'fail', failed: 'fail', red: 'fail', missed: 'warn', stale: 'warn', late: 'warn', amber: 'warn', due: 'warn', unknown: 'faint', skipped: 'faint', silent: 'faint' }
type Chip = { n: string; tone: Tone; word: string }
const chip = (n: string | number, word: string): Chip => ({ n: String(n), word, tone: CHIP_TONE[word] ?? 'faint' })
/** chips with a count, the zero ones dropped; the tone of the worst */
function chipped(value: string | undefined, cs: Chip[]): Short {
  const chips = cs.filter(c => c.n !== '0')
  const tone: Tone | undefined = chips.some(c => c.tone === 'fail') ? 'fail' : chips.some(c => c.tone === 'warn') ? 'warn' : undefined
  if (!chips.length) return { text: value ?? '-', ...(tone ? { tone } : {}) }
  return { text: [value, ...chips.map(c => `${c.n} ${c.word}`)].filter(Boolean).join(' · '), ...(tone ? { tone } : {}), chips, ...(value ? { value } : {}) }
}
/** a sentence cut to its first clause, at most MAX characters */
const MAX = 28
function clause(r: string): string {
  let t = r.replace(/\s*\([^)]*\)/g, '').trim()
  if (t.length <= MAX) return t
  const cut = t.search(/:\s|;\s|\s-\s|\s·\s|,\s/)
  if (cut >= 3) t = t.slice(0, cut)
  return t.length <= MAX ? t : `${t.slice(0, MAX - 1).trimEnd()}…`
}

/** 12697201 -> 12.7M, 4450 -> 4.5k, 36 -> 36 */
export const compact = (n: number) => n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e4 ? `${Math.round(n / 1e3)}k` : String(n)
const int = (s: string) => Number(s.replace(/,/g, ''))

/** age from a stamp like "2026-09-21 07:05Z" to now, as "3d" / "5h" */
function since(stampText: string, now: number): string | null {
  const t = Date.parse(stampText.trim().replace(' ', 'T').replace(/Z?$/, 'Z'))
  if (!Number.isFinite(t)) return null
  const s = Math.max(0, (now - t) / 1000)
  return s < 3600 ? `${Math.round(s / 60)}m` : s < 172800 ? `${Math.round(s / 3600)}h` : `${Math.round(s / 86400)}d`
}

export function shortReading(reading: string, now = Date.now()): Short {
  const r = (reading ?? '').trim()
  if (!r) return { text: '-', tone: 'faint' }
  let m: RegExpExecArray | null
  if ((m = /^missed (\d{4}-\d\d-\d\d[ T]\d\d:\d\dZ?)/.exec(r))) return { text: `missed · ${since(m[1], now) ?? '?'}`, tone: 'warn' }
  if ((m = /last reported ([\d.]+)h ago, window is ([\d.]+)h/.exec(r))) return { text: `${Math.round(Number(m[1]))}h / ${Math.round(Number(m[2]))}h`, tone: 'fail' }
  if ((m = /^the median (\S+) series is ([\d.]+)h stale \(> ([\d.]+)h\)/.exec(r))) return { text: `${Math.round(Number(m[2]))}h / ${Math.round(Number(m[3]))}h`, tone: 'fail' }
  if ((m = /^(?:fail \(exit -?\d+\):\s*)?(\d+)\/(\d+) fresh and ok(?:.*?verdict: (\d+) silent, (\d+) red, (\d+) amber)?/.exec(r))) return chipped(`${m[1]}/${m[2]}`, m[3] === undefined ? [] : [chip(m[4], 'red'), chip(m[5], 'amber'), chip(m[3], 'silent')])
  if ((m = /RETRO DUE at (\d+) desk/.exec(r))) return chipped(undefined, [chip(m[1], 'due')])
  if ((m = /^(\d+)\/(\d+) ok, (\d+) FAILED/.exec(r))) return chipped(`${m[1]}/${m[2]}`, [chip(m[3], 'fail')])
  if ((m = /^fail \(exit (-?\d+)\)/.exec(r))) return { text: `exit ${m[1]}`, tone: 'fail' }
  // "unknown: server 27, unknown 2 - ...": the verdict word off, the "word N" list as chips
  if ((m = /^(?:ok|warn|fail|unknown)(?: \(exit -?\d+\))?:\s*([a-z]+ \d+(?:, [a-z]+ \d+)+)/i.exec(r))) return chipped(undefined, m[1].split(', ').map(p => { const [w, n] = p.split(' '); return chip(n, w.toLowerCase()) }))
  if ((m = /^ok \(exit 0\):.*?([\d.]+ [KMG]B)/.exec(r))) return { text: m[1] }
  if (/^ok \(exit 0\)/.test(r)) return { text: 'ok' }
  if ((m = /^([\d,]+) billable tokens today across (\d+) seat/.exec(r))) return { text: `${compact(int(m[1]))} · ${m[2]}` }
  if ((m = /^(\d+)\/(\d+) checks pass(?:.*?·\s*(\d+) suite\(s\) need)?/.exec(r))) return { text: `${m[1]}/${m[2]}${m[3] ? ` · ${m[3]} skip` : ''}`, tone: m[1] === m[2] ? undefined : 'fail' }
  if ((m = /^(\d+) diagnostic/.exec(r))) return m[1] === '0' ? { text: 'clean', tone: 'ok' } : { text: `${m[1]} warn`, tone: 'fail' }
  if ((m = /^not running on (:\d+)/.exec(r))) return { text: `down ${m[1]}`, tone: 'faint' }
  if ((m = /^(\d+) candle series .*?· (\d+) funding series · (\d+) series at or past/.exec(r))) return { text: `${m[1]} · ${m[2]} · ${m[3]} capped` }
  if ((m = /^(\d+)\/(\d+) ok$/.exec(r))) return { text: `${m[1]}/${m[2]}`, tone: m[1] === m[2] ? undefined : 'fail' }
  if ((m = /^(\d+)\/(\d+) ok · (\d+) FAIL/i.exec(r))) return chipped(`${m[1]}/${m[2]}`, [chip(m[3], 'fail'), chip(/·\s*(\d+) unknown/.exec(r)?.[1] ?? '0', 'unknown')])
  if ((m = /^((?:\d+ \w+(?: · )?)+) of (\d+)(?: \((\w+))?/.exec(r))) {
    const chips = m[1].replace(/ · $/, '').split(' · ').map(p => { const [n, word] = p.split(' '); return { n, word, tone: CHIP_TONE[word] ?? 'faint' } })
    return { text: `${chips.map(c => c.n).join(' · ')} / ${m[2]}`, tone: chips.some(c => c.tone === 'fail') ? 'fail' : 'warn', chips, of: m[2], unit: m[3] }
  }
  // "fund 7 ahead · app clean · ..." -> only the repos that are not clean
  if (/^\w+ [^·]+( · \w+ [^·]+)+$/.test(r) && /\b(clean|dirty|ahead|behind)\b/.test(r)) {
    // the Git room's own marks: the dirty count bare, ahead as up-arrow, behind as down-arrow
    const off = r.split(' · ').filter(p => !/ clean$/.test(p)).map(p => p.replace(/ (\d+) dirty,?/, ' $1').replace(/,? (\d+) ahead/, ' ↑$1').replace(/,? (\d+) behind/, ' ↓$1').replace(/\s+/g, ' ').trim())
    return { text: off.length ? off.join(' · ') : 'clean' }
  }
  return { text: clause(r) }
}
