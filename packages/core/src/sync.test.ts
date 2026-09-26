import { describe, expect, it } from 'vitest'
import { SyncedBook } from './sync'
import { SimulatedExchange, levelsOf, mulberry32 } from './simulator'
import type { DiffEvent, Snapshot } from './types'

const ev = (U: number, u: number, bids: [string, string][] = [], asks: [string, string][] = []): DiffEvent => ({ U, u, bids, asks })
const snap = (lastUpdateId: number, bids: [string, string][] = [['100', '1']], asks: [string, string][] = [['101', '1']]): Snapshot => ({ lastUpdateId, bids, asks })

describe('SyncedBook: the documented procedure', () => {
  it('drops old events, accepts the one that overlaps the snapshot, then continues', () => {
    const s = new SyncedBook()
    expect(s.onDiff(ev(90, 95, [['99', '9']]))).toBe('buffered') // ended before the snapshot: must be thrown away
    expect(s.onDiff(ev(96, 101, [['100', '7']]))).toBe('buffered') // covers 100+1: the first one we apply
    expect(s.onDiff(ev(102, 105, [], [['101', '3']]))).toBe('buffered')
    expect(s.onSnapshot(snap(100, [['100', '1'], ['99', '2']], [['101', '1']]))).toBe('live')
    expect(s.state).toBe('live')
    expect(s.lastUpdateId).toBe(105)
    expect(s.book.quantityAt('bid', 100)).toBe(7) // the buffered event replaced the snapshot's quantity
    expect(s.book.quantityAt('bid', 99)).toBe(2) // the discarded event did not touch it
    expect(s.book.quantityAt('ask', 101)).toBe(3)
  })

  it('a snapshot older than the events we hold is stale, and the held events are kept for the next try', () => {
    const s = new SyncedBook()
    s.onDiff(ev(200, 205, [['100', '5']]))
    expect(s.onSnapshot(snap(100))).toBe('stale')
    expect(s.state).toBe('buffering')
    expect(s.stats.staleSnapshots).toBe(1)
    expect(s.onSnapshot(snap(199))).toBe('live') // contiguous with 200: exactly on the boundary
    expect(s.lastUpdateId).toBe(205)
  })

  it('a snapshot with nothing buffered goes live straight away', () => {
    const s = new SyncedBook()
    expect(s.onSnapshot(snap(500))).toBe('live')
    expect(s.onDiff(ev(501, 502, [['100', '4']]))).toBe('applied')
    expect(s.book.quantityAt('bid', 100)).toBe(4)
  })

  it('a snapshot that arrives after every held event still works (all events are old)', () => {
    const s = new SyncedBook()
    s.onDiff(ev(1, 5, [['100', '9']]))
    expect(s.onSnapshot(snap(50, [['100', '1']]))).toBe('live')
    expect(s.book.quantityAt('bid', 100)).toBe(1) // the snapshot wins: those events were older
    expect(s.lastUpdateId).toBe(50)
  })

  it('a hole inside the held events cannot be bridged: start over', () => {
    const s = new SyncedBook()
    s.onDiff(ev(101, 102))
    s.onDiff(ev(105, 106)) // 103–104 never arrived
    expect(s.onSnapshot(snap(100))).toBe('resync')
    expect(s.state).toBe('buffering')
    expect(s.book.bidCount).toBe(0)
  })

  it('an overflowing buffer makes the next snapshot stale and clears the buffer', () => {
    const s = new SyncedBook({ maxBuffer: 3 })
    for (let i = 1; i <= 6; i++) s.onDiff(ev(i, i))
    expect(s.onSnapshot(snap(2))).toBe('stale')
    expect(s.onSnapshot(snap(10))).toBe('live') // a fresh attempt from an empty buffer
  })

  it('ignores a snapshot when already live', () => {
    const s = new SyncedBook()
    s.onSnapshot(snap(10))
    expect(s.onSnapshot(snap(9999, [['1', '1']], [['2', '1']]))).toBe('ignored')
    expect(s.lastUpdateId).toBe(10)
  })
})

describe('SyncedBook: once live', () => {
  const live = () => { const s = new SyncedBook(); s.onSnapshot(snap(100)); return s }

  it('applies contiguous events', () => {
    const s = live()
    expect(s.onDiff(ev(101, 103, [['100', '5']]))).toBe('applied')
    expect(s.onDiff(ev(104, 104, [], [['101', '2']]))).toBe('applied')
    expect(s.lastUpdateId).toBe(104)
    expect(s.stats.applied).toBe(2)
  })

  it('ignores duplicates and events older than what we have, without disturbing the book', () => {
    const s = live()
    s.onDiff(ev(101, 103, [['100', '5']]))
    s.onDiff(ev(104, 105, [['100', '6']]))
    expect(s.onDiff(ev(101, 103, [['100', '5']]))).toBe('ignored') // a stale copy must not overwrite the newer 6
    expect(s.onDiff(ev(104, 105, [['100', '6']]))).toBe('ignored')
    expect(s.book.quantityAt('bid', 100)).toBe(6)
    expect(s.stats.ignored).toBe(2)
  })

  it('accepts an event that overlaps what we have and extends it', () => {
    const s = live()
    s.onDiff(ev(101, 103, [['100', '5']]))
    expect(s.onDiff(ev(103, 106, [['100', '8']]))).toBe('applied') // U <= last+1 <= u
    expect(s.lastUpdateId).toBe(106)
    expect(s.book.quantityAt('bid', 100)).toBe(8)
  })

  it('a gap means we missed updates: resync, and the half-built book is discarded', () => {
    const s = live()
    s.onDiff(ev(101, 102, [['100', '5']]))
    expect(s.onDiff(ev(105, 106, [['100', '9']]))).toBe('resync') // 103–104 are missing
    expect(s.state).toBe('buffering')
    expect(s.needsSnapshot).toBe(true)
    expect(s.book.bidCount + s.book.askCount).toBe(0)
    expect(s.stats.resyncs).toBe(1)
  })

  it('after a resync the same procedure recovers', () => {
    const s = live()
    s.onDiff(ev(101, 102))
    s.onDiff(ev(110, 111)) // gap
    s.onDiff(ev(112, 113, [['100', '3']])) // buffered while we wait
    expect(s.onSnapshot(snap(111, [['100', '1']]))).toBe('live')
    expect(s.book.quantityAt('bid', 100)).toBe(3)
    expect(s.lastUpdateId).toBe(113)
  })

  it('removes levels whose quantity goes to zero', () => {
    const s = live()
    s.onDiff(ev(101, 101, [['100', '0.00000000']]))
    expect(s.book.bidCount).toBe(0)
  })

  it('a book that crosses itself is wrong: resync', () => {
    const s = live()
    expect(s.onDiff(ev(101, 101, [['101', '1']]))).toBe('resync') // a bid at the best ask's price: the book has crossed (inside the covered range)
    expect(s.state).toBe('buffering')
  })

  it('rejects malformed events', () => {
    const s = live()
    for (const bad of [null, {}, { U: 'x', u: 1, bids: [], asks: [] }, { U: 5, u: 3, bids: [], asks: [] }, { U: 1, u: 2, bids: 'no', asks: [] }]) {
      const t = live()
      expect(t.onDiff(bad as unknown as DiffEvent)).toBe('resync')
    }
    expect(s.state).toBe('live')
  })

  it('keeps memory bounded', () => {
    const s = new SyncedBook({ maxLevels: 50 })
    s.onSnapshot(snap(0, [['1', '1']], [['1000', '1']])) // covers 1..1000
    const bids: [string, string][] = []
    for (let p = 2; p <= 500; p++) bids.push([String(p), '1'])
    s.onDiff(ev(1, 1, bids))
    expect(s.book.bidCount).toBe(50)
    expect(s.book.bestBid()).toBe(500)
  })
})

/** The book a consumer holds must equal the true book as of the update id it claims to be at. */
function expectMatchesTruth(s: SyncedBook, ex: SimulatedExchange, context: string) {
  const truth = ex.bookAt(s.lastUpdateId)
  const cov = s.coverage ?? { lo: -Infinity, hi: Infinity } // an empty snapshot has no range: everything is applied
  const inside = (l: [number, number]) => l[0] >= cov.lo && l[0] <= cov.hi
  const top = s.book.top(1000)
  expect(top.bids, `bids ${context}`).toEqual(levelsOf(truth.bids, true).filter(inside))
  expect(top.asks, `asks ${context}`).toEqual(levelsOf(truth.asks, false).filter(inside))
}

describe('SyncedBook against a simulated exchange', () => {
  it('always equals the truth once live, wherever it joins and whatever snapshot it gets', () => {
    for (let seed = 1; seed <= 150; seed++) {
      const ex = new SimulatedExchange(seed)
      ex.advance(250)
      const events = ex.stream(1, 4)
      const rand = mulberry32(seed * 7919)

      const join = Math.floor(rand() * (events.length - 30))
      const s = new SyncedBook()
      const heldUntil = join + 1 + Math.floor(rand() * 15) // how many events pile up before the snapshot answers
      let i = join
      for (; i < heldUntil; i++) expect(s.onDiff(events[i])).toBe('buffered')

      // the snapshot may be a little older or a little newer than what we hold; retry while it is stale
      const lowest = events[join].U - 2
      let snapId = Math.max(1, lowest + Math.floor(rand() * (events[heldUntil - 1].u + 6 - lowest)))
      let result = s.onSnapshot(ex.snapshotAt(Math.min(snapId, ex.lastId)))
      let guard = 0
      while (result === 'stale' && guard++ < 10) {
        snapId = events[heldUntil - 1].u // a newer one
        result = s.onSnapshot(ex.snapshotAt(snapId))
      }
      expect(result, `seed ${seed}`).toBe('live')
      expectMatchesTruth(s, ex, `seed ${seed} at join`)

      for (; i < events.length; i++) {
        const r = s.onDiff(events[i])
        expect(['applied', 'ignored'], `seed ${seed} event ${i}`).toContain(r)
        if (r === 'applied') expectMatchesTruth(s, ex, `seed ${seed} after event ${i}`)
      }
      expect(s.lastUpdateId).toBe(ex.lastId)
      expect(s.stats.resyncs).toBe(0)
    }
  })

  it('shrugs off duplicated deliveries', () => {
    for (let seed = 1; seed <= 60; seed++) {
      const ex = new SimulatedExchange(seed)
      ex.advance(200)
      const events = ex.stream(1, 3)
      const rand = mulberry32(seed)
      const s = new SyncedBook()
      s.onSnapshot(ex.snapshotAt(events[0].U - 1))
      for (let i = 0; i < events.length; i++) {
        s.onDiff(events[i])
        if (rand() < 0.3) s.onDiff(events[Math.floor(rand() * (i + 1))]) // replay some earlier event
        if (rand() < 0.3) s.onDiff(events[i]) // and the same one again
      }
      expectMatchesTruth(s, ex, `seed ${seed}`)
      expect(s.stats.resyncs).toBe(0)
    }
  })

  it('notices every dropped event, and recovers to the truth after a fresh snapshot', () => {
    let detected = 0
    for (let seed = 1; seed <= 120; seed++) {
      const ex = new SimulatedExchange(seed)
      ex.advance(300)
      const events = ex.stream(1, 3)
      const rand = mulberry32(seed + 1000)
      const s = new SyncedBook()
      s.onSnapshot(ex.snapshotAt(events[0].U - 1))

      const dropAt = 20 + Math.floor(rand() * (events.length - 60))
      let resynced = false
      for (let i = 0; i < events.length; i++) {
        if (i === dropAt) continue // the exchange sent it; we never received it
        const r = s.onDiff(events[i])
        if (r === 'resync') {
          expect(i, `seed ${seed}: the gap must be caught by the very next event`).toBe(dropAt + 1)
          resynced = true
          detected++
          expect(s.needsSnapshot).toBe(true)
          // the caller reacts: events keep arriving (buffered), then a snapshot as of "now"
          const upto = Math.min(events.length - 1, i + 5)
          let j = i
          for (; j <= upto; j++) s.onDiff(events[j])
          expect(s.onSnapshot(ex.snapshotAt(events[upto].u))).toBe('live')
          expectMatchesTruth(s, ex, `seed ${seed} after recovery`)
          for (j = upto + 1; j < events.length; j++) { s.onDiff(events[j]) }
          break
        }
      }
      expect(resynced, `seed ${seed}`).toBe(true)
      expectMatchesTruth(s, ex, `seed ${seed} at end`)
    }
    expect(detected).toBe(120)
  })

  it('never claims to be live with a wrong book: check after every single event, dropping some at random', () => {
    for (let seed = 1; seed <= 60; seed++) {
      const ex = new SimulatedExchange(seed)
      ex.advance(400)
      const events = ex.stream(1, 3)
      const rand = mulberry32(seed * 31)
      const s = new SyncedBook()
      s.onSnapshot(ex.snapshotAt(events[0].U - 1))
      let pendingSnapshot = false
      let lastFed = -1
      for (let i = 0; i < events.length; i++) {
        if (rand() < 0.04 && s.state === 'live') continue // lose a message
        const before = s.state
        const r = s.onDiff(events[i])
        lastFed = i
        if (r === 'resync') pendingSnapshot = true
        if (pendingSnapshot && rand() < 0.5) { // the snapshot answer arrives a little later
          const res = s.onSnapshot(ex.snapshotAt(events[lastFed].u))
          expect(['live', 'resync', 'stale']).toContain(res)
          if (res === 'live') pendingSnapshot = false
        }
        // The property: a live book that has caught up with an event matches the truth at that event's id.
        if (s.state === 'live' && r === 'applied') {
          const gapFree = events[i].u === s.lastUpdateId
          if (gapFree) {
            // a lost event since the last resync would have been caught above, so this must hold
            const truth = ex.bookAt(s.lastUpdateId)
            const cov = s.coverage ?? { lo: -Infinity, hi: Infinity }
            const inside = (l: [number, number]) => l[0] >= cov.lo && l[0] <= cov.hi
            expect(s.book.top(1000).bids).toEqual(levelsOf(truth.bids, true).filter(inside))
            expect(s.book.top(1000).asks).toEqual(levelsOf(truth.asks, false).filter(inside))
          }
        }
        void before
      }
    }
  })
})

describe('SyncedBook coverage', () => {
  it('is the price range of the snapshot: lowest bid to highest ask', () => {
    const s = new SyncedBook()
    expect(s.coverage).toBeNull()
    s.onSnapshot(snap(10, [['100', '1'], ['90', '1'], ['95', '1']], [['101', '1'], ['120', '1']]))
    expect(s.coverage).toEqual({ lo: 90, hi: 120 })
  })

  it('is not widened by levels that arrive in later updates', () => {
    const s = new SyncedBook()
    s.onSnapshot(snap(10, [['100', '1'], ['90', '1']], [['101', '1'], ['120', '1']]))
    s.onDiff(ev(11, 11, [['50', '3']], [['500', '3']])) // real levels, but far outside what the snapshot held
    expect(s.book.quantityAt('ask', 500)).toBe(0) // not applied: out there the book would be incomplete
    expect(s.book.quantityAt('bid', 50)).toBe(0)
    expect(s.coverage).toEqual({ lo: 90, hi: 120 })
  })

  it('is measured from the snapshot alone, even when held updates are applied on top of it', () => {
    const s = new SyncedBook()
    s.onDiff(ev(11, 11, [], [['900', '1']]))
    s.onSnapshot(snap(10, [['100', '1']], [['101', '1'], ['110', '1']]))
    expect(s.book.quantityAt('ask', 900)).toBe(0) // the held update is outside the snapshot's range, so it is not applied
    expect(s.coverage).toEqual({ lo: 100, hi: 110 })
  })

  it('is forgotten on a resync', () => {
    const s = new SyncedBook()
    s.onSnapshot(snap(10))
    s.onDiff(ev(50, 51)) // a gap
    expect(s.coverage).toBeNull()
  })
})
