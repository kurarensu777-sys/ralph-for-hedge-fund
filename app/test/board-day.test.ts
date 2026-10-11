import { describe, expect, it } from 'vitest'
import { NO_LIVE_HAND_MIN, NO_LIVE_MIN, noLiveConversation, pickupReading, type ChatLook, type PickupStatus } from '../src/rooms/board/state.ts'

const base: PickupStatus = { on: true, stopped: false, last: null }

// The Board head's "N/cap today": a count only when fundd answered with both numbers; an older fundd
// answers neither, and that must read unknown, never "0/10 today".
describe('the Board head day count', () => {
  it('no answer, or an answer without the day fields = unknown, never zero', () => {
    expect(pickupReading(null)).toEqual({ state: 'unknown' })
    expect(pickupReading(base)).toEqual({ state: 'unknown' })
    expect(pickupReading({ ...base, perDay: 10 })).toEqual({ state: 'unknown' })
    expect(pickupReading({ ...base, today: 0 })).toEqual({ state: 'unknown' })
  })

  it('a measured zero is a zero, and the cap marks full at the limit', () => {
    expect(pickupReading({ ...base, today: 0, perDay: 10 })).toEqual({ state: 'known', today: 0, perDay: 10, full: false, held: null })
    expect(pickupReading({ ...base, today: 9, perDay: 10 })).toMatchObject({ full: false })
    expect(pickupReading({ ...base, today: 10, perDay: 10 })).toMatchObject({ full: true })
  })

  it('the held reason is the tick\'s own; a switch or STOP outranks it; no tick yet = no reason', () => {
    const k = { ...base, today: 4, perDay: 10 }
    expect(pickupReading({ ...k, last: { at: 'x', error: null, result: { held: '4 running' } } })).toMatchObject({ held: '4 running' })
    expect(pickupReading({ ...k, last: { at: 'x', error: null, result: { held: null } } })).toMatchObject({ held: null })
    expect(pickupReading({ ...k, last: { at: 'x', error: 'boom', result: null } })).toMatchObject({ held: null })
    expect(pickupReading({ ...k, manual: true, last: { at: 'x', error: null, result: { held: '4 running' } } })).toMatchObject({ held: expect.stringMatching(/manual/) })
    expect(pickupReading({ ...k, stopped: true })).toMatchObject({ held: expect.stringMatching(/STOP/) })
    expect(pickupReading({ ...k, on: false })).toMatchObject({ held: expect.stringMatching(/off/) })
  })
})

// A doing item whose conversation is gone reads amber after NO_LIVE_MIN; it never reads working, and an
// unanswered chat list draws nothing (null), because "I could not look" is not "nobody is working".
describe('a doing item with no live conversation', () => {
  const NOW = Date.parse('2026-10-04T12:00:00Z')
  const ago = (min: number) => new Date(NOW - min * 60_000).toISOString()
  const item = (over: Record<string, unknown> = {}) => ({ status: 'doing' as const, owner: 'app', updated: ago(NO_LIVE_MIN + 1), conversation: 'c1', ...over })
  const chat = (state: ChatLook['state'], over: Partial<ChatLook> = {}): ChatLook => ({ id: 'c1', agent: 'app', state, ...over })

  it('its named conversation closed or idle for over N minutes = flagged; live or waiting = fine', () => {
    expect(noLiveConversation(item(), [chat('closed')], NOW)).toBe(true)
    expect(noLiveConversation(item(), [chat('idle')], NOW)).toBe(true)
    expect(noLiveConversation(item(), [], NOW)).toBe(true)          // the conversation is gone from the list
    expect(noLiveConversation(item(), [chat('live')], NOW)).toBe(false)
    expect(noLiveConversation(item(), [chat('waiting')], NOW)).toBe(false)
  })

  it('another live conversation of the same agent does not rescue an item that names a dead one', () => {
    expect(noLiveConversation(item(), [chat('closed'), chat('live', { id: 'c2' })], NOW)).toBe(true)
  })

  it('an item with no conversation is judged by whether its owner has any working or waiting', () => {
    const none = item({ conversation: undefined })
    expect(noLiveConversation(none, [], NOW)).toBe(true)
    expect(noLiveConversation(none, [chat('live', { agent: 'platform' })], NOW)).toBe(true)
    expect(noLiveConversation(none, [chat('closed')], NOW)).toBe(true)
    expect(noLiveConversation(none, [chat('live', { id: 'c9' })], NOW)).toBe(false)
  })

  it('a hand-started item untouched for NO_LIVE_HAND_MIN is flagged even while its owner is busy elsewhere', () => {
    const busy = [chat('live', { id: 'c9' })]
    expect(noLiveConversation(item({ conversation: undefined, updated: ago(NO_LIVE_HAND_MIN - 1) }), busy, NOW)).toBe(false)
    expect(noLiveConversation(item({ conversation: undefined, updated: ago(NO_LIVE_HAND_MIN) }), busy, NOW)).toBe(true)
  })

  it('a young item is not flagged; the flag starts after N minutes', () => {
    expect(noLiveConversation(item({ updated: ago(NO_LIVE_MIN - 1) }), [chat('closed')], NOW)).toBe(false)
    expect(noLiveConversation(item({ updated: ago(NO_LIVE_MIN + 1) }), [chat('closed')], NOW)).toBe(true)
  })

  it('only a doing item an agent owns can be flagged', () => {
    for (const status of ['ready', 'review', 'needs-you', 'backlog', 'done'] as const) expect(noLiveConversation(item({ status }), [chat('closed')], NOW)).toBe(false)
    expect(noLiveConversation(item({ owner: 'you' }), [chat('closed')], NOW)).toBe(false)
    expect(noLiveConversation(item({ owner: '' }), [chat('closed')], NOW)).toBe(false)
  })

  it('a chat list that has not answered is unknown, never a flag; an unreadable date is unknown too', () => {
    expect(noLiveConversation(item(), null, NOW)).toBeNull()
    expect(noLiveConversation(item({ updated: 'not a date' }), [chat('closed')], NOW)).toBeNull()
  })
})
