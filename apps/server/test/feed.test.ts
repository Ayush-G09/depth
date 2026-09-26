import { afterEach, describe, expect, it } from 'vitest'
import { DepthFeed } from '../src/feed'
import type { FeedOptions } from '../src/feed'
import { FakeExchange, noGate, sleep, waitFor } from './fake-exchange'

const FAST: FeedOptions = {
  rangePct: 2, bins: 50, snapshotLimit: 5000,
  reconnectMinMs: 15, reconnectMaxMs: 120, snapshotRetryMinMs: 15, snapshotRetryMaxMs: 120, staleAfterMs: 250,
}

const feeds: DepthFeed[] = []
function feedFor(ex: FakeExchange, opts: Partial<FeedOptions> = {}) {
  const f = new DepthFeed('BTCUSDT', ex, noGate, { ...FAST, ...opts })
  feeds.push(f)
  return f
}
afterEach(() => { while (feeds.length) feeds.pop()!.stop() })

describe('DepthFeed', () => {
  it('connects, syncs and produces frames that equal the true book', async () => {
    const ex = new FakeExchange(1)
    const f = feedFor(ex)
    f.start()
    await waitFor(() => f.status === 'live', 2000, 'live')
    for (let i = 0; i < 25; i++) ex.publish(3)
    await sleep(10)
    const frame = f.frame(1)
    expect(frame.status).toBe('live')
    expect(frame.bids).toHaveLength(100)
    expect(frame.asks).toHaveLength(100)
    expect(ex.frameMatchesTruth(frame)).toBe(true)
    expect(frame.mid).toBeCloseTo(ex.expectedBuckets(frame.bucket, frame.k0, 100).mid!, 8)
  })

  it('shows "syncing" with an empty book until it is genuinely in sync, then catches up on what it held', async () => {
    const ex = new FakeExchange(2)
    ex.snapshotDelayMs = 120
    const f = feedFor(ex)
    f.start()
    await waitFor(() => ex.handlers !== null, 1000, 'connection')
    await sleep(10)
    for (let i = 0; i < 5; i++) ex.publish(2) // updates arrive while the snapshot is still on its way
    const early = f.frame(1)
    expect(early.status).toBe('syncing')
    expect(early.bids).toEqual([])
    expect(early.asks).toEqual([])
    expect(early.mid).toBeNull()
    await waitFor(() => f.status === 'live', 2000, 'live')
    expect(ex.frameMatchesTruth(f.frame(2))).toBe(true) // nothing that was held has been lost
  })

  it('a lost message is caught by the next one, and the book is rebuilt correctly', async () => {
    const ex = new FakeExchange(3)
    const f = feedFor(ex)
    f.start()
    await waitFor(() => f.status === 'live', 2000, 'live')
    ex.publish(2)
    ex.lose(3) // never arrives
    ex.publish(2) // this one reveals the gap
    expect(f.status).toBe('syncing')
    expect(f.frame(1).bids).toEqual([]) // never shown as live while unsure
    await waitFor(() => f.status === 'live', 2000, 'live again')
    expect(f.stats.resyncs).toBeGreaterThanOrEqual(1)
    expect(ex.frameMatchesTruth(f.frame(2))).toBe(true)
  })

  it('reconnects after the connection drops, and includes everything missed meanwhile', async () => {
    const ex = new FakeExchange(4)
    const f = feedFor(ex)
    f.start()
    await waitFor(() => f.status === 'live', 2000, 'live')
    ex.drop()
    expect(f.status).toBe('connecting')
    ex.lose(10) // the market keeps moving while we are away
    await waitFor(() => ex.connects === 2 && f.status === 'live', 3000, 'reconnected and live')
    expect(f.stats.disconnects).toBe(1)
    expect(ex.frameMatchesTruth(f.frame(1))).toBe(true)
  })

  it('backs off between reconnect attempts instead of hammering', async () => {
    const ex = new FakeExchange(5)
    ex.autoOpen = false // every attempt fails to open
    const f = feedFor(ex, { reconnectMinMs: 40, reconnectMaxMs: 400 })
    f.start()
    for (let i = 0; i < 6; i++) { await waitFor(() => ex.handlers !== null, 2000, 'a connection attempt'); ex.drop() }
    // 40+80+160+320+400... ms of waiting: 6 attempts cannot fit into less than ~300ms even with jitter
    expect(ex.connects).toBeLessThanOrEqual(7)
    expect(ex.connects).toBeGreaterThanOrEqual(6)
  })

  it('retries a failing snapshot endpoint with backoff, and recovers', async () => {
    const ex = new FakeExchange(6)
    ex.failNext = 3
    const f = feedFor(ex)
    f.start()
    await waitFor(() => f.status === 'live', 3000, 'live')
    expect(ex.snapshotCalls).toBe(4)
    expect(f.stats.snapshotErrors).toBe(3)
    expect(ex.frameMatchesTruth(f.frame(1))).toBe(true)
  })

  it('obeys "slow down": it waits at least as long as it was told before asking again', async () => {
    const ex = new FakeExchange(7)
    ex.rateLimitMs = 250
    const f = feedFor(ex)
    const t0 = Date.now()
    f.start()
    await waitFor(() => f.status === 'live', 3000, 'live')
    expect(Date.now() - t0).toBeGreaterThanOrEqual(240)
    expect(ex.snapshotCalls).toBe(2) // one refused, one that worked; nothing in between
  })

  it('an out-of-date snapshot is not trusted: it asks again', async () => {
    const ex = new FakeExchange(8)
    ex.snapshotDelayMs = 30
    ex.staleNext = 2
    const f = feedFor(ex)
    f.start()
    await waitFor(() => ex.handlers !== null, 1000, 'connection')
    await sleep(5)
    for (let i = 0; i < 40; i++) ex.publish(2) // plenty of updates newer than the stale snapshot
    await waitFor(() => f.status === 'live', 3000, 'live')
    expect(ex.snapshotCalls).toBeGreaterThanOrEqual(3)
    expect(ex.frameMatchesTruth(f.frame(1))).toBe(true)
  })

  it('a silent connection is treated as dead and replaced', async () => {
    const ex = new FakeExchange(9)
    const f = feedFor(ex, { staleAfterMs: 120 })
    f.start()
    await waitFor(() => f.status === 'live', 2000, 'live')
    ex.publish(2)
    // then nothing at all arrives: the watchdog should give up on this connection
    await waitFor(() => ex.connects >= 2, 2000, 'a replacement connection')
    await waitFor(() => f.status === 'live', 2000, 'live again')
  })

  it('ignores anything a replaced connection still sends', async () => {
    const ex = new FakeExchange(10)
    const f = feedFor(ex)
    f.start()
    await waitFor(() => f.status === 'live', 2000, 'live')
    const old = ex.handlers!
    ex.drop()
    await waitFor(() => ex.connects === 2 && f.status === 'live', 2000, 'reconnected')
    const before = f.stats.messages
    old.onDiff({ U: 1, u: 1, bids: [['999999', '1']], asks: [] }) // a late frame from the dead connection
    expect(f.stats.messages).toBe(before)
    expect(f.book.bestBid()).not.toBe(999999)
  })

  it('stop() leaves nothing running: no reconnects, and a late snapshot changes nothing', async () => {
    const ex = new FakeExchange(11)
    ex.snapshotDelayMs = 80
    const f = feedFor(ex)
    f.start()
    await waitFor(() => ex.handlers !== null, 1000, 'connection')
    f.stop()
    await sleep(250)
    expect(f.status).toBe('connecting')
    expect(ex.connects).toBe(1)
    expect(ex.closes).toBeGreaterThanOrEqual(1)
  })

  it('picks a bucket width from the price and the window, and keeps it', async () => {
    const ex = new FakeExchange(12)
    const f = feedFor(ex, { rangePct: 2, bins: 50 })
    f.start()
    await waitFor(() => f.status === 'live', 2000, 'live')
    const a = f.frame(1)
    for (let i = 0; i < 30; i++) ex.publish(3)
    const b = f.frame(2)
    expect(a.bucket).toBeGreaterThan(0)
    expect(b.bucket).toBe(a.bucket) // does not jump around
    // the window is centred on the price: the middle bucket contains it
    expect(b.k0 + 50).toBe(Math.floor(b.mid! / b.bucket + 1e-9))
  })

  it('only shows a window the snapshot covers', async () => {
    const ex = new FakeExchange(13)
    // the simulated book only covers about 970..1030 (3% either side of 1000), so asking for 50% must be cut back
    const f = feedFor(ex, { rangePct: 50, bins: 50 })
    f.start()
    await waitFor(() => f.status === 'live', 2000, 'live')
    const frame = f.frame(1)
    const [lo, hi] = frame.cover!
    const windowLo = frame.k0 * frame.bucket
    const windowHi = (frame.k0 + frame.bids.length) * frame.bucket
    expect(windowLo).toBeGreaterThanOrEqual(lo - frame.bucket) // within the covered range (allowing for the bucket the price sits in)
    expect(windowHi).toBeLessThanOrEqual(hi + frame.bucket)
  })

  it('reports how fast updates are arriving', async () => {
    const ex = new FakeExchange(14)
    const f = feedFor(ex)
    f.start()
    await waitFor(() => f.status === 'live', 2000, 'live')
    for (let i = 0; i < 20; i++) ex.publish(1)
    expect(f.updatesPerSecond).toBeGreaterThanOrEqual(20)
  })

  it('a long messy session ends on the truth: drops, gaps, slow snapshots and reconnects', async () => {
    const ex = new FakeExchange(15)
    ex.snapshotDelayMs = 10
    const f = feedFor(ex)
    f.start()
    await waitFor(() => f.status === 'live', 2000, 'live')
    for (let round = 0; round < 12; round++) {
      for (let i = 0; i < 6; i++) ex.publish(1 + (i % 3))
      if (round % 4 === 1) ex.lose(2) // a lost message
      if (round % 5 === 2) ex.drop() // a dropped connection
      await sleep(40)
    }
    for (let i = 0; i < 5; i++) { await waitFor(() => f.status === 'live' && ex.handlers !== null, 3000, 'settled'); ex.publish(2); await sleep(10) }
    await waitFor(() => f.status === 'live', 3000, 'live')
    expect(ex.frameMatchesTruth(f.frame(1))).toBe(true)
    expect(f.book.isCrossed()).toBe(false)
  })
})

describe('DepthFeed coverage', () => {
  it('frames say which price range the book is complete for', async () => {
    const ex = new FakeExchange(21)
    const f = feedFor(ex)
    f.start()
    await waitFor(() => f.status === 'live', 2000, 'live')
    const snap = ex.sim.snapshotAt(ex.sim.lastId)
    const lo = Math.min(...snap.bids.map(([p]) => Number(p)))
    const hi = Math.max(...snap.asks.map(([p]) => Number(p)))
    expect(f.frame(1).cover).toEqual([lo, hi])
  })

  it('a far-away level that shows up in a later update does NOT widen the coverage', async () => {
    const ex = new FakeExchange(22)
    const f = feedFor(ex)
    f.start()
    await waitFor(() => f.status === 'live', 2000, 'live')
    const before = f.frame(1).cover!
    // an update touching a price way beyond anything the snapshot held (real data, but the levels around it are unknown)
    const last = ex.sim.lastId
    ex.handlers!.onDiff({ U: last + 1, u: last + 1, bids: [], asks: [['5000.00', '99.0000']] })
    const after = f.frame(2).cover!
    expect(after).toEqual(before)
    expect(after[1]).toBeLessThan(5000)
  })

  it('frames carry no coverage while syncing', async () => {
    const ex = new FakeExchange(23)
    ex.snapshotDelayMs = 100
    const f = feedFor(ex)
    f.start()
    await waitFor(() => ex.handlers !== null, 1000, 'connection')
    expect(f.frame(1).cover).toBeNull()
  })
})

describe('DepthFeed background refresh', () => {
  // A generous margin makes the window count as "too near the edge" straight away, standing in for the price drifting there
  // (the bucket width is rounded down to 1-2-5, so the window can be well under the covered range).
  const REFRESH: Partial<FeedOptions> = { rangePct: 50, refreshMargin: 2, refreshMinIntervalMs: 60 }

  it('builds a fresh book in the background and swaps it in, and the viewer never sees "syncing"', async () => {
    const ex = new FakeExchange(31)
    ex.snapshotDelayMs = 25
    const f = feedFor(ex, REFRESH)
    f.start()
    await waitFor(() => f.status === 'live', 2000, 'live')
    const statuses = new Set<string>()
    const t0 = Date.now()
    while (f.stats.refreshes < 1 && Date.now() - t0 < 3000) {
      ex.publish(2)
      statuses.add(f.frame(1).status)
      await sleep(8)
    }
    expect(f.stats.refreshes).toBeGreaterThanOrEqual(1)
    expect(statuses).toEqual(new Set(['live'])) // never dropped to syncing while it happened
    ex.publish(2)
    expect(ex.frameMatchesTruth(f.frame(2))).toBe(true) // and the swapped-in book is right
  })

  it('updates that arrive while the background book is being built are not lost', async () => {
    const ex = new FakeExchange(32)
    ex.snapshotDelayMs = 60
    const f = feedFor(ex, REFRESH)
    f.start()
    await waitFor(() => f.status === 'live', 2000, 'live')
    for (let i = 0; i < 40; i++) { ex.publish(1 + (i % 3)); f.frame(1); await sleep(6) }
    await waitFor(() => f.stats.refreshes >= 1, 3000, 'a refresh')
    for (let i = 0; i < 5; i++) ex.publish(2)
    expect(ex.frameMatchesTruth(f.frame(1))).toBe(true)
  })

  it('is rate limited, so a window that cannot be satisfied does not hammer the exchange', async () => {
    const ex = new FakeExchange(33)
    const f = feedFor(ex, { rangePct: 50, refreshMargin: 2, refreshMinIntervalMs: 400 })
    f.start()
    await waitFor(() => f.status === 'live', 2000, 'live')
    const before = ex.snapshotCalls
    const t0 = Date.now()
    while (Date.now() - t0 < 900) { ex.publish(1); f.frame(1); await sleep(10) }
    expect(ex.snapshotCalls - before).toBeLessThanOrEqual(3)
  })

  it('does nothing while the window is comfortably inside the covered range', async () => {
    const ex = new FakeExchange(34)
    const f = feedFor(ex, { refreshMinIntervalMs: 20 }) // default margin
    f.start()
    await waitFor(() => f.status === 'live', 2000, 'live')
    const before = ex.snapshotCalls
    for (let i = 0; i < 60; i++) { ex.publish(1); f.frame(1); await sleep(5) }
    expect(f.stats.refreshes).toBe(0)
    expect(ex.snapshotCalls).toBe(before)
  })

  it('a dropped connection abandons the refresh and starts clean', async () => {
    const ex = new FakeExchange(35)
    ex.snapshotDelayMs = 80
    const f = feedFor(ex, REFRESH)
    f.start()
    await waitFor(() => f.status === 'live', 2000, 'live')
    f.frame(1) // notices the window is near the edge and starts refreshing
    await sleep(10)
    ex.drop()
    await waitFor(() => ex.connects === 2 && f.status === 'live', 3000, 'reconnected and live')
    ex.publish(2)
    expect(ex.frameMatchesTruth(f.frame(2))).toBe(true)
  })

  it('a failing snapshot endpoint during a refresh leaves the live book untouched', async () => {
    const ex = new FakeExchange(36)
    const f = feedFor(ex, REFRESH)
    f.start()
    await waitFor(() => f.status === 'live', 2000, 'live')
    ex.failNext = 3
    for (let i = 0; i < 30; i++) { ex.publish(2); f.frame(1); await sleep(10) }
    expect(f.status).toBe('live')
    expect(ex.frameMatchesTruth(f.frame(2))).toBe(true)
  })
})
