import { OrderBook } from './orderbook'
import type { DiffEvent, Snapshot, SyncResult } from './types'

export interface SyncedBookOptions {
  /** Most events we will hold while waiting for a snapshot before giving up and asking for a newer one. */
  maxBuffer?: number
  /** A safety cap on levels per side (the farthest are dropped). The coverage rule below normally keeps the book far smaller. */
  maxLevels?: number
}

/**
 * Builds a correct local order book from the two things an exchange gives us: a one-off snapshot over
 * HTTP and a stream of incremental updates. This is Binance's documented procedure:
 *
 *  1. Start receiving updates and hold them.
 *  2. Fetch a snapshot; it says "this is the book as of update id N" (`lastUpdateId`).
 *  3. If N is older than the first held update, the snapshot is too old: fetch again.
 *  4. Throw away held updates that ended at or before N.
 *  5. The first update we apply must cover N+1 (U <= N+1 <= u); every later one must start exactly where the
 *     previous ended (U = previous u + 1). Any gap means we missed something, so start over.
 *
 * Nothing here talks to the network, so the whole procedure can be tested with simulated feeds.
 * A book we cannot vouch for is never presented as live: `state` is 'buffering' until step 5 succeeds.
 */
export class SyncedBook {
  readonly book = new OrderBook()
  state: 'buffering' | 'live' = 'buffering'
  /** the update id the book is current to (only meaningful while live) */
  lastUpdateId = 0
  /**
   * The price range the snapshot contained, from its lowest bid to its highest ask. Inside it the book is complete:
   * every level was there at the start and every change since has been applied. Outside it we only know about
   * levels that happened to change, so the book is incomplete there and must not be trusted or drawn as if it were empty.
   */
  coverage: { lo: number; hi: number } | null = null
  readonly stats = { applied: 0, ignored: 0, resyncs: 0, staleSnapshots: 0 }

  private buffer: DiffEvent[] = []
  private overflowed = false
  private readonly maxBuffer: number
  private readonly maxLevels: number

  constructor(opts: SyncedBookOptions = {}) {
    this.maxBuffer = opts.maxBuffer ?? 5000
    this.maxLevels = opts.maxLevels ?? 50_000
  }

  /** Forget everything and start again from step 1. */
  reset() {
    this.book.clear()
    this.buffer = []
    this.overflowed = false
    this.lastUpdateId = 0
    this.coverage = null
    this.state = 'buffering'
    this.stats.resyncs++
  }

  /**
   * One incremental update from the stream.
   *  'buffered' - held until a snapshot arrives
   *  'applied'  - applied to the live book
   *  'ignored'  - older than what we already have (a duplicate)
   *  'resync'   - we lost continuity or the book went wrong; the caller must fetch a new snapshot
   */
  onDiff(e: DiffEvent): SyncResult {
    if (!isDiff(e)) { this.reset(); return 'resync' }

    if (this.state === 'buffering') {
      if (this.buffer.length >= this.maxBuffer) { this.overflowed = true; return 'buffered' } // we can no longer promise continuity
      this.buffer.push(e)
      return 'buffered'
    }
    return this.applyLive(e)
  }

  /**
   * The snapshot the caller asked for after starting to buffer.
   *  'live'   - the book is now in sync
   *  'stale'  - the snapshot is older than the updates we hold; fetch another (held updates are kept)
   *  'resync' - the held updates were not continuous; everything was discarded
   */
  onSnapshot(s: Snapshot): SyncResult {
    if (this.state === 'live') return 'ignored'

    // held updates were dropped because too many piled up: the gap is unbridgeable, start over
    if (this.overflowed) { this.buffer = []; this.overflowed = false; this.stats.staleSnapshots++; return 'stale' }

    const first = this.buffer[0]
    if (first && s.lastUpdateId + 1 < first.U) { this.stats.staleSnapshots++; return 'stale' }

    this.book.clear()
    this.book.apply('bid', s.bids)
    this.book.apply('ask', s.asks)
    this.lastUpdateId = s.lastUpdateId
    // measured now, from the snapshot alone: levels that arrive in later updates must not make it look wider
    const lo = this.book.lowestBid()
    const hi = this.book.highestAsk()
    this.coverage = lo !== null && hi !== null ? { lo, hi } : null

    const pending = this.buffer.filter((e) => e.u > s.lastUpdateId)
    this.buffer = []
    for (const e of pending) {
      const r = this.applyLive(e)
      if (r === 'resync') return 'resync' // applyLive already reset us
      // 'ignored' is fine (an event fully covered by the snapshot)
    }
    this.state = 'live'
    return 'live'
  }

  /** True while we are waiting for the caller to provide a snapshot. */
  get needsSnapshot() { return this.state === 'buffering' }

  private applyLive(e: DiffEvent): SyncResult {
    if (e.u <= this.lastUpdateId) { this.stats.ignored++; return 'ignored' } // already have it
    if (e.U > this.lastUpdateId + 1) { this.reset(); return 'resync' } // we skipped some updates

    // Only levels inside the snapshot's price range are applied. Outside it the book is incomplete (we would only ever
    // learn about levels that happen to change), and keeping those would also push levels we DO know out of a size-limited book.
    const cov = this.coverage
    const inside = (l: readonly [string, string]) => {
      if (!cov) return true
      const p = Number(l[0])
      return p >= cov.lo && p <= cov.hi
    }
    this.book.apply('bid', cov ? e.bids.filter(inside) : e.bids)
    this.book.apply('ask', cov ? e.asks.filter(inside) : e.asks)
    this.lastUpdateId = e.u
    this.stats.applied++
    this.book.prune(this.maxLevels)

    if (this.book.isCrossed()) { this.reset(); return 'resync' } // a book that crosses itself is wrong
    return 'applied'
  }
}

function isDiff(e: unknown): e is DiffEvent {
  const d = e as DiffEvent
  return !!d && Number.isFinite(d.U) && Number.isFinite(d.u) && d.U <= d.u && Array.isArray(d.bids) && Array.isArray(d.asks)
}
