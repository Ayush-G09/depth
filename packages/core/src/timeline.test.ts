import { describe, expect, it } from 'vitest'
import { Timeline } from './timeline'
import type { BookFrame } from './types'

const COLS = 8
const frame = (ts: number, o: Partial<BookFrame> & { bid?: [number, number][]; ask?: [number, number][] } = {}): BookFrame => {
  const bids = new Array<number>(COLS).fill(0)
  const asks = new Array<number>(COLS).fill(0)
  for (const [i, q] of o.bid ?? []) bids[i] = q
  for (const [i, q] of o.ask ?? []) asks[i] = q
  return { type: 'book', symbol: 'X', ts, seq: 1, status: 'live', mid: 100, spread: 1, bucket: 1, k0: 96, cover: [-1e12, 1e12], bids, asks, ...o }
}
const STEP = 500
const T0 = 1_000_000 * STEP // a time that lands exactly on a step boundary

describe('Timeline', () => {
  it('has nothing until a live frame arrives', () => {
    const t = new Timeline({ slices: 4, intervalMs: STEP })
    expect(t.sample()).toBeNull()
  })

  it('newest row is last, older rows come before it, and missing steps stay empty', () => {
    const t = new Timeline({ slices: 4, intervalMs: STEP })
    t.push(frame(T0, { bid: [[2, 5]] }))
    t.push(frame(T0 + 2 * STEP, { bid: [[2, 7]] })) // a step skipped in between
    const s = t.sample()!
    expect(s.rows).toBe(4)
    // steps: T0-1, T0, T0+1(missing), T0+2  ->  rows 0..3 (row 0 is before anything we saw)
    expect(s.times).toEqual([T0 - STEP, T0, T0 + STEP, T0 + 2 * STEP])
    expect(s.bids[1 * COLS + 2]).toBe(5)
    expect(s.bids[3 * COLS + 2]).toBe(7)
    expect(s.mids[0]).toBeNaN()
    expect(s.mids[2]).toBeNaN() // the gap is shown as a gap, not made up
    expect(s.mids[1]).toBe(100)
    expect(Array.from(s.bids.slice(2 * COLS, 3 * COLS)).every((x) => x === 0)).toBe(true)
  })

  it('within one step the latest frame wins, so the newest row keeps updating', () => {
    const t = new Timeline({ slices: 3, intervalMs: STEP })
    t.push(frame(T0 + 10, { bid: [[1, 1]] }))
    t.push(frame(T0 + 200, { bid: [[1, 9]] }))
    const s = t.sample()!
    expect(s.bids[2 * COLS + 1]).toBe(9)
    expect(t.size).toBe(1)
  })

  it('a frame that arrives late cannot overwrite a newer one', () => {
    const t = new Timeline({ slices: 3, intervalMs: STEP })
    t.push(frame(T0 + 300, { bid: [[1, 9]] }))
    expect(t.push(frame(T0 + 100, { bid: [[1, 1]] }))).toBe(false)
    expect(t.sample()!.bids[2 * COLS + 1]).toBe(9)
  })

  it('keeps a wall at the same price while the window moves under it', () => {
    const t = new Timeline({ slices: 3, intervalMs: STEP })
    // a wall at price bucket 98. First frame: window starts at 96, so column 2. Later the price rose: window starts at 98, column 0.
    t.push(frame(T0, { k0: 96, bid: [[2, 5]] }))
    t.push(frame(T0 + STEP, { k0: 97, bid: [[1, 5]] }))
    t.push(frame(T0 + 2 * STEP, { k0: 98, bid: [[0, 5]] }))
    const s = t.sample()!
    expect(s.k0).toBe(98) // columns follow the newest window
    for (let r = 0; r < 3; r++) expect(s.bids[r * COLS + 0]).toBe(5) // one straight ridge along the time axis
  })

  it('drops the part of an older window that has scrolled out of the newest one', () => {
    const t = new Timeline({ slices: 2, intervalMs: STEP })
    t.push(frame(T0, { k0: 96, bid: [[0, 4], [7, 3]] })) // prices 96 and 103
    t.push(frame(T0 + STEP, { k0: 100 })) // window now 100..107: price 96 is gone, 103 is column 3
    const s = t.sample()!
    expect(s.bids[0 * COLS + 3]).toBe(3)
    expect(Array.from(s.bids.slice(0, COLS)).reduce((a, b) => a + b, 0)).toBe(3) // the 4 at price 96 fell off the edge
  })

  it('ignores frames that are not live or are malformed', () => {
    const t = new Timeline({ slices: 3, intervalMs: STEP })
    expect(t.push(frame(T0, { status: 'syncing', bids: [], asks: [], mid: null }))).toBe(false)
    expect(t.push(frame(T0, { mid: null }))).toBe(false)
    expect(t.push(frame(T0, { bucket: 0 }))).toBe(false)
    expect(t.push({ ...frame(T0), asks: [1, 2] })).toBe(false)
    expect(t.sample()).toBeNull()
  })

  it('starts over when the price grid changes (another market, or a new bucket width)', () => {
    const t = new Timeline({ slices: 3, intervalMs: STEP })
    t.push(frame(T0, { bid: [[1, 5]] }))
    t.push(frame(T0 + STEP, { bucket: 2, k0: 50, bid: [[1, 8]] }))
    const s = t.sample()!
    expect(s.bucket).toBe(2)
    expect(t.size).toBe(1) // the old rows would not line up, so they are gone
    expect(s.bids[2 * COLS + 1]).toBe(8)
  })

  it('only keeps the last few steps', () => {
    const t = new Timeline({ slices: 3, intervalMs: STEP })
    for (let i = 0; i < 20; i++) t.push(frame(T0 + i * STEP, { bid: [[1, i + 1]] }))
    expect(t.size).toBeLessThanOrEqual(3)
    const s = t.sample()!
    expect([s.bids[0 * COLS + 1], s.bids[1 * COLS + 1], s.bids[2 * COLS + 1]]).toEqual([18, 19, 20])
  })

  it('a very old frame is not kept', () => {
    const t = new Timeline({ slices: 3, intervalMs: STEP })
    t.push(frame(T0 + 100 * STEP))
    expect(t.push(frame(T0))).toBe(false)
  })

  it('reset empties it', () => {
    const t = new Timeline({ slices: 3, intervalMs: STEP })
    t.push(frame(T0))
    t.reset()
    expect(t.sample()).toBeNull()
    expect(t.size).toBe(0)
  })

  it('returns fresh arrays each time, so a renderer can keep or change them', () => {
    const t = new Timeline({ slices: 2, intervalMs: STEP })
    t.push(frame(T0, { bid: [[0, 1]] }))
    const a = t.sample()!
    a.bids[0] = 999
    expect(t.sample()!.bids[1 * COLS]).toBe(1)
  })

  describe('unknown cells (outside what the book vouches for)', () => {
    it('marks buckets outside the coverage as unknown and shows no quantity there', () => {
      const t = new Timeline({ slices: 2, intervalMs: STEP })
      // window covers price buckets 96..103; the book is only complete for prices 98..102
      t.push(frame(T0, { cover: [98, 102], bid: [[0, 9], [3, 4]], ask: [[7, 9], [5, 2]] }))
      const s = t.sample()!
      const row = 1 * COLS
      expect(Array.from(s.known.slice(row, row + COLS))).toEqual([0, 0, 1, 1, 1, 1, 0, 0]) // buckets 98..101 are inside [98, 102]
      expect(s.bids[row + 0]).toBe(0) // the 9 at price 96 is not trusted
      expect(s.asks[row + 7]).toBe(0)
      expect(s.bids[row + 3]).toBe(4)
      expect(s.asks[row + 5]).toBe(2)
    })
    it('a bucket that only partly overlaps the coverage is unknown', () => {
      const t = new Timeline({ slices: 1, intervalMs: STEP })
      t.push(frame(T0, { cover: [98.5, 101.5], bucket: 1, k0: 96 }))
      const s = t.sample()!
      // buckets [99,100) and [100,101) fit inside; [98,99) and [101,102) stick out
      expect(Array.from(s.known)).toEqual([0, 0, 0, 1, 1, 0, 0, 0])
    })
    it('a frame with no coverage information is treated as unknown, never as empty', () => {
      const t = new Timeline({ slices: 1, intervalMs: STEP })
      t.push(frame(T0, { cover: null, bid: [[2, 5]] }))
      const s = t.sample()!
      expect(s.known.every((k) => k === 0)).toBe(true)
      expect(s.bids[2]).toBe(0)
    })
    it('gap rows, and columns outside an older frame’s window, are unknown', () => {
      const t = new Timeline({ slices: 3, intervalMs: STEP })
      t.push(frame(T0, { k0: 96 }))
      t.push(frame(T0 + 2 * STEP, { k0: 100 })) // the newest window starts 4 buckets higher; a step in between is missing
      const s = t.sample()!
      expect(Array.from(s.known.slice(0, COLS)).every((k) => k === 1)).toBe(false) // oldest row: only part of the window overlaps
      expect(Array.from(s.known.slice(1 * COLS, 2 * COLS)).every((k) => k === 0)).toBe(true) // the gap row
      expect(Array.from(s.known.slice(2 * COLS, 3 * COLS)).every((k) => k === 1)).toBe(true)
    })
    it('an older frame is judged by its own coverage, not the newest one', () => {
      const t = new Timeline({ slices: 2, intervalMs: STEP })
      t.push(frame(T0, { cover: [96, 100] })) // then the coverage moved up
      t.push(frame(T0 + STEP, { cover: [100, 104] }))
      const s = t.sample()!
      expect(Array.from(s.known.slice(0, COLS))).toEqual([1, 1, 1, 1, 0, 0, 0, 0])
      expect(Array.from(s.known.slice(COLS, 2 * COLS))).toEqual([0, 0, 0, 0, 1, 1, 1, 1])
    })
  })

  describe('replay', () => {
    it('remembers more than it shows and can be sampled at an earlier step', () => {
      const t = new Timeline({ slices: 3, keep: 10, intervalMs: STEP })
      for (let i = 0; i < 8; i++) t.push(frame(T0 + i * STEP, { bid: [[1, i + 1]] }))
      expect(t.range()).toEqual({ oldest: 1_000_000, newest: 1_000_007 })
      const past = t.sample(1_000_004)!
      expect(past.times[2]).toBe(T0 + 4 * STEP)
      expect([past.bids[1], past.bids[COLS + 1], past.bids[2 * COLS + 1]]).toEqual([3, 4, 5])
      expect(t.sample()!.bids[2 * COLS + 1]).toBe(8) // live is unchanged
    })
    it('forgets steps beyond keep', () => {
      const t = new Timeline({ slices: 2, keep: 4, intervalMs: STEP })
      for (let i = 0; i < 20; i++) t.push(frame(T0 + i * STEP))
      expect(t.size).toBeLessThanOrEqual(4)
    })
    it('asking for the future gives live, and a time before anything gives nothing', () => {
      const t = new Timeline({ slices: 2, keep: 4, intervalMs: STEP })
      t.push(frame(T0))
      expect(t.sample(1e9)!.times[1]).toBe(T0)
      expect(t.sample(1_000_000 - 50)).toBeNull()
    })
  })
})
