import { OrderBook, SimulatedExchange } from '@depth/core'
import type { BookFrame, DiffEvent, Snapshot } from '@depth/core'
import { RateLimited } from '../src/exchange'
import type { ConnectHandlers, Connection, Exchange } from '../src/exchange'

/**
 * An exchange we fully control: we decide when updates arrive, which ones get lost, when the connection drops
 * and how the snapshot endpoint misbehaves. Behind it sits a book we know to be true.
 */
export class FakeExchange implements Exchange {
  readonly sim: SimulatedExchange
  handlers: ConnectHandlers | null = null
  connects = 0
  snapshotCalls = 0
  closes = 0
  snapshotDelayMs = 0
  /** the next N snapshot requests fail with a network error */
  failNext = 0
  /** the next snapshot request is answered "slow down" */
  rateLimitMs = 0
  /** the next N snapshots are old (as if they were cached): older than the updates we hold */
  staleNext = 0
  autoOpen = true
  private conn = 0
  private streamStartId = 0

  constructor(seed = 1) {
    this.sim = new SimulatedExchange(seed, 1000, 60)
    this.sim.advance(200)
  }

  connect(_symbol: string, h: ConnectHandlers): Connection {
    this.connects++
    const mine = ++this.conn
    this.streamStartId = this.sim.lastId // updates from here on are what we will hold
    this.handlers = h
    if (this.autoOpen) queueMicrotask(() => { if (this.conn === mine) h.onOpen() })
    return { close: () => { this.closes++; if (this.conn === mine) this.handlers = null } }
  }

  async fetchSnapshot(_symbol: string, _limit: number): Promise<Snapshot> {
    this.snapshotCalls++
    if (this.snapshotDelayMs) await new Promise((r) => setTimeout(r, this.snapshotDelayMs))
    if (this.rateLimitMs) { const ms = this.rateLimitMs; this.rateLimitMs = 0; throw new RateLimited(ms, 429) }
    if (this.failNext > 0) { this.failNext--; throw new Error('network is down') }
    if (this.staleNext > 0) { this.staleNext--; return this.sim.snapshotAt(Math.max(1, this.streamStartId - 10)) } // older than every update we hold
    return this.sim.snapshotAt(this.sim.lastId)
  }

  /** `k` new changes on the exchange, delivered to us as one update. */
  publish(k = 2): DiffEvent {
    const from = this.sim.lastId + 1
    this.sim.advance(k)
    const e = this.sim.eventFor(from, this.sim.lastId)
    this.handlers?.onDiff(e)
    return e
  }

  /** `k` new changes on the exchange that never reach us (a lost message). */
  lose(k = 2) { this.sim.advance(k) }

  /** the connection dies */
  drop(reason = 'simulated drop') {
    const h = this.handlers
    this.handlers = null
    h?.onClose(reason)
  }

  /** The frame the true book should produce, built independently of the feed. */
  expectedBuckets(bucket: number, k0: number, count: number) {
    const truth = this.sim.bookAt(this.sim.lastId)
    const book = new OrderBook()
    book.apply('bid', [...truth.bids.entries()])
    book.apply('ask', [...truth.asks.entries()])
    const b = book.buckets(bucket, k0, count)
    const r = (x: number) => Math.round(x * 1e4) / 1e4
    return { bids: b.bids.map(r), asks: b.asks.map(r), mid: book.mid() }
  }

  /** Assert-friendly: does a live frame equal the true book? */
  frameMatchesTruth(f: BookFrame) {
    const e = this.expectedBuckets(f.bucket, f.k0, f.bids.length)
    return f.status === 'live' && JSON.stringify(f.bids) === JSON.stringify(e.bids) && JSON.stringify(f.asks) === JSON.stringify(e.asks)
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export async function waitFor(cond: () => boolean, ms = 3000, what = 'condition') {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}`)
    await sleep(5)
  }
}

export const noGate = { wait: () => Promise.resolve() }
