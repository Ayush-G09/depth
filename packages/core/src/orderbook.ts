import { bucketIndex } from './bucketing'
import type { Level, RawLevel, Side } from './types'

/**
 * The resting orders on both sides of a market, grouped by price.
 * Bids are buyers (highest price first), asks are sellers (lowest first).
 * A quantity of 0 means "nobody is left at this price".
 */
export class OrderBook {
  private readonly bids = new Map<number, number>()
  private readonly asks = new Map<number, number>()
  /** updates that were malformed and skipped, for diagnostics */
  invalidLevels = 0

  get bidCount() { return this.bids.size }
  get askCount() { return this.asks.size }

  clear() {
    this.bids.clear()
    this.asks.clear()
  }

  /** Apply a batch of level changes. Quantities are absolute: they replace what was there. */
  apply(side: Side, levels: readonly (RawLevel | Level)[]) {
    const book = side === 'bid' ? this.bids : this.asks
    for (const [p, q] of levels) {
      const price = typeof p === 'number' ? p : Number(p)
      const qty = typeof q === 'number' ? q : Number(q)
      if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(qty) || qty < 0) { this.invalidLevels++; continue }
      if (qty === 0) book.delete(price)
      else book.set(price, qty)
    }
  }

  bestBid(): number | null {
    let best = -Infinity
    for (const p of this.bids.keys()) if (p > best) best = p
    return best === -Infinity ? null : best
  }

  bestAsk(): number | null {
    let best = Infinity
    for (const p of this.asks.keys()) if (p < best) best = p
    return best === Infinity ? null : best
  }

  /** A healthy book never has a buyer willing to pay at least what a seller asks; if it does, we are out of sync. */
  isCrossed(): boolean {
    const b = this.bestBid()
    const a = this.bestAsk()
    return b !== null && a !== null && b >= a
  }

  mid(): number | null {
    const b = this.bestBid()
    const a = this.bestAsk()
    return b !== null && a !== null ? (b + a) / 2 : null
  }

  spread(): number | null {
    const b = this.bestBid()
    const a = this.bestAsk()
    return b !== null && a !== null ? a - b : null
  }

  quantityAt(side: Side, price: number): number {
    return (side === 'bid' ? this.bids : this.asks).get(price) ?? 0
  }

  /** The `n` levels nearest the middle on each side (bids high to low, asks low to high). */
  top(n: number): { bids: Level[]; asks: Level[] } {
    const bids = [...this.bids.entries()].sort((a, b) => b[0] - a[0]).slice(0, n)
    const asks = [...this.asks.entries()].sort((a, b) => a[0] - b[0]).slice(0, n)
    return { bids, asks }
  }

  /**
   * Sum quantities into price buckets of `width`, over the `count` buckets starting at bucket index `k0`.
   * Returns dense arrays (index i is bucket k0 + i), so they can be drawn or sent as they are.
   */
  buckets(width: number, k0: number, count: number): { bids: number[]; asks: number[] } {
    const bids = new Array<number>(count).fill(0)
    const asks = new Array<number>(count).fill(0)
    for (const [price, qty] of this.bids) {
      const i = bucketIndex(price, width) - k0
      if (i >= 0 && i < count) bids[i] += qty
    }
    for (const [price, qty] of this.asks) {
      const i = bucketIndex(price, width) - k0
      if (i >= 0 && i < count) asks[i] += qty
    }
    return { bids, asks }
  }

  lowestBid(): number | null {
    let low = Infinity
    for (const p of this.bids.keys()) if (p < low) low = p
    return low === Infinity ? null : low
  }

  highestAsk(): number | null {
    let high = -Infinity
    for (const p of this.asks.keys()) if (p > high) high = p
    return high === -Infinity ? null : high
  }

  /** Keep memory bounded: drop the levels farthest from the middle beyond `maxPerSide`. */
  prune(maxPerSide: number) {
    if (this.bids.size > maxPerSide) {
      const keep = new Set([...this.bids.keys()].sort((a, b) => b - a).slice(0, maxPerSide))
      for (const p of this.bids.keys()) if (!keep.has(p)) this.bids.delete(p)
    }
    if (this.asks.size > maxPerSide) {
      const keep = new Set([...this.asks.keys()].sort((a, b) => a - b).slice(0, maxPerSide))
      for (const p of this.asks.keys()) if (!keep.has(p)) this.asks.delete(p)
    }
  }
}
