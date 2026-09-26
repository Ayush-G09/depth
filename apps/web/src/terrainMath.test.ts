import { describe, expect, it } from 'vitest'
import { Timeline } from '@depth/core'
import type { BookFrame } from '@depth/core'
import { DEPTH, HEIGHT_CURVE, MAX_HEIGHT, UNKNOWN, WIDTH, colOfPrice, fillTerrain, heightOf, priceOfCol, referenceQty, smoothRow, xOfCol, zOfRow } from './terrainMath'

const frame = (ts: number, o: Partial<BookFrame> = {}): BookFrame => {
  const bids = new Array<number>(20).fill(0)
  const asks = new Array<number>(20).fill(0)
  return { type: 'book', symbol: 'X', ts, seq: 1, status: 'live', mid: 100.2, spread: 0.2, bucket: 0.5, k0: 190, cover: [-1e12, 1e12], bids, asks, ...o }
}
const sampleOf = (f: BookFrame, rows = 3) => {
  const t = new Timeline({ slices: rows, intervalMs: 500 })
  t.push(f)
  return t.sample()!
}

describe('scene coordinates', () => {
  it('spread the columns across the full width, centred', () => {
    expect(xOfCol(0, 11)).toBe(-WIDTH / 2)
    expect(xOfCol(10, 11)).toBe(WIDTH / 2)
    expect(xOfCol(5, 11)).toBeCloseTo(0, 10)
  })
  it('put the newest row at the front and the oldest at the back', () => {
    expect(zOfRow(0, 5)).toBe(-DEPTH / 2)
    expect(zOfRow(4, 5)).toBe(DEPTH / 2)
  })
  it('price and column are inverses, and a price inside a bucket lands on that bucket’s column', () => {
    const s = { bucket: 0.5, k0: 190 }
    for (const col of [0, 3.5, 10, 19]) expect(colOfPrice(priceOfCol(col, s), s)).toBeCloseTo(col, 9)
    // bucket 190 covers prices [95, 95.5): its centre is 95.25, which is column 0
    expect(priceOfCol(0, s)).toBe(95.25)
    expect(Math.round(colOfPrice(95.25, s))).toBe(0)
    expect(Math.round(colOfPrice(95.4, s))).toBe(0) // still inside bucket 190
    expect(Math.round(colOfPrice(95.6, s))).toBe(1) // next bucket
  })
})

describe('heightOf', () => {
  it('is zero for nothing, and grows with size', () => {
    expect(heightOf(0, 1)).toBe(0)
    expect(heightOf(-5, 1)).toBe(0)
    let prev = 0
    for (const q of [0.01, 0.05, 0.2, 0.5, 1, 2]) { const h = heightOf(q, 1); expect(h).toBeGreaterThan(prev); prev = h }
  })
  it('a typical wall is about full height, and a giant one is capped, so it cannot flatten everything else', () => {
    expect(heightOf(1, 1)).toBeCloseTo(MAX_HEIGHT, 5)
    expect(heightOf(1e9, 1)).toBeLessThanOrEqual(MAX_HEIGHT * 1.2 + 1e-9)
  })
  it('keeps small orders visible', () => {
    expect(heightOf(0.05, 1)).toBeGreaterThan(MAX_HEIGHT * 0.2)
    void HEIGHT_CURVE
  })
})

describe('referenceQty', () => {
  it('is a high percentile of the non-empty buckets, ignoring empties', () => {
    const bids = new Array<number>(20).fill(0)
    for (let i = 0; i < 10; i++) bids[i] = i + 1 // 1..10
    const s = sampleOf(frame(1_000_000 * 500, { bids }), 1)
    const ref = referenceQty(s)
    expect(ref).toBeGreaterThanOrEqual(9)
    expect(ref).toBeLessThanOrEqual(10)
  })
  it('does not blow up on an empty book', () => {
    expect(referenceQty(sampleOf(frame(1_000_000 * 500)))).toBe(1)
  })
})

describe('smoothRow', () => {
  it('leaves a flat row flat, edges included', () => {
    const src = new Float32Array(10).fill(4)
    const dst = new Float32Array(10)
    smoothRow(src, dst, 0, 10)
    expect(Array.from(dst)).toEqual(new Array(10).fill(4))
  })
  it('spreads a single spike into a smooth bump that keeps its total', () => {
    const src = new Float32Array(11)
    src[5] = 16
    const dst = new Float32Array(11)
    smoothRow(src, dst, 0, 11)
    expect(Array.from(dst).slice(3, 8)).toEqual([1, 4, 6, 4, 1])
    expect(Array.from(dst).reduce((a, b) => a + b, 0)).toBeCloseTo(16, 5)
  })
  it('reads the requested row of a bigger grid', () => {
    const src = new Float32Array(20)
    src.fill(1, 10, 20) // second row of two rows of 10
    const dst = new Float32Array(10)
    smoothRow(src, dst, 10, 10)
    expect(Array.from(dst).every((v) => v === 1)).toBe(true)
  })
})

describe('fillTerrain', () => {
  const build = (bids: number[], asks: number[]) => {
    const s = sampleOf(frame(1_000_000 * 500, { bids, asks }), 2)
    const positions = new Float32Array(s.rows * s.cols * 3)
    const colors = new Float32Array(s.rows * s.cols * 3)
    fillTerrain(s, 1, positions, colors)
    return { s, positions, colors }
  }
  const empty = () => new Array<number>(20).fill(0)

  it('makes bid columns green-ish and ask columns red-ish', () => {
    const b = empty(); const a = empty()
    for (let i = 2; i < 8; i++) b[i] = 1
    for (let i = 12; i < 18; i++) a[i] = 1
    const { s, colors } = build(b, a)
    const last = (s.rows - 1) * s.cols
    const green = last + 4
    const red = last + 14
    expect(colors[green * 3 + 1]).toBeGreaterThan(colors[green * 3]) // green channel beats red
    expect(colors[red * 3]).toBeGreaterThan(colors[red * 3 + 1]) // red channel beats green
  })

  it('an empty book is flat and dark', () => {
    const { positions, colors } = build(empty(), empty())
    for (let i = 0; i < positions.length / 3; i++) expect(positions[i * 3 + 1]).toBe(0)
    expect(Math.max(...colors)).toBeLessThan(0.12) // the dark floor colour, nothing lit
  })

  it('a wall rises above its neighbours', () => {
    const b = empty()
    for (let i = 0; i < 20; i++) b[i] = 0.1
    b[8] = b[9] = b[10] = 5
    const { s, positions } = build(b, empty())
    const last = (s.rows - 1) * s.cols
    expect(positions[(last + 9) * 3 + 1]).toBeGreaterThan(positions[(last + 1) * 3 + 1])
  })

  it('only touches heights and colours, never the x or z of the grid', () => {
    const s = sampleOf(frame(1_000_000 * 500, { bids: new Array<number>(20).fill(1) }), 2)
    const positions = new Float32Array(s.rows * s.cols * 3)
    positions.fill(7)
    fillTerrain(s, 1, positions, new Float32Array(s.rows * s.cols * 3))
    for (let i = 0; i < positions.length / 3; i++) { expect(positions[i * 3]).toBe(7); expect(positions[i * 3 + 2]).toBe(7) }
  })

  it('draws unknown cells flat and in their own tone, not as empty market', () => {
    const b = new Array<number>(20).fill(0)
    b[5] = 9
    // the book only vouches for prices 96..101.5, so buckets past that are unknown
    const s = sampleOf(frame(1_000_000 * 500, { bids: b, cover: [95, 100] }), 2)
    const positions = new Float32Array(s.rows * s.cols * 3)
    const colors = new Float32Array(s.rows * s.cols * 3)
    fillTerrain(s, 1, positions, colors)
    const last = (s.rows - 1) * s.cols
    const known = last + 2 // bucket 192 covers [96, 96.5): inside
    const unknown = last + 15 // bucket 205 covers [102.5, 103): outside
    expect(s.known[known]).toBe(1)
    expect(s.known[unknown]).toBe(0)
    expect(positions[unknown * 3 + 1]).toBe(0)
    expect(colors[unknown * 3 + 2]).toBeCloseTo(UNKNOWN[2], 5) // the newest row is not faded
    expect(colors[unknown * 3]).not.toBeCloseTo(colors[known * 3], 3) // and it differs from an empty known cell
  })
})
