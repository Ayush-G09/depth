import { afterEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import type { BookFrame } from '@depth/core'
import type { ServerConfig } from '../src/config'
import { Hub } from '../src/hub'
import type { Client } from '../src/hub'
import { createDepthServer } from '../src/server'
import type { DepthServer } from '../src/server'
import { FakeExchange, noGate, sleep, waitFor } from './fake-exchange'

const CFG: ServerConfig = {
  port: 0, restUrl: '', wsUrl: '', frameHz: 50, bins: 50, snapshotLimit: 5000, snapshotGapMs: 0, idleMs: 120, maxClients: 3, allowedOrigins: [],
}
const TIMING = { reconnectMinMs: 15, snapshotRetryMinMs: 15, staleAfterMs: 5000 }

const running: DepthServer[] = []
const sockets: WebSocket[] = []
async function boot(cfg: Partial<ServerConfig> = {}, ex = new FakeExchange(1)) {
  const server = createDepthServer({ ...CFG, ...cfg }, ex, noGate, TIMING)
  const port = await server.listen(0)
  running.push(server)
  return { server, ex, port }
}
afterEach(async () => {
  sockets.splice(0).forEach((s) => s.terminate())
  await Promise.all(running.splice(0).map((s) => s.close()))
})

function watch(port: number, symbol = 'BTCUSDT', headers: Record<string, string> = {}) {
  const frames: BookFrame[] = []
  const ws = new WebSocket(`ws://localhost:${port}/stream?symbol=${symbol}`, { headers })
  sockets.push(ws)
  ws.on('message', (d) => frames.push(JSON.parse(d.toString()) as BookFrame))
  return { ws, frames }
}

/** The HTTP status a refused WebSocket upgrade got, or 101 if it was accepted. */
function upgradeStatus(port: number, path: string, headers: Record<string, string> = {}): Promise<number> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://localhost:${port}${path}`, { headers })
    sockets.push(ws)
    ws.on('open', () => resolve(101))
    ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0))
    ws.on('error', () => {})
  })
}

describe('depth server', () => {
  it('answers /health and lists the markets it will serve', async () => {
    const { port } = await boot()
    const health = (await (await fetch(`http://localhost:${port}/health`)).json()) as Record<string, unknown>
    expect(health).toMatchObject({ ok: true, clients: 0, markets: [] })
    const syms = (await (await fetch(`http://localhost:${port}/api/symbols`)).json()) as { symbols: string[] }
    expect(syms.symbols).toContain('BTCUSDT')
    expect((await fetch(`http://localhost:${port}/nope`)).status).toBe(404)
  })

  it('streams a first frame straight away, then live frames that equal the true book', async () => {
    const { port, ex } = await boot()
    const { frames } = watch(port)
    await waitFor(() => frames.length >= 1, 2000, 'a first frame')
    expect(['syncing', 'live']).toContain(frames[0].status)
    await waitFor(() => frames.some((f) => f.status === 'live'), 3000, 'a live frame')
    for (let i = 0; i < 10; i++) ex.publish(3)
    await sleep(100)
    const last = frames[frames.length - 1]
    expect(last.status).toBe('live')
    expect(last.symbol).toBe('BTCUSDT')
    expect(ex.frameMatchesTruth(last)).toBe(true)
    expect(last.bids).toHaveLength(100)
  })

  it('numbers frames in order, so a client can tell if it missed one', async () => {
    const { port, ex } = await boot()
    const { frames } = watch(port)
    await waitFor(() => frames.some((f) => f.status === 'live'), 3000, 'live')
    // most simulated changes fall outside the displayed price window and rightly produce no new frame, so send plenty
    for (let i = 0; i < 60; i++) { ex.publish(2); await sleep(25) }
    const live = frames.filter((f) => f.status === 'live')
    expect(live.length).toBeGreaterThan(5)
    for (let i = 1; i < live.length; i++) expect(live[i].seq).toBeGreaterThan(live[i - 1].seq)
    expect(new Set(frames.map((f) => f.seq)).size).toBeLessThanOrEqual(frames.length)
  })

  it('does not repeat identical frames, but keeps a heartbeat going', async () => {
    const { port } = await boot()
    const { frames } = watch(port)
    await waitFor(() => frames.some((f) => f.status === 'live'), 3000, 'live')
    const n = frames.length
    await sleep(500) // the exchange is silent: 25 ticks at 50 Hz would be 25 frames if we sent them all
    expect(frames.length - n).toBeLessThanOrEqual(2)
  })

  it('refuses unknown markets, wrong paths and (when configured) foreign origins, without opening a feed', async () => {
    const { port, ex } = await boot({ allowedOrigins: ['https://depth.example'] })
    expect(await upgradeStatus(port, '/stream?symbol=DOGEUSDT', { origin: 'https://depth.example' })).toBe(400)
    expect(await upgradeStatus(port, '/stream', { origin: 'https://depth.example' })).toBe(400)
    expect(await upgradeStatus(port, '/other?symbol=BTCUSDT', { origin: 'https://depth.example' })).toBe(404)
    expect(await upgradeStatus(port, '/stream?symbol=BTCUSDT', { origin: 'https://evil.example' })).toBe(403)
    expect(await upgradeStatus(port, '/stream?symbol=BTCUSDT')).toBe(403) // no origin at all
    expect(ex.connects).toBe(0)
    expect(await upgradeStatus(port, '/stream?symbol=BTCUSDT', { origin: 'https://depth.example' })).toBe(101)
  })

  it('accepts symbols in any letter case', async () => {
    const { port } = await boot()
    expect(await upgradeStatus(port, '/stream?symbol=btcusdt')).toBe(101)
  })

  it('caps how many people can watch at once', async () => {
    const { port } = await boot({ maxClients: 2 })
    watch(port); watch(port)
    await waitFor(() => running[0].hub.clientCount === 2, 2000, 'two viewers')
    expect(await upgradeStatus(port, '/stream?symbol=BTCUSDT')).toBe(503)
  })

  it('shares one exchange connection between everyone watching the same market', async () => {
    const { port, ex } = await boot()
    const a = watch(port)
    const b = watch(port)
    const c = watch(port)
    await waitFor(() => [a, b, c].every((w) => w.frames.some((f) => f.status === 'live')), 3000, 'all live')
    expect(ex.connects).toBe(1)
    expect(ex.snapshotCalls).toBe(1)
    expect(running[0].hub.stats().markets).toHaveLength(1)
  })

  it('closes the exchange connection a little while after the last viewer leaves, and reopens for the next', async () => {
    const { port, ex } = await boot()
    const a = watch(port)
    await waitFor(() => a.frames.some((f) => f.status === 'live'), 3000, 'live')
    a.ws.close()
    await waitFor(() => running[0].hub.stats().markets.length === 0, 2000, 'the feed to stop')
    expect(ex.closes).toBeGreaterThanOrEqual(1)
    const b = watch(port)
    await waitFor(() => b.frames.some((f) => f.status === 'live'), 3000, 'live again')
    expect(ex.connects).toBe(2)
  })

  it('a viewer who comes back before the idle timeout keeps the same feed', async () => {
    const { port, ex } = await boot({ idleMs: 400 })
    const a = watch(port)
    await waitFor(() => a.frames.some((f) => f.status === 'live'), 3000, 'live')
    a.ws.close()
    await sleep(100)
    const b = watch(port)
    await waitFor(() => b.frames.length > 0, 2000, 'a frame')
    await sleep(500)
    expect(ex.connects).toBe(1)
    expect(running[0].hub.stats().markets).toHaveLength(1)
  })

  it('different markets have separate feeds', async () => {
    const { port } = await boot()
    const btc = watch(port, 'BTCUSDT')
    const eth = watch(port, 'ETHUSDT')
    await waitFor(() => btc.frames.length > 0 && eth.frames.length > 0, 2000, 'frames')
    expect(btc.frames[0].symbol).toBe('BTCUSDT')
    expect(eth.frames[0].symbol).toBe('ETHUSDT')
    expect(running[0].hub.stats().markets.map((m) => m.symbol).sort()).toEqual(['BTCUSDT', 'ETHUSDT'])
  })

  it('a client that sends too much is disconnected', async () => {
    const { port } = await boot()
    const { ws } = watch(port)
    await waitFor(() => ws.readyState === WebSocket.OPEN, 2000, 'open')
    const closed = new Promise<number>((resolve) => ws.on('close', (code) => resolve(code)))
    ws.send('x'.repeat(5000))
    expect(await closed).toBe(1009)
  })
})

describe('Hub: slow viewers', () => {
  it('skips frames for a viewer whose connection is backed up, without holding everyone else back', async () => {
    const ex = new FakeExchange(2)
    const hub = new Hub(ex, noGate, CFG, TIMING)
    const fast: string[] = []
    const slow: string[] = []
    const fastClient: Client = { send: (d) => fast.push(d), bufferedAmount: () => 0 }
    const slowClient: Client = { send: (d) => slow.push(d), bufferedAmount: () => 5_000_000 }
    hub.subscribe('BTCUSDT', fastClient)
    hub.subscribe('BTCUSDT', slowClient)
    await waitFor(() => fast.length > 3, 3000, 'frames for the fast viewer')
    for (let i = 0; i < 10; i++) { ex.publish(2); await sleep(25) }
    expect(hub.droppedFrames).toBeGreaterThan(0)
    expect(slow.length).toBe(1) // only the greeting frame; nothing was queued behind the stuck connection
    expect(fast.length).toBeGreaterThan(slow.length)
    hub.close()
  })

  it('rejects markets it does not serve', () => {
    const hub = new Hub(new FakeExchange(3), noGate, CFG, TIMING)
    expect(() => hub.subscribe('NOPEUSDT', { send: () => {}, bufferedAmount: () => 0 })).toThrow(/unknown symbol/)
    expect(hub.isKnown('__proto__')).toBe(false)
    expect(hub.isKnown('constructor')).toBe(false)
    hub.close()
  })

  it('a client whose send throws does not break the others', async () => {
    const ex = new FakeExchange(4)
    const hub = new Hub(ex, noGate, CFG, TIMING)
    const ok: string[] = []
    let calls = 0
    hub.subscribe('BTCUSDT', { send: () => { if (calls++ > 0) throw new Error('socket is closing') }, bufferedAmount: () => 0 })
    hub.subscribe('BTCUSDT', { send: (d) => ok.push(d), bufferedAmount: () => 0 })
    await waitFor(() => ok.length > 2, 3000, 'frames for the healthy viewer')
    hub.close()
  })

  describe('candles endpoint', () => {
    const get = (port: number, path: string) => fetch(`http://localhost:${port}${path}`)
    it('returns candles for a known market, and shares one exchange call between viewers', async () => {
      const { port, ex } = await boot()
      const [a, b] = await Promise.all([get(port, '/api/candles?symbol=BTCUSDT&interval=1m'), get(port, '/api/candles?symbol=BTCUSDT&interval=1m')])
      expect(a.status).toBe(200)
      const body = (await b.json()) as { candles: unknown[] }
      expect(body.candles.length).toBe(3)
      expect(ex.candleCalls).toBe(1)
    })
    it('refuses unknown markets and intervals', async () => {
      const { port, ex } = await boot()
      expect((await get(port, '/api/candles?symbol=NOPE&interval=1m')).status).toBe(400)
      expect((await get(port, '/api/candles?symbol=BTCUSDT&interval=1s')).status).toBe(400)
      expect((await get(port, '/api/candles?symbol=BTCUSDT&interval=1m%26x')).status).toBe(400)
      expect(ex.candleCalls).toBe(0)
    })
    it('says 502 when the exchange is down, and does not remember the failure', async () => {
      const { port, ex } = await boot()
      ex.candlesFail = true
      expect((await get(port, '/api/candles?symbol=BTCUSDT&interval=1m')).status).toBe(502)
      ex.candlesFail = false
      expect((await get(port, '/api/candles?symbol=BTCUSDT&interval=1m')).status).toBe(200)
    })
  })
})
