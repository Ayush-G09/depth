import { describe, expect, it } from 'vitest'
import { Timeline } from './timeline'
import { findWhales } from './whales'
import type { BookFrame } from './types'

const COLS = 10
const STEP = 500
const T0 = 1_000_000 * STEP
const frame = (i: number, bid: [number, number][] = [], ask: [number, number][] = [], cover: [number, number] | null = [-1e9, 1e9]): BookFrame => {
  const bids = new Array<number>(COLS).fill(1)
  const asks = new Array<number>(COLS).fill(1)
  for (const [c, q] of bid) bids[c] = q
  for (const [c, q] of ask) asks[c] = q
  return { type: 'book', symbol: 'X', ts: T0 + i * STEP, seq: i, status: 'live', mid: 100, spread: 1, bucket: 1, k0: 100, cover, bids, asks }
}
const sample = (frames: BookFrame[]) => {
  const t = new Timeline({ slices: 6, intervalMs: STEP })
  frames.forEach((f) => t.push(f))
  return t.sample()!
}

describe('findWhales', () => {
  it('finds a wall that is big in dollars and stands out, on the right side', () => {
    const w = findWhales(sample([frame(0, [[3, 5000]], [[7, 4000]])]))
    expect(w.map((x) => [x.side, x.col])).toEqual([['bid', 3], ['ask', 7]])
    expect(w[0].usd).toBeCloseTo(5000 * 103.5)
    expect(w[0].price).toBeCloseTo(103.5)
  })
  it('ignores a level that is large relative to the book but small in dollars', () => {
    expect(findWhales(sample([frame(0, [[3, 50]])]))).toEqual([])
  })
  it('ignores a level that is large in dollars but not unusual for this book', () => {
    const f = frame(0)
    f.bids.fill(3000); f.asks.fill(3000) // everything is ~300k, so nothing stands out
    f.bids[3] = 4000
    expect(findWhales(sample([f]))).toEqual([])
  })
  it('reports one whale per peak, not one per neighbouring cell', () => {
    const w = findWhales(sample([frame(0, [[3, 4000], [4, 5000], [5, 4000]])]))
    expect(w.filter((x) => x.side === 'bid').map((x) => x.col)).toEqual([4])
  })
  it('never treats unknown cells as whales', () => {
    expect(findWhales(sample([frame(0, [[3, 5000]], [], [104, 108])]))).toEqual([])
  })
  it('counts how long a wall has stood', () => {
    const w = findWhales(sample([frame(0, [[3, 5000]]), frame(1, [[3, 5200]]), frame(2, [[3, 5000]])]))
    expect(w[0].age).toBe(3)
    const fresh = findWhales(sample([frame(0), frame(1), frame(2, [[3, 5000]])]))
    expect(fresh[0].age).toBe(1)
  })
  it('sorts by size and honours max', () => {
    const w = findWhales(sample([frame(0, [[1, 3000], [5, 9000], [8, 6000]])]), { max: 2 })
    expect(w.map((x) => x.col)).toEqual([5, 8])
  })
  it('returns nothing for an empty book', () => {
    const f = frame(0); f.bids.fill(0); f.asks.fill(0)
    expect(findWhales(sample([f]))).toEqual([])
  })
})
