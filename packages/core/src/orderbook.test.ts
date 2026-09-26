import { describe, expect, it } from 'vitest'
import { OrderBook } from './orderbook'

describe('OrderBook', () => {
  it('starts empty', () => {
    const b = new OrderBook()
    expect(b.bestBid()).toBeNull()
    expect(b.bestAsk()).toBeNull()
    expect(b.mid()).toBeNull()
    expect(b.spread()).toBeNull()
    expect(b.isCrossed()).toBe(false)
  })

  it('reads decimal strings from the exchange', () => {
    const b = new OrderBook()
    b.apply('bid', [['84074.76000000', '8.85283000']])
    expect(b.quantityAt('bid', 84074.76)).toBe(8.85283)
  })

  it('finds the best bid (highest) and best ask (lowest), the middle and the spread', () => {
    const b = new OrderBook()
    b.apply('bid', [['99', '1'], ['100', '2'], ['98', '3']])
    b.apply('ask', [['102', '1'], ['101', '5'], ['103', '2']])
    expect(b.bestBid()).toBe(100)
    expect(b.bestAsk()).toBe(101)
    expect(b.mid()).toBe(100.5)
    expect(b.spread()).toBe(1)
  })

  it('a quantity replaces (never adds to) what was there', () => {
    const b = new OrderBook()
    b.apply('bid', [['100', '5']])
    b.apply('bid', [['100', '2']])
    expect(b.quantityAt('bid', 100)).toBe(2)
  })

  it('a quantity of zero removes the level', () => {
    const b = new OrderBook()
    b.apply('ask', [['101', '5'], ['102', '5']])
    b.apply('ask', [['101', '0.00000000']])
    expect(b.bestAsk()).toBe(102)
    expect(b.askCount).toBe(1)
  })

  it('removing a level that is not there is harmless', () => {
    const b = new OrderBook()
    b.apply('bid', [['100', '0']])
    expect(b.bidCount).toBe(0)
    expect(b.invalidLevels).toBe(0)
  })

  it('top(n) returns the nearest levels, bids high to low and asks low to high', () => {
    const b = new OrderBook()
    b.apply('bid', [['95', '1'], ['99', '1'], ['97', '1'], ['98', '1']])
    b.apply('ask', [['105', '1'], ['101', '1'], ['103', '1'], ['102', '1']])
    const { bids, asks } = b.top(3)
    expect(bids.map((l) => l[0])).toEqual([99, 98, 97])
    expect(asks.map((l) => l[0])).toEqual([101, 102, 103])
  })

  it('top(n) with fewer levels than n returns what there is', () => {
    const b = new OrderBook()
    b.apply('bid', [['1', '1']])
    expect(b.top(10).bids).toHaveLength(1)
    expect(b.top(10).asks).toHaveLength(0)
  })

  it('detects a crossed book, including a locked one (bid equals ask)', () => {
    const b = new OrderBook()
    b.apply('bid', [['101', '1']])
    b.apply('ask', [['100', '1']])
    expect(b.isCrossed()).toBe(true)
    const locked = new OrderBook()
    locked.apply('bid', [['100', '1']])
    locked.apply('ask', [['100', '1']])
    expect(locked.isCrossed()).toBe(true)
  })

  it('skips malformed levels instead of corrupting the book', () => {
    const b = new OrderBook()
    b.apply('bid', [['abc', '1'], ['100', 'x'], ['-5', '1'], ['0', '1'], ['100', '-1'], ['NaN', '1'], ['100', '1']])
    expect(b.bidCount).toBe(1)
    expect(b.invalidLevels).toBe(6)
    expect(b.bestBid()).toBe(100)
  })

  it('prune keeps the levels nearest the middle', () => {
    const b = new OrderBook()
    for (let p = 1; p <= 100; p++) b.apply('bid', [[String(p), '1']])
    for (let p = 101; p <= 200; p++) b.apply('ask', [[String(p), '1']])
    b.prune(10)
    expect(b.bidCount).toBe(10)
    expect(b.askCount).toBe(10)
    expect(b.top(10).bids.map((l) => l[0])).toEqual([100, 99, 98, 97, 96, 95, 94, 93, 92, 91])
    expect(b.top(10).asks.map((l) => l[0])).toEqual([101, 102, 103, 104, 105, 106, 107, 108, 109, 110])
  })

  it('clear empties both sides', () => {
    const b = new OrderBook()
    b.apply('bid', [['1', '1']])
    b.apply('ask', [['2', '1']])
    b.clear()
    expect(b.bidCount + b.askCount).toBe(0)
  })

  it('accepts numeric levels too (used when copying books)', () => {
    const b = new OrderBook()
    b.apply('bid', [[100, 2]])
    expect(b.quantityAt('bid', 100)).toBe(2)
  })
})
