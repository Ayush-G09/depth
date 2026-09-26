import type { TimelineSample } from './timeline'

export interface Whale {
  side: 'bid' | 'ask'
  /** column in the sample grid */
  col: number
  price: number
  qty: number
  /** quantity times price: what the order is worth in the quote currency */
  usd: number
  /** how many consecutive time steps (including now) a wall of at least half this size has stood at this price */
  age: number
}

export interface WhaleOptions {
  /** never call anything smaller than this a whale */
  minUsd?: number
  /** must also be this many times the typical (median) level in view */
  relative?: number
  max?: number
}

/**
 * Large resting orders in the newest row: local peaks that are both big in absolute terms and stand out from
 * the rest of the book. Only cells the book vouches for (`known`) are considered, so a gap in our knowledge is never
 * mistaken for a wall. Note a "whale" here is a resting level (which may be many orders added together).
 */
export function findWhales(s: TimelineSample, o: WhaleOptions = {}): Whale[] {
  const { minUsd = 250_000, relative = 8, max = 12 } = o
  const r = s.rows - 1
  const base = r * s.cols
  const usd = (row: number, c: number, side: 'bid' | 'ask') => {
    const i = row * s.cols + c
    if (!s.known[i]) return 0
    return (side === 'bid' ? s.bids[i] : s.asks[i]) * (s.k0 + c + 0.5) * s.bucket
  }
  const vals: number[] = []
  for (let c = 0; c < s.cols; c++) for (const side of ['bid', 'ask'] as const) { const v = usd(r, c, side); if (v > 0) vals.push(v) }
  if (vals.length === 0) return []
  vals.sort((a, b) => a - b)
  const threshold = Math.max(minUsd, vals[vals.length >> 1] * relative)

  const out: Whale[] = []
  for (const side of ['bid', 'ask'] as const) {
    for (let c = 0; c < s.cols; c++) {
      const v = usd(r, c, side)
      if (v < threshold) continue
      const left = usd(r, c - 1, side)
      const right = usd(r, c + 1, side)
      if (left > v || right > v || left === v) continue // not a peak (on a plateau only the first cell counts)
      let age = 1
      for (let row = r - 1; row >= 0 && usd(row, c, side) >= v / 2; row--) age++
      const i = base + c
      out.push({ side, col: c, price: (s.k0 + c + 0.5) * s.bucket, qty: side === 'bid' ? s.bids[i] : s.asks[i], usd: v, age })
    }
  }
  return out.sort((a, b) => b.usd - a.usd).slice(0, max)
}
