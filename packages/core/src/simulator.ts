import type { DiffEvent, Level, RawLevel, Snapshot } from './types'

/** A small, seedable random number generator, so a failing test can be replayed exactly. */
export function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

interface Change { id: number; side: 'bid' | 'ask'; price: number; qty: number }

const fmt = (n: number) => n.toFixed(2)
const fmtQty = (n: number) => n.toFixed(4)

/**
 * A pretend exchange with a book we know to be true. Every change gets the next update id. Tests use it
 * to produce the two things a real exchange gives you (REST snapshots and batched diff events) and then
 * compare what a consumer built against the truth as of any update id.
 */
export class SimulatedExchange {
  readonly changes: Change[] = []
  private nextId = 1
  private readonly rand: () => number
  private readonly mid: number

  constructor(seed = 1, mid = 1000, levelsPerSide = 40) {
    this.rand = mulberry32(seed)
    this.mid = mid
    // build an initial book with ids 1..2*levels
    for (let i = 1; i <= levelsPerSide; i++) {
      this.record('bid', mid - i * 0.5, 1 + this.rand() * 9)
      this.record('ask', mid + i * 0.5, 1 + this.rand() * 9)
    }
  }

  get lastId() { return this.nextId - 1 }

  private record(side: 'bid' | 'ask', price: number, qty: number) {
    this.changes.push({ id: this.nextId++, side, price: Math.round(price * 100) / 100, qty: Math.round(qty * 1e4) / 1e4 })
  }

  /** Generate `n` more single-level changes: add, resize or remove a level, never crossing the book. */
  advance(n: number) {
    for (let i = 0; i < n; i++) {
      const side = this.rand() < 0.5 ? 'bid' : 'ask'
      const offset = Math.floor(this.rand() * 60) + 1 // 0.5 .. 30 away from the middle
      const price = side === 'bid' ? this.mid - offset * 0.5 : this.mid + offset * 0.5
      const roll = this.rand()
      this.record(side, price, roll < 0.25 ? 0 : 0.1 + this.rand() * 12) // 25%: the level empties
    }
  }

  /** The true book as it stood right after update `id`. */
  bookAt(id: number): { bids: Map<number, number>; asks: Map<number, number> } {
    const bids = new Map<number, number>()
    const asks = new Map<number, number>()
    for (const c of this.changes) {
      if (c.id > id) break
      const m = c.side === 'bid' ? bids : asks
      if (c.qty === 0) m.delete(c.price)
      else m.set(c.price, c.qty)
    }
    return { bids, asks }
  }

  /** What the REST endpoint would answer at the moment the book was at update `id`. */
  snapshotAt(id: number): Snapshot {
    const { bids, asks } = this.bookAt(id)
    const raw = (m: Map<number, number>): RawLevel[] => [...m.entries()].map(([p, q]) => [fmt(p), fmtQty(q)])
    return { lastUpdateId: id, bids: raw(bids), asks: raw(asks) }
  }

  /** A batched stream event covering updates `from`..`to`, carrying each touched level's quantity as of `to`. */
  eventFor(from: number, to: number): DiffEvent {
    const touched = new Map<string, { side: 'bid' | 'ask'; price: number }>()
    for (const c of this.changes) {
      if (c.id < from) continue
      if (c.id > to) break
      touched.set(`${c.side}:${c.price}`, { side: c.side, price: c.price })
    }
    const at = this.bookAt(to)
    const bids: RawLevel[] = []
    const asks: RawLevel[] = []
    for (const t of touched.values()) {
      const q = (t.side === 'bid' ? at.bids : at.asks).get(t.price) ?? 0
      ;(t.side === 'bid' ? bids : asks).push([fmt(t.price), fmtQty(q)])
    }
    return { U: from, u: to, bids, asks }
  }

  /** Cut the whole history after `fromId` into events of 1–`maxBatch` updates each, like 100 ms batching would. */
  stream(fromId: number, maxBatch = 3): DiffEvent[] {
    const events: DiffEvent[] = []
    let id = fromId
    while (id <= this.lastId) {
      const size = 1 + Math.floor(this.rand() * maxBatch)
      const to = Math.min(id + size - 1, this.lastId)
      events.push(this.eventFor(id, to))
      id = to + 1
    }
    return events
  }
}

/** Sorted [price, qty] lists from a Map, for comparing books. */
export function levelsOf(m: Map<number, number>, desc: boolean): Level[] {
  return [...m.entries()].sort((a, b) => (desc ? b[0] - a[0] : a[0] - b[0]))
}
