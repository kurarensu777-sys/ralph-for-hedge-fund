import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { parseStage, readStage } from '../server/lab/desk.ts'

// the same rule as desk_state in app/loop/tools/_common.py (B-0371)
describe('parseStage', () => {
  it('reads the State line within the first 12 lines', () => {
    expect(parseStage('# acme\n\n**State: PRE-LIVE.** 1 run recorded.\n')).toBe('PRE-LIVE')
    expect(parseStage('# hl\n\n**State: OPENING.** Eight runs.\n')).toBe('OPENING')
    expect(parseStage('# x\n\n**State: LIVE.**\n')).toBe('LIVE')
  })
  it('a line that still carries several options reads PRE-LIVE', () => {
    expect(parseStage('# x\n**State: PRE-LIVE | OPENING | LIVE.**\n')).toBe('PRE-LIVE')
  })
  it('no file, no State line, or one past line 12 reads null, never PRE-LIVE', () => {
    expect(parseStage(null)).toBeNull()
    expect(parseStage('# x\n\nno stage here\n')).toBeNull()
    expect(parseStage([...Array(12).fill('filler'), '**State: LIVE.**'].join('\n'))).toBeNull()
  })
})

describe('readStage (a trimmed desk: cadence.md, no board.md)', () => {
  const root = mkdtempSync(join(tmpdir(), 'desk-stage-'))
  afterAll(() => rmSync(root, { recursive: true, force: true }))

  it('reads PRE-LIVE from cadence.md alone', () => {
    const d = join(root, 'acme')
    mkdirSync(d)
    writeFileSync(join(d, 'cadence.md'), '# acme cadence\n\n**State: PRE-LIVE.** 1 run recorded.\n')
    expect(readStage(d)).toBe('PRE-LIVE')
  })
  it('a desk with no cadence.md reads unknown (null)', () => {
    const d = join(root, 'bare')
    mkdirSync(d)
    writeFileSync(join(d, 'board.md'), '# Board\n\n## State\n\n**LIVE.**\n')   // the old file is not read
    expect(readStage(d)).toBeNull()
  })
})
