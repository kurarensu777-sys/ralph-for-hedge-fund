import { describe, expect, it } from 'vitest'
import { cardPort, type DashView } from '../src/rooms/dash/index.tsx'

const v = (port: number | null) => ({ port } as DashView)

describe('dash cardPort', () => {
  it('names the port every row shares', () => { expect(cardPort([v(8787), v(8787)])).toBe(8787) })
  it('is null when one row differs, so rows keep their chips', () => { expect(cardPort([v(8787), v(8790)])).toBeNull() })
  it('is null when a row has no port or the card is empty', () => {
    expect(cardPort([v(8787), v(null)])).toBeNull()
    expect(cardPort([])).toBeNull()
  })
})
