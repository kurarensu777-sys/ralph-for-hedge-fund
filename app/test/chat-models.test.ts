import { afterEach, describe, expect, it } from 'vitest'
import type { ModelInfo } from '@anthropic-ai/claude-agent-sdk'
import { checkEffort, checkModel, exactOf, fromInfo, readPermitted, setPermitted } from '../server/chat/models.ts'
import { EXACT_ID } from '../shared/models.ts'

// what Claude Code's supportedModels() returned on this machine, 2026-09-26 (the SDK 0.3.281)
const ALL = ['low', 'medium', 'high', 'xhigh', 'max'] as ModelInfo['supportedEffortLevels']
const LIVE: ModelInfo[] = [
  { value: 'default', resolvedModel: 'claude-opus-5-5[1m]', displayName: 'Default (recommended)', description: 'Opus 5.5 with 1M context · Best for everyday, complex tasks', supportsEffort: true, supportedEffortLevels: ALL },
  { value: 'opus[1m]', resolvedModel: 'claude-opus-5-5[1m]', displayName: 'Opus (1M context)', description: 'Opus 5.5 with 1M context · Best for everyday, complex tasks', supportsEffort: true, supportedEffortLevels: ALL },
  { value: 'claude-fable-5-1[1m]', resolvedModel: 'claude-fable-5-1', displayName: 'Fable', description: 'Fable 5.1 · Most capable for your hardest and longest-running tasks', supportsEffort: true, supportedEffortLevels: ALL },
  { value: 'sonnet', resolvedModel: 'claude-sonnet-5', displayName: 'Sonnet', description: 'Sonnet 5 · Efficient for routine tasks', supportsEffort: true, supportedEffortLevels: ALL },
  { value: 'haiku', resolvedModel: 'claude-haiku-4-5-20251001', displayName: 'Haiku', description: 'Haiku 4.5 · Fastest for quick answers' },
]

afterEach(() => setPermitted({ models: [], at: null, error: null }))

describe('the permitted models, as Claude Code lists them', () => {
  it('keys every row by its EXACT id, folds the aliases in, and keeps each model its own efforts', () => {
    const m = fromInfo(LIVE)
    expect(m.map(x => x.id)).toEqual(['claude-opus-5-5[1m]', 'claude-fable-5-1', 'claude-sonnet-5', 'claude-haiku-4-5-20251001'])
    for (const x of m) expect(EXACT_ID.test(x.id), x.id).toBe(true)
    expect(m[0].aliases).toEqual(['default', 'opus[1m]'])
    expect(m[0].name).toBe('Opus 5.5 with 1M context')
    expect(m[3].efforts).toEqual([])                       // Haiku 4.5 takes none
    expect(m[2].efforts).toEqual(ALL)
  })

  it('an alias resolves to its exact id; an exact id stays as written', async () => {
    await readPermitted(true, async () => LIVE)
    expect(exactOf('opus[1m]')).toBe('claude-opus-5-5[1m]')
    expect(exactOf('default')).toBe('claude-opus-5-5[1m]')
    expect(exactOf('claude-sonnet-5')).toBe('claude-sonnet-5')
  })

  it('refuses a model off the list, and ANY model while the list is unreadable (saying why)', async () => {
    await readPermitted(true, async () => { throw new Error('spawn claude ENOENT') })
    await expect(checkModel('claude-sonnet-5')).rejects.toThrow(/unreadable \(spawn claude ENOENT\)/)
    await readPermitted(true, async () => LIVE)
    await expect(checkModel('claude-opus-4-8')).rejects.toThrow(/not on Claude Code's permitted list/)
    await expect(checkModel('opus[1m]')).rejects.toThrow(/not on/)            // an alias is not an exact id
    expect((await checkModel('claude-fable-5-1')).id).toBe('claude-fable-5-1')
  })

  it('a failed re-read keeps the last good list and names the failure; an empty answer is a failure', async () => {
    await readPermitted(true, async () => LIVE)
    const r = await readPermitted(true, async () => { throw new Error('timed out') })
    expect(r.models.length).toBe(4)
    expect(r.error).toBe('timed out')
    expect((await readPermitted(true, async () => [])).error).toBe('Claude Code returned no models')
  })

  it('reads the 2.1.288 shape (SDK 0.3.288, 2026-10-03): the name in displayName, Sonnet 5.5 on the list', () => {
    const NEW: ModelInfo[] = [
      { value: 'default', resolvedModel: 'claude-haiku-4-5-20251001', displayName: 'Default (recommended)', description: 'Haiku 4.5' },
      { value: 'opus', resolvedModel: 'claude-opus-5-5', displayName: 'Opus 5.5', description: 'For complex work and everyday tasks', supportsEffort: true, supportedEffortLevels: ALL },
      { value: 'sonnet', resolvedModel: 'claude-sonnet-5-5', displayName: 'Sonnet 5.5', description: 'Most efficient for simpler tasks', supportsEffort: true, supportedEffortLevels: ALL },
      { value: 'haiku', resolvedModel: 'claude-haiku-4-5-20251001', displayName: 'Haiku 4.5', description: 'Fastest for quick answers' },
      { value: 'claude-sonnet-5', resolvedModel: 'claude-sonnet-5', displayName: 'Sonnet 5', description: 'Efficient for routine tasks', supportsEffort: true, supportedEffortLevels: ALL },
    ]
    const m = fromInfo(NEW)
    expect(m.map(x => x.id)).toEqual(['claude-haiku-4-5-20251001', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-sonnet-5'])
    for (const x of m) expect(EXACT_ID.test(x.id), x.id).toBe(true)
    const s = m.find(x => x.id === 'claude-sonnet-5-5')!
    expect([s.name, s.description]).toEqual(['Sonnet 5.5', 'Most efficient for simpler tasks'])
    expect(m[0].aliases).toEqual(['default', 'haiku'])
    expect([m[0].name, m[0].description]).toEqual(['Haiku 4.5', 'Fastest for quick answers'])   // never "Default (recommended)"
    expect(m[0].efforts).toEqual([])
  })

  it('refuses an effort the model does not take', () => {
    const [opus, , , haiku] = fromInfo(LIVE)
    expect(() => checkEffort(opus, 'xhigh')).not.toThrow()
    expect(() => checkEffort(haiku, 'low')).toThrow(/takes no effort/)
    expect(() => checkEffort(opus, 'turbo')).toThrow(/takes effort low, medium/)
  })
})
