import WebSocket from 'ws'
import { parseKlines } from '@depth/core'
import type { Candle, DiffEvent, Snapshot } from '@depth/core'

export interface Connection { close(): void }

export interface ConnectHandlers {
  onOpen(): void
  onDiff(e: DiffEvent): void
  onClose(reason: string): void
}

/** What the rest of the server needs from an exchange. Real (Binance) and simulated versions both fit. */
export interface Exchange {
  /** Open the live update stream for a market. */
  connect(symbol: string, handlers: ConnectHandlers): Connection
  /** The whole book as of "now", as one HTTP answer. */
  fetchSnapshot(symbol: string, limit: number): Promise<Snapshot>
  /** Recent trade candles (oldest first). */
  fetchCandles(symbol: string, interval: string, limit: number): Promise<Candle[]>
}

/** The exchange told us to slow down (HTTP 429) or that we were blocked (418). */
export class RateLimited extends Error {
  constructor(readonly retryAfterMs: number, readonly status: number) {
    super(`rate limited (HTTP ${status}), retry in ${retryAfterMs} ms`)
  }
}

export interface BinanceOptions {
  restUrl: string // https://api.binance.com
  wsUrl: string // wss://stream.binance.com:9443
  /** how long to wait for a snapshot before giving up on that attempt */
  timeoutMs?: number
}

interface RawDepthUpdate { e?: string; U?: number; u?: number; b?: [string, string][]; a?: [string, string][] }

/** Binance spot: `GET /api/v3/depth` for snapshots and the `<symbol>@depth@100ms` stream for updates. */
export class BinanceExchange implements Exchange {
  constructor(private readonly opts: BinanceOptions) {}

  connect(symbol: string, h: ConnectHandlers): Connection {
    const url = `${this.opts.wsUrl}/ws/${symbol.toLowerCase()}@depth@100ms`
    const ws = new WebSocket(url)
    let closed = false
    const finish = (reason: string) => { if (!closed) { closed = true; h.onClose(reason) } }
    ws.on('open', () => h.onOpen())
    ws.on('message', (data) => {
      let m: RawDepthUpdate
      try { m = JSON.parse(data.toString()) as RawDepthUpdate } catch { return }
      if (m.e !== 'depthUpdate') return // subscription acks and other chatter
      if (typeof m.U !== 'number' || typeof m.u !== 'number') return
      h.onDiff({ U: m.U, u: m.u, bids: m.b ?? [], asks: m.a ?? [] })
    })
    ws.on('close', (code) => finish(`closed (${code})`))
    ws.on('error', (err) => finish(`error: ${err.message}`))
    return { close: () => { try { ws.terminate() } catch { /* already gone */ } finish('closed by us') } }
  }

  async fetchSnapshot(symbol: string, limit: number): Promise<Snapshot> {
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), this.opts.timeoutMs ?? 10_000)
    try {
      const res = await fetch(`${this.opts.restUrl}/api/v3/depth?symbol=${encodeURIComponent(symbol)}&limit=${limit}`, { signal: ctl.signal })
      if (res.status === 429 || res.status === 418) {
        const secs = Number(res.headers.get('retry-after'))
        throw new RateLimited(Number.isFinite(secs) && secs > 0 ? secs * 1000 : 30_000, res.status)
      }
      if (!res.ok) throw new Error(`snapshot HTTP ${res.status}`)
      const d = (await res.json()) as Snapshot
      if (typeof d.lastUpdateId !== 'number' || !Array.isArray(d.bids) || !Array.isArray(d.asks)) throw new Error('unexpected snapshot shape')
      return { lastUpdateId: d.lastUpdateId, bids: d.bids, asks: d.asks }
    } finally { clearTimeout(timer) }
  }

  async fetchCandles(symbol: string, interval: string, limit: number): Promise<Candle[]> {
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), this.opts.timeoutMs ?? 10_000)
    try {
      const res = await fetch(`${this.opts.restUrl}/api/v3/klines?symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(interval)}&limit=${limit}`, { signal: ctl.signal })
      if (res.status === 429 || res.status === 418) throw new RateLimited(30_000, res.status)
      if (!res.ok) throw new Error(`klines HTTP ${res.status}`)
      return parseKlines(await res.json())
    } finally { clearTimeout(timer) }
  }
}
