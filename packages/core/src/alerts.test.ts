import { describe, expect, it } from 'vitest'
import { AlertEngine, priceRule } from './alerts'
import type { AlertRule } from './alerts'
import type { Whale } from './whales'

const whale = (side: 'bid' | 'ask', price: number, usd: number): Whale => ({ side, col: 0, price, qty: 1, usd, age: 1 })

describe('priceRule', () => {
  it('works out the direction from the current price', () => {
    expect(priceRule('a', 'BTCUSDT', 110, 100)).toMatchObject({ dir: 'above' })
    expect(priceRule('a', 'BTCUSDT', 90, 100)).toMatchObject({ dir: 'below' })
  })
  it('refuses nonsense and a level equal to the current price', () => {
    expect(priceRule('a', 'X', 100, 100)).toBeNull()
    expect(priceRule('a', 'X', -5, 100)).toBeNull()
    expect(priceRule('a', 'X', 5, 0)).toBeNull()
  })
})

describe('AlertEngine', () => {
  const up: AlertRule = { id: 'p', symbol: 'BTCUSDT', kind: 'price', dir: 'above', price: 110 }
  const down: AlertRule = { id: 'q', symbol: 'BTCUSDT', kind: 'price', dir: 'below', price: 90 }

  it('fires a price alert once, when the level is reached', () => {
    const e = new AlertEngine()
    expect(e.check([up], 'BTCUSDT', 109, [])).toEqual([])
    expect(e.check([up], 'BTCUSDT', 110, [])).toHaveLength(1)
    expect(e.check([up], 'BTCUSDT', 120, [])).toEqual([])
  })
  it('handles a downward alert, and ignores the wrong direction', () => {
    const e = new AlertEngine()
    expect(e.check([down], 'BTCUSDT', 120, [])).toEqual([])
    expect(e.check([down], 'BTCUSDT', 89, [])).toHaveLength(1)
  })
  it('ignores other markets and a missing price', () => {
    const e = new AlertEngine()
    expect(e.check([up], 'ETHUSDT', 999, [])).toEqual([])
    expect(e.check([up], 'BTCUSDT', null, [])).toEqual([])
  })
  it('a removed rule can be created again with the same id', () => {
    const e = new AlertEngine()
    e.check([up], 'BTCUSDT', 111, [])
    e.forget('p')
    expect(e.check([up], 'BTCUSDT', 111, [])).toHaveLength(1)
  })

  const w: AlertRule = { id: 'w', symbol: 'BTCUSDT', kind: 'whale', minUsd: 1_000_000 }
  it('announces a whale wall once, not on every check', () => {
    const e = new AlertEngine()
    const walls = [whale('bid', 100, 2_000_000)]
    expect(e.check([w], 'BTCUSDT', 100, walls)).toHaveLength(1)
    expect(e.check([w], 'BTCUSDT', 100, walls)).toEqual([])
  })
  it('ignores walls below the threshold', () => {
    expect(new AlertEngine().check([w], 'BTCUSDT', 100, [whale('ask', 101, 900_000)])).toEqual([])
  })
  it('announces a wall again if it went away and came back', () => {
    const e = new AlertEngine()
    const walls = [whale('bid', 100, 2_000_000)]
    e.check([w], 'BTCUSDT', 100, walls)
    e.check([w], 'BTCUSDT', 100, [])
    expect(e.check([w], 'BTCUSDT', 100, walls)).toHaveLength(1)
  })
  it('a second, different wall is announced separately', () => {
    const e = new AlertEngine()
    e.check([w], 'BTCUSDT', 100, [whale('bid', 100, 2_000_000)])
    const r = e.check([w], 'BTCUSDT', 100, [whale('bid', 100, 2_000_000), whale('ask', 105, 3_000_000)])
    expect(r).toHaveLength(1)
    expect(r[0].message).toMatch(/Sell wall/)
  })
})
