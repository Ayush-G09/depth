import { describe, expect, it } from 'vitest'
import { parseKlines } from './candles'

const row = (t: number, o: string, h: string, l: string, c: string, v = '5') => [t, o, h, l, c, v, t + 59999, '0', 1, '0', '0', '0']

describe('parseKlines', () => {
  it('reads Binance rows into numbers', () => {
    expect(parseKlines([row(1000, '10', '12', '9', '11', '3.5')])).toEqual([{ t: 1000, o: 10, h: 12, l: 9, c: 11, v: 3.5 }])
  })
  it('drops rows that contradict themselves', () => {
    expect(parseKlines([row(1, '10', '9', '12', '11'), row(2, '13', '12', '9', '11'), row(3, '10', '12', '9', '13')])).toEqual([])
  })
  it('drops malformed rows, keeps the good ones', () => {
    const r = parseKlines([[1], 'x', row(2, 'abc', '1', '1', '1'), row(3, '10', '12', '9', '11'), row(4, '-1', '2', '1', '1')])
    expect(r.map((c) => c.t)).toEqual([3])
  })
  it('requires time to move forward', () => {
    expect(parseKlines([row(5, '1', '2', '1', '2'), row(5, '1', '2', '1', '2'), row(4, '1', '2', '1', '2')]).length).toBe(1)
  })
  it('tolerates a non-array', () => {
    expect(parseKlines({})).toEqual([])
    expect(parseKlines(null)).toEqual([])
  })
})
