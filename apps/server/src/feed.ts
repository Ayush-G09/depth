import { EventEmitter } from 'node:events'
import { SyncedBook, bucketIndex, niceStepDown } from '@depth/core'
import type { BookFrame, Snapshot } from '@depth/core'
import { RateLimited } from './exchange'
import type { Connection, Exchange } from './exchange'

export interface FeedOptions {
  /** Price window to show, as a percentage of the price (each side). Shrunk if the snapshot cannot vouch for it. */
  rangePct: number
  /** Buckets per side. */
  bins: number
  /** How many levels to ask the exchange for in a snapshot. */
  snapshotLimit: number
  /** Timing knobs (milliseconds); tests shrink them. */
  reconnectMinMs?: number
  reconnectMaxMs?: number
  snapshotRetryMinMs?: number
  snapshotRetryMaxMs?: number
  /** No message for this long on a live connection means it is dead: reconnect. */
  staleAfterMs?: number
  /**
   * Start a background refresh when the window (plus this fraction of slack) would reach past the price range the
   * current snapshot covered. The drifting price slowly walks the window toward the edge of what we know.
   */
  refreshMargin?: number
  /** Never refresh more often than this. */
  refreshMinIntervalMs?: number
}

export type FeedStatus = 'connecting' | 'syncing' | 'live'

/** Something that hands out permission to fetch a snapshot, so all feeds together stay under the exchange's rate limit. */
export interface SnapshotGate { wait(): Promise<void> }

/**
 * Keeps one market's order book in sync with the exchange, forever: it connects, buffers updates, fetches a
 * snapshot, and follows the documented procedure (see SyncedBook). It reconnects after drops, re-syncs after
 * gaps, and backs off when the exchange says to. `frame()` only ever describes a book it can vouch for.
 */
export class DepthFeed extends EventEmitter {
  status: FeedStatus = 'connecting'
  readonly stats = { connects: 0, messages: 0, snapshots: 0, snapshotErrors: 0, resyncs: 0, refreshes: 0, disconnects: 0, lastMessageAt: 0, lastError: '' }

  private sync = new SyncedBook()
  private conn: Connection | null = null
  private generation = 0 // bumped on every (re)connect so a slow snapshot from an old connection is ignored
  private inflight = false
  private shadow: SyncedBook | null = null // a second book being built in the background, swapped in when ready
  private refreshing = false
  private lastRefreshAt = 0
  private stopped = true
  private reconnectAttempt = 0
  private reconnectTimer?: ReturnType<typeof setTimeout>
  private watchdog?: ReturnType<typeof setInterval>
  private bucket = 0
  private bucketMid = 0
  private rate: number[] = [] // message timestamps of the last second
  private readonly o: Required<FeedOptions>

  constructor(readonly symbol: string, private readonly exchange: Exchange, private readonly gate: SnapshotGate, opts: FeedOptions) {
    super()
    this.o = {
      reconnectMinMs: 500, reconnectMaxMs: 30_000, snapshotRetryMinMs: 1000, snapshotRetryMaxMs: 15_000, staleAfterMs: 15_000,
      refreshMargin: 0.15, refreshMinIntervalMs: 30_000,
      ...opts,
    }
  }

  start() {
    if (!this.stopped) return
    this.stopped = false
    this.watchdog = setInterval(() => {
      if (this.conn && Date.now() - this.stats.lastMessageAt > this.o.staleAfterMs && this.stats.lastMessageAt > 0) this.dropConnection('no data for too long')
    }, Math.max(50, Math.min(5000, this.o.staleAfterMs / 3)))
    this.watchdog.unref?.()
    this.open()
  }

  stop() {
    this.stopped = true
    clearTimeout(this.reconnectTimer)
    clearInterval(this.watchdog)
    this.generation++
    this.conn?.close()
    this.conn = null
    this.setStatus('connecting')
  }

  get updatesPerSecond() {
    const cutoff = Date.now() - 1000
    this.rate = this.rate.filter((t) => t >= cutoff)
    return this.rate.length
  }

  // ---- connection lifecycle ----

  private open() {
    if (this.stopped) return
    const gen = ++this.generation
    this.sync = new SyncedBook()
    this.shadow = null
    this.setStatus('connecting')
    this.stats.connects++
    this.conn = this.exchange.connect(this.symbol, {
      onOpen: () => {
        if (gen !== this.generation) return
        this.reconnectAttempt = 0
        this.stats.lastMessageAt = Date.now()
        this.setStatus('syncing')
        void this.getSnapshot(gen)
      },
      onDiff: (e) => { if (gen === this.generation) this.handleDiff(e, gen) },
      onClose: (reason) => { if (gen === this.generation) this.handleClose(reason) },
    })
  }

  private handleClose(reason: string) {
    this.stats.disconnects++
    this.stats.lastError = reason
    this.conn = null
    this.setStatus('connecting')
    if (this.stopped) return
    const base = Math.min(this.o.reconnectMaxMs, this.o.reconnectMinMs * 2 ** this.reconnectAttempt++)
    this.reconnectTimer = setTimeout(() => this.open(), base * (0.75 + Math.random() * 0.5))
  }

  /** Throw the connection away (it stopped delivering) and let the normal reconnect path take over. */
  private dropConnection(why: string) {
    const c = this.conn
    this.generation++ // ignore anything the old connection still reports
    this.conn = null
    c?.close()
    this.handleClose(why)
  }

  // ---- updates ----

  private handleDiff(e: Parameters<SyncedBook['onDiff']>[0], gen: number) {
    this.stats.messages++
    this.stats.lastMessageAt = Date.now()
    this.rate.push(Date.now())
    this.shadow?.onDiff(e) // the background book sees exactly the same events
    const r = this.sync.onDiff(e)
    if (r === 'resync') {
      this.stats.resyncs++
      this.setStatus('syncing')
      void this.getSnapshot(gen)
    }
  }

  /** Fetch a snapshot and hand it to the book, retrying (with backoff) until it goes live or the connection changes. */
  private async getSnapshot(gen: number) {
    if (this.inflight) return
    this.inflight = true
    let attempt = 0
    try {
      while (gen === this.generation && !this.stopped) {
        try {
          await this.gate.wait()
          if (gen !== this.generation) return
          const snap: Snapshot = await this.exchange.fetchSnapshot(this.symbol, this.o.snapshotLimit)
          if (gen !== this.generation) return
          this.stats.snapshots++
          const r = this.sync.onSnapshot(snap)
          if (r === 'live') { this.becameLive(); return }
          if (r === 'ignored') return
          // 'stale' (snapshot older than the updates we hold) or 'resync': try again shortly
          if (r === 'resync') this.stats.resyncs++
          attempt = 0
          await this.sleep(this.o.snapshotRetryMinMs, gen)
        } catch (err) {
          this.stats.snapshotErrors++
          this.stats.lastError = (err as Error).message
          const wait = err instanceof RateLimited ? err.retryAfterMs : Math.min(this.o.snapshotRetryMaxMs, this.o.snapshotRetryMinMs * 2 ** attempt++)
          await this.sleep(wait, gen)
        }
      }
    } finally { this.inflight = false }
  }

  private sleep(ms: number, gen: number) {
    return new Promise<void>((resolve) => {
      const t = setTimeout(resolve, ms)
      t.unref?.()
      const check = setInterval(() => { if (gen !== this.generation) { clearTimeout(t); clearInterval(check); resolve() } }, 50)
      check.unref?.()
      setTimeout(() => clearInterval(check), ms + 10).unref?.()
    })
  }

  private becameLive() {
    const mid = this.sync.book.mid()
    const cov = this.sync.coverage
    // Choose the bucket width once, so the picture does not jump around. Only show a window the snapshot covers:
    // outside its price range the book is incomplete (only levels that happened to change ever show up there).
    if (mid !== null && cov && (this.bucket === 0 || Math.abs(mid - this.bucketMid) / this.bucketMid > 0.5)) {
      const reach = Math.min(mid - cov.lo, cov.hi - mid) / mid
      const range = Math.min(this.o.rangePct / 100, reach * 0.85)
      // round DOWN: rounding up would widen the window past what the snapshot covers
      this.bucket = niceStepDown((mid * range) / this.o.bins)
      this.bucketMid = mid
    }
    this.setStatus('live')
  }

  /**
   * As the price drifts, the window slides toward the edge of the range the snapshot covered. Before it gets there,
   * build a fresh book in the background (a "shadow") and swap it in the moment it is ready: the viewer never sees a gap.
   */
  private maybeRefresh(mid: number) {
    if (this.refreshing || this.stopped) return
    const cov = this.sync.coverage
    if (!cov || this.bucket === 0) return
    const half = this.bucket * this.o.bins * (1 + this.o.refreshMargin)
    if (mid + half <= cov.hi && mid - half >= cov.lo) return
    if (Date.now() - this.lastRefreshAt < this.o.refreshMinIntervalMs) return
    void this.refresh(this.generation)
  }

  private async refresh(gen: number) {
    this.refreshing = true
    this.lastRefreshAt = Date.now()
    const shadow = new SyncedBook()
    this.shadow = shadow
    let attempt = 0
    try {
      while (gen === this.generation && !this.stopped && this.shadow === shadow && this.status === 'live') {
        try {
          await this.gate.wait()
          if (gen !== this.generation || this.shadow !== shadow) return
          const snap = await this.exchange.fetchSnapshot(this.symbol, this.o.snapshotLimit)
          if (gen !== this.generation || this.shadow !== shadow) return
          this.stats.snapshots++
          if (shadow.onSnapshot(snap) === 'live') {
            this.sync = shadow // same events, newer snapshot: identical book, wider coverage around the current price
            this.stats.refreshes++
            return
          }
          await this.sleep(this.o.snapshotRetryMinMs, gen)
        } catch (err) {
          this.stats.snapshotErrors++
          this.stats.lastError = (err as Error).message
          const wait = err instanceof RateLimited ? err.retryAfterMs : Math.min(this.o.snapshotRetryMaxMs, this.o.snapshotRetryMinMs * 2 ** attempt++)
          await this.sleep(wait, gen)
        }
      }
    } finally {
      if (this.shadow === shadow) this.shadow = null
      this.refreshing = false
    }
  }

  private setStatus(s: FeedStatus) {
    if (this.status === s) return
    this.status = s
    this.emit('status', s)
  }

  // ---- what we hand to browsers ----

  frame(seq: number, now = Date.now()): BookFrame {
    const live = this.status === 'live' && this.sync.state === 'live' && this.bucket > 0
    const mid = live ? this.sync.book.mid() : null
    if (!live || mid === null) {
      return { type: 'book', symbol: this.symbol, ts: now, seq, status: 'syncing', mid: null, spread: null, bucket: this.bucket, k0: 0, cover: null, bids: [], asks: [] }
    }
    this.maybeRefresh(mid)
    const k0 = bucketIndex(mid, this.bucket) - this.o.bins
    const { bids, asks } = this.sync.book.buckets(this.bucket, k0, this.o.bins * 2)
    const r = (x: number) => Math.round(x * 1e4) / 1e4
    const cov = this.sync.coverage
    return {
      type: 'book', symbol: this.symbol, ts: now, seq, status: 'live', mid, spread: this.sync.book.spread(), bucket: this.bucket, k0,
      cover: cov ? [cov.lo, cov.hi] : null, bids: bids.map(r), asks: asks.map(r),
    }
  }

  get book() { return this.sync.book }
  get syncStats() { return this.sync.stats }
}
