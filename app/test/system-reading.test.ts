import { describe, expect, it } from 'vitest'
import { shortReading } from '../src/rooms/system/reading.ts'

const NOW = Date.parse('2026-09-24T12:00:00Z')
const t = (r: string) => shortReading(r, NOW)

describe('health readings, short', () => {
  it('turns the probes\' sentences into a figure and a tone', () => {
    expect(t('missed 2026-09-21 07:05Z, no run within its 1d grace')).toEqual({ text: 'missed · 3d', tone: 'warn' })
    expect(t('fail (exit 1):   probe-sweep: last reported 34.4h ago, window is 26.0h - something stopped writing')).toEqual({ text: '34h / 26h', tone: 'fail' })
    expect(t('12,697,201 billable tokens today across 4 seat(s)').text).toBe('12.7M · 4')
    expect(t('22/22 checks pass across 4 suite(s) · 2 suite(s) need real rows (--full)').text).toBe('22/22 · 2 skip')
    expect(t('0 diagnostic(s) over api app')).toEqual({ text: 'clean', tone: 'ok' })
    expect(t('3 diagnostic(s) over api app')).toEqual({ text: '3 warn', tone: 'fail' })
    expect(t('not running on :8787').text).toBe('down :8787')
    expect(t('111 candle series / 370,540 bars · 4450 funding series · 36 series at or past the 5,000-bar venue cap · gaps 16').text).toBe('111 · 4450 · 36 capped')
    expect(t('the median acme series is 42.7h stale (> 30h): the sweep has not run')).toEqual({ text: '43h / 30h', tone: 'fail' })
    expect(t('66/66 ok').text).toBe('66/66')
    const sw = t('5/8 ok · 3 FAIL (selftest, verify, git)')
    expect([sw.text, sw.tone, sw.value, sw.chips?.map(c => `${c.word} ${c.n}`)]).toEqual(['5/8 · 3 fail', 'fail', '5/8', ['fail 3']])
    const sch = t('1 fail · 8 missed · 1 unknown of 13 (jobs, newest run)')
    expect(sch.text).toBe('1 · 8 · 1 / 13')
    expect(sch.chips?.map(c => c.tone)).toEqual(['fail', 'warn', 'faint'])
    expect(sch.chips?.map(c => c.word)).toEqual(['fail', 'missed', 'unknown'])
    expect(sch.unit).toBe('jobs')
    expect(t('app 21 dirty, 2 ahead · fund clean · research 1 dirty').text).toBe('app 21 ↑2 · research 1')
    expect(t('fund 7 ahead · app clean · platform clean · research clean').text).toBe('fund ↑7')
    expect(t('fund clean · app clean').text).toBe('clean')
    expect(t('fund 1 dirty · app 6 dirty · platform 7 dirty · research 3 dirty').text).toBe('fund 1 · app 6 · platform 7 · research 3')
    expect(t('ok (exit 0): backup cockpit-2026-09-24.db: 1.0 MB via backup, check ok, 30 ms').text).toBe('1.0 MB')
  })
  it('draws a count list as chips beside its figure, never a truncated sentence', () => {
    const c = (r: string) => { const x = t(r); return [x.value ?? null, (x.chips ?? []).map(k => `${k.word} ${k.n}:${k.tone}`), x.tone ?? null] }
    expect(c('fail (exit 1): 16/24 fresh and ok · 8 need attention · verdict: 0 silent, 3 red, 3 amber')).toEqual(['16/24', ['red 3:fail', 'amber 3:warn'], 'fail'])
    expect(c('unknown (exit 1): RETRO DUE at 15 desk(s): lab/feeds/acme (never, 5 run(s) since)')).toEqual([null, ['due 15:warn'], 'warn'])
    expect(c('306/307 ok, 1 FAILED')).toEqual(['306/307', ['fail 1:fail'], 'fail'])
    expect(c('unknown: server 27, unknown 2 - acme/api-docs unknown (shell_page)')).toEqual([null, ['server 27:faint', 'unknown 2:faint'], null])
    expect(c('5/9 ok · 3 FAIL (offline, git, venues) · 1 unknown (app)')).toEqual(['5/9', ['fail 3:fail', 'unknown 1:faint'], 'fail'])
    // all zero: the figure alone, no chip
    expect(t('24/24 fresh and ok · 0 need attention · verdict: 0 silent, 0 red, 0 amber')).toEqual({ text: '24/24' })
  })
  it('cuts a long sentence no rule knows to its first clause', () => {
    expect(t('a reading nobody has a rule for yet: with more words after it').text).toBe('a reading nobody has a rule…')
    expect(t('short head: then a long tail that would never fit in the cell').text).toBe('short head')
  })
  it('keeps an unknown sentence, minus its parentheticals', () => {
    expect(t('something new (with a note)').text).toBe('something new')
    expect(t('').text).toBe('-')
  })
})
