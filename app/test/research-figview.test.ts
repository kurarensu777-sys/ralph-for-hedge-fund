import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { MAX_FIT, MAX_ZOOM, centred, fitScale, step, wheelZoom, zoomAt } from '../src/rooms/research/figview.ts'
import { clampWidth } from '../src/ui/edge.tsx'
import { getFocus, setFocus, toggleFocus } from '../src/shell/focus.ts'

// The Research room's resize, focus and figure viewer (the owner, 2026-09-28): the arithmetic each
// one rests on, pinned with literals, and the seams they go through.

describe('the drag edge', () => {
  it('keeps a width inside its floor and its ceiling', () => {
    expect(clampWidth(500, 300, 800)).toBe(500)
    expect(clampWidth(120, 300, 800)).toBe(300)
    expect(clampWidth(950, 300, 800)).toBe(800)
    expect(clampWidth(412.6, 300, 800)).toBe(413)
  })
  it('never drags a column below its floor, even when the window leaves no room', () => {
    expect(clampWidth(500, 300, 180)).toBe(300)
    expect(clampWidth(500, 300, -40)).toBe(300)
  })
})

describe('focus', () => {
  it('toggles one part of one room, and a second press puts it back', () => {
    setFocus(null)
    toggleFocus('research', 'nb')
    expect(getFocus()).toEqual({ room: 'research', part: 'nb' })
    toggleFocus('research', 'card')
    expect(getFocus()).toEqual({ room: 'research', part: 'card' })
    toggleFocus('research', 'card')
    expect(getFocus()).toBeNull()
  })
  it('the room keeps its own track when the list and the rail are both folded', () => {
    // auto-placement put .main in the list's 0px track: a blank room with Ctrl B + the rail folded
    const css = readFileSync(new URL('../src/shell/shell.css', import.meta.url), 'utf8')
    expect(css).toMatch(/\.shell > \.main \{ grid-column: 3 \}/)
    expect(css).toMatch(/\.shell > \.rail \{ grid-column: 4 \}/)
  })
  it('the shell folds its list and rail through the seam, and Esc clears it', () => {
    const shell = readFileSync(new URL('../src/shell/Shell.tsx', import.meta.url), 'utf8')
    expect(shell).toMatch(/useFocusOf\(room\)/)
    expect(shell).toMatch(/railOpen && !focus \? '' : 'no-rail'/)
    expect(shell).toMatch(/k === 'escape'\) \{ if \(!pal && !drawer && getFocus\(\)\) setFocus\(null\)/)
  })
})

describe('the figure viewer', () => {
  it('fits a figure inside the window, padding kept, blown up at most MAX_FIT', () => {
    // 1600x900 into 1440x860 with 24px kept clear: the width binds, (1440 - 48) / 1600
    expect(fitScale(1600, 900, 1440, 860)).toBeCloseTo(0.87, 5)
    // a 400x300 chart on a 1920x1040 box: the height binds at (1040 - 48) / 300 = 3.3067
    expect(fitScale(400, 300, 1920, 1040)).toBeCloseTo(3.3067, 3)
    expect(fitScale(100, 50, 1920, 1040)).toBe(MAX_FIT)
    expect(fitScale(0, 0, 1920, 1040)).toBe(1)
    // the step arrows keep 72px clear at each side: (1920 - 144) / 1600
    expect(fitScale(1600, 900, 1920, 1200, 72)).toBeCloseTo(1.11, 5)
  })
  it('centres the figure on the box', () => {
    expect(centred(1600, 900, 0.5)).toEqual({ z: 0.5, tx: -400, ty: -225 })
  })
  it('zooms at the pointer: the point under it stays under it', () => {
    const v = centred(1600, 900, 1)
    const px = 300, py = -120
    const at = (w: typeof v) => ({ x: (px - w.tx) / w.z, y: (py - w.ty) / w.z })
    const z2 = zoomAt(v, 2.5, px, py)
    expect(z2.z).toBe(2.5)
    expect(at(z2).x).toBeCloseTo(at(v).x, 9)
    expect(at(z2).y).toBeCloseTo(at(v).y, 9)
  })
  it('a wheel notch zooms in or out, never below the fit, never past MAX_ZOOM', () => {
    expect(wheelZoom(1, -100, 0.5)).toBeCloseTo(1.15, 9)
    expect(wheelZoom(1, 100, 0.5)).toBeCloseTo(1 / 1.15, 9)
    expect(wheelZoom(0.52, 100, 0.5)).toBe(0.5)
    expect(wheelZoom(MAX_ZOOM, -100, 0.5)).toBe(MAX_ZOOM)
  })
  it('steps through the figures, wrapping at both ends', () => {
    expect(step(0, -1, 4)).toBe(3)
    expect(step(3, 1, 4)).toBe(0)
    expect(step(1, 1, 4)).toBe(2)
    expect(step(0, 1, 0)).toBe(0)
  })
})
