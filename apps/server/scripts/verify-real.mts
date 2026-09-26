// Checks the order-book synchronisation against the REAL exchange, with no second source of truth needed.
//
//   npx tsx apps/server/scripts/verify-real.mts [SYMBOL] [seconds]
//
// It records the live update stream, and fetches TWO snapshots at different moments. It then builds the book twice,
// once from each snapshot plus the same recorded updates. Both builds describe the exchange at the same update id, so
// they must be identical. If the procedure mishandled overlaps, ordering or gaps, they would differ.
import WebSocket from 'ws'
import { SyncedBook, bucketIndex } from '@depth/core'
import type { DiffEvent, Snapshot } from '@depth/core'

const symbol = (process.argv[2] ?? 'BTCUSDT').toUpperCase()
const seconds = Number(process.argv[3] ?? 25)
const REST = process.env.BINANCE_REST ?? 'https://api.binance.com'
const WS = process.env.BINANCE_WS ?? 'wss://stream.binance.com:9443'
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function snapshot(): Promise<Snapshot> {
  const r = await fetch(`${REST}/api/v3/depth?symbol=${symbol}&limit=5000`)
  if (!r.ok) throw new Error(`snapshot HTTP ${r.status}`)
  return (await r.json()) as Snapshot
}

const events: DiffEvent[] = []
const ws = new WebSocket(`${WS}/ws/${symbol.toLowerCase()}@depth@100ms`)
await new Promise<void>((resolve, reject) => { ws.on('open', () => resolve()); ws.on('error', reject) })
ws.on('message', (d) => {
  const m = JSON.parse(d.toString())
  if (m.e === 'depthUpdate') events.push({ U: m.U, u: m.u, bids: m.b, asks: m.a })
})
console.log(`${symbol}: recording the live stream for ${seconds}s ...`)

await sleep(1500)
const s1 = await snapshot()
console.log(`  snapshot 1 taken: lastUpdateId ${s1.lastUpdateId} (${events.length} events buffered so far)`)
await sleep((seconds - 6) * 1000)
const s2 = await snapshot()
console.log(`  snapshot 2 taken: lastUpdateId ${s2.lastUpdateId} (${events.length} events buffered so far)`)
await sleep(3000)
ws.terminate()

// the same recorded stream, cut off at the same point, for both builds
const stream = events.slice()
const gaps = stream.slice(1).filter((e, i) => e.U !== stream[i].u + 1).length
console.log(`  recorded ${stream.length} updates covering ids ${stream[0].U}..${stream[stream.length - 1].u} (${gaps} gaps in the raw stream)`)

function build(s: Snapshot) {
  const sb = new SyncedBook()
  for (const e of stream) sb.onDiff(e)
  const result = sb.onSnapshot(s)
  return { sb, result }
}
const a = build(s1)
const b = build(s2)
console.log(`  build A (from snapshot 1): ${a.result}, at update id ${a.sb.lastUpdateId}, ${a.sb.book.bidCount}+${a.sb.book.askCount} levels`)
console.log(`  build B (from snapshot 2): ${b.result}, at update id ${b.sb.lastUpdateId}, ${b.sb.book.bidCount}+${b.sb.book.askCount} levels`)
if (a.result !== 'live' || b.result !== 'live') { console.log('FAIL: a build did not go live'); process.exit(1) }
if (a.sb.lastUpdateId !== b.sb.lastUpdateId) { console.log('FAIL: they ended at different update ids'); process.exit(1) }

// Compare only inside the price range BOTH snapshots covered: that is exactly what the server vouches for.
// (Outside a snapshot's range the book is incomplete: it only knows levels that happened to change.)
const mid = a.sb.book.mid()!
const lo = Math.max(a.sb.coverage!.lo, b.sb.coverage!.lo)
const hi = Math.min(a.sb.coverage!.hi, b.sb.coverage!.hi)
const reach = (hi - lo) / 2 / mid
console.log(`  snapshot 1 covered ${a.sb.coverage!.lo}..${a.sb.coverage!.hi}, snapshot 2 covered ${b.sb.coverage!.lo}..${b.sb.coverage!.hi}`)
const topA = a.sb.book.top(1e9)
const topB = b.sb.book.top(1e9)
const within = (ls: [number, number][]) => new Map(ls.filter(([p]) => p >= lo && p <= hi))
const diff = (x: Map<number, number>, y: Map<number, number>) => {
  const out: string[] = []
  for (const [p, q] of x) if (y.get(p) !== q) out.push(`${p}: ${q} vs ${y.get(p)}`)
  for (const [p] of y) if (!x.has(p)) out.push(`${p}: missing in the other`)
  return out
}
const bidDiff = diff(within(topA.bids), within(topB.bids))
const askDiff = diff(within(topA.asks), within(topB.asks))
const compared = within(topA.bids).size + within(topA.asks).size
console.log(`  compared ${compared} levels between ${lo} and ${hi}`)
console.log(`  A vs B differences: ${bidDiff.length} bid, ${askDiff.length} ask`)
for (const d of [...bidDiff, ...askDiff].slice(0, 8)) console.log(`    ${d}`)
console.log(`  crossed? A ${a.sb.book.isCrossed()}, B ${b.sb.book.isCrossed()}`)
void bucketIndex
const ok = bidDiff.length === 0 && askDiff.length === 0 && !a.sb.book.isCrossed()
console.log(ok ? 'PASS: two independent builds of the real book are identical' : 'FAIL')
process.exit(ok ? 0 : 1)
