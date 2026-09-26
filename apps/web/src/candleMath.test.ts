import { describe, expect, it } from 'vitest'
import { C_HEIGHT, layoutCandles, thickness } from './candleMath'

const c = (t: number, o: number, h: number, l: number, cl: number) => ({ t, o, h, l, c: cl, v: 1 })

describe('layoutCandles', () => {
  it('has nothing to lay out without candles', () => expect(layoutCandles([])).toBeNull())
  it('keeps every high and low inside the box, with room to spare', () => {
    const L = layoutCandles([c(0, 10, 20, 5, 15), c(1, 15, 30, 12, 25)])!
    expect(L.y(5)).toBeGreaterThan(0)
    expect(L.y(30)).toBeLessThan(C_HEIGHT)
    expect(L.y(30)).toBeGreaterThan(L.y(5))
  })
  it('centres the candles and puts time left to right', () => {
    const L = layoutCandles([c(0, 1, 2, 1, 2), c(1, 1, 2, 1, 2), c(2, 1, 2, 1, 2)])!
    expect(L.x(1)).toBeCloseTo(0)
    expect(L.x(0)).toBeLessThan(L.x(2))
  })
  it('copes with a flat market', () => {
    const L = layoutCandles([c(0, 10, 10, 10, 10)])!
    expect(Number.isFinite(L.y(10))).toBe(true)
  })
  it('only stretches to include far away levels when they are close enough to matter', () => {
    const L = layoutCandles([c(0, 100, 101, 99, 100)], [100.5, 500])!
    expect(L.hi).toBeLessThan(200)
    const flat = layoutCandles([c(0, 100, 101, 99, 100)], [101.8, 100.5])!
    expect(flat.hi).toBeGreaterThan(101.8) // 101.8 is within half a range of the candles, so it is included
  })
})

describe('thickness', () => {
  it('is bigger for more volume, and never zero', () => {
    expect(thickness(0, 10)).toBeGreaterThan(0)
    expect(thickness(10, 10)).toBeGreaterThan(thickness(2, 10))
    expect(thickness(5, 0)).toBeGreaterThan(0)
  })
})
