import { describe, expect, it } from 'vitest'
import { bucketIndex, bucketPrice, decimalsOf, niceStep, niceStepDown, roundTo } from './bucketing'
import { OrderBook } from './orderbook'

describe('niceStep', () => {
  it('rounds up to 1, 2 or 5 times a power of ten', () => {
    expect(niceStep(1.68)).toBe(2)
    expect(niceStep(0.06)).toBe(0.1)
    expect(niceStep(0.04)).toBe(0.05)
    expect(niceStep(3)).toBe(5)
    expect(niceStep(7)).toBe(10)
    expect(niceStep(12)).toBe(20)
    expect(niceStep(500)).toBe(500)
    expect(niceStep(501)).toBe(1000)
  })
  it('exact powers stay put, and never round down', () => {
    for (const x of [0.01, 0.1, 1, 10, 100, 2, 0.2, 5, 0.5]) expect(niceStep(x)).toBe(x)
    for (let x = 0.003; x < 5000; x *= 1.37) expect(niceStep(x)).toBeGreaterThanOrEqual(x * 0.999999)
  })
  it('gives no float noise', () => {
    expect(String(niceStep(0.03))).toBe('0.05')
    expect(String(niceStep(0.0007))).toBe('0.001')
  })
  it('falls back to 1 for nonsense', () => {
    expect(niceStep(0)).toBe(1)
    expect(niceStep(-3)).toBe(1)
    expect(niceStep(NaN)).toBe(1)
    expect(niceStep(Infinity)).toBe(1)
  })
})

describe('niceStepDown', () => {
  it('rounds down to 1, 2 or 5 times a power of ten', () => {
    expect(niceStepDown(1.68)).toBe(1)
    expect(niceStepDown(2)).toBe(2)
    expect(niceStepDown(4.9)).toBe(2)
    expect(niceStepDown(7)).toBe(5)
    expect(niceStepDown(0.51)).toBe(0.5)
    expect(niceStepDown(0.049)).toBe(0.02)
    expect(niceStepDown(19)).toBe(10)
  })
  it('never exceeds the value it was given', () => {
    for (let x = 0.0031; x < 9000; x *= 1.29) expect(niceStepDown(x)).toBeLessThanOrEqual(x * (1 + 1e-9))
  })
  it('is within a factor of 2.5 of the value (so the picture is not needlessly coarse)', () => {
    for (let x = 0.0031; x < 9000; x *= 1.29) expect(x / niceStepDown(x)).toBeLessThan(2.5 + 1e-9)
  })
  it('exact nice values stay put', () => {
    for (const x of [0.01, 0.02, 0.05, 0.1, 1, 2, 5, 10, 500]) expect(niceStepDown(x)).toBe(x)
  })
  it('falls back to 1 for nonsense', () => {
    expect(niceStepDown(0)).toBe(1)
    expect(niceStepDown(-1)).toBe(1)
    expect(niceStepDown(NaN)).toBe(1)
  })
})

describe('bucketIndex / bucketPrice', () => {
  it('puts a price in the bucket whose range contains it', () => {
    expect(bucketIndex(84074.76, 2)).toBe(42037)
    expect(bucketPrice(42037, 2)).toBe(84074)
    expect(bucketIndex(84075.99, 2)).toBe(42037)
    expect(bucketIndex(84076, 2)).toBe(42038)
  })
  it('is not fooled by float error at bucket edges', () => {
    expect(bucketIndex(0.3, 0.1)).toBe(3) // 0.3 / 0.1 is 2.9999999999999996 in floating point
    expect(bucketIndex(0.15, 0.05)).toBe(3)
    expect(bucketIndex(1.1, 0.1)).toBe(11)
  })
  it('bucketPrice removes float noise', () => {
    expect(bucketPrice(3, 0.05)).toBe(0.15)
    expect(bucketPrice(7, 0.1)).toBe(0.7)
    expect(bucketPrice(-4, 0.5)).toBe(-2)
  })
  it('round trips: a bucket edge lands in its own bucket', () => {
    for (const w of [0.01, 0.05, 0.5, 2, 10]) for (let k = 1; k < 200; k += 7) expect(bucketIndex(bucketPrice(k, w), w)).toBe(k)
  })
  it('decimalsOf and roundTo', () => {
    expect(decimalsOf(0.05)).toBe(2)
    expect(decimalsOf(2)).toBe(0)
    expect(decimalsOf(0.001)).toBe(3)
    expect(decimalsOf(1e-7)).toBe(7)
    expect(roundTo(1.23456, 2)).toBe(1.23)
  })
})

describe('OrderBook.buckets', () => {
  const book = () => {
    const b = new OrderBook()
    b.apply('bid', [['99.9', '1'], ['99.5', '2'], ['99.4', '3'], ['98.0', '4'], ['90', '9']])
    b.apply('ask', [['100.1', '1'], ['100.4', '2'], ['100.5', '3'], ['102.0', '4'], ['110', '9']])
    return b
  }

  it('sums quantities that fall in the same bucket', () => {
    const w = 1
    const k0 = bucketIndex(95, w) // window 95..105
    const { bids, asks } = book().buckets(w, k0, 10)
    expect(bids[bucketIndex(99.9, w) - k0]).toBe(1 + 2 + 3) // 99.9, 99.5, 99.4 are all in [99, 100)
    expect(bids[bucketIndex(98, w) - k0]).toBe(4)
    expect(asks[bucketIndex(100.1, w) - k0]).toBe(1 + 2 + 3) // 100.1, 100.4, 100.5 in [100, 101)
    expect(asks[bucketIndex(102, w) - k0]).toBe(4)
  })

  it('leaves out prices outside the window, and never puts a bid in an ask array', () => {
    const w = 1
    const k0 = bucketIndex(95, w)
    const { bids, asks } = book().buckets(w, k0, 10)
    expect(bids.reduce((a, b) => a + b, 0)).toBe(10) // the bid at 90 is outside 95..105
    expect(asks.reduce((a, b) => a + b, 0)).toBe(10) // the ask at 110 too
  })

  it('conserves total quantity when the window covers the whole book', () => {
    const b = new OrderBook()
    let total = 0
    for (let p = 90; p < 100; p += 0.13) { const q = 1 + (p % 3); b.apply('bid', [[p.toFixed(2), String(q)]]); total += q }
    const { bids } = b.buckets(0.5, bucketIndex(85, 0.5), 60)
    expect(bids.reduce((a, c) => a + c, 0)).toBeCloseTo(total, 8)
  })

  it('returns a dense array of the requested length', () => {
    const { bids, asks } = new OrderBook().buckets(1, 0, 7)
    expect(bids).toEqual([0, 0, 0, 0, 0, 0, 0])
    expect(asks).toHaveLength(7)
  })
})

describe('OrderBook.lowestBid / highestAsk', () => {
  it('are the outermost levels held', () => {
    const b = new OrderBook()
    b.apply('bid', [['99', '1'], ['90', '1'], ['95', '1']])
    b.apply('ask', [['101', '1'], ['120', '1'], ['110', '1']])
    expect(b.lowestBid()).toBe(90)
    expect(b.highestAsk()).toBe(120)
  })
  it('are null for an empty side', () => {
    const b = new OrderBook()
    expect(b.lowestBid()).toBeNull()
    expect(b.highestAsk()).toBeNull()
  })
})
