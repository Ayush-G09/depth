import { createServer } from 'node:http'
import type { IncomingMessage, Server } from 'node:http'
import { WebSocketServer } from 'ws'
import type { WebSocket } from 'ws'
import { SYMBOLS } from './config'
import type { ServerConfig } from './config'
import type { Exchange } from './exchange'
import type { FeedOptions, SnapshotGate } from './feed'
import { Hub } from './hub'
import type { Candle } from '@depth/core'

const INTERVALS = ['1m', '5m', '15m', '1h']
const CANDLE_CACHE_MS = 10_000

export interface DepthServer {
  http: Server
  hub: Hub
  listen(port: number): Promise<number>
  close(): Promise<void>
}

/** The HTTP + WebSocket front door. Everything about the exchange is injected, so tests can use a simulated one. */
export function createDepthServer(cfg: ServerConfig, exchange: Exchange, gate: SnapshotGate, feedTiming: Partial<FeedOptions> = {}): DepthServer {
  const hub = new Hub(exchange, gate, cfg, feedTiming)

  // Candles are shared by everyone looking at a market, so ask the exchange at most once per few seconds for each.
  const cache = new Map<string, { at: number; data: Promise<Candle[]> }>()
  const candlesFor = (symbol: string, interval: string) => {
    const key = `${symbol}:${interval}`
    const hit = cache.get(key)
    if (hit && Date.now() - hit.at < CANDLE_CACHE_MS) return hit.data
    const data = exchange.fetchCandles(symbol, interval, 120)
    cache.set(key, { at: Date.now(), data })
    data.catch(() => { if (cache.get(key)?.data === data) cache.delete(key) }) // do not remember a failure
    return data
  }

  const http = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    res.setHeader('access-control-allow-origin', '*')
    if (url.pathname === '/health') {
      res.setHeader('content-type', 'application/json')
      return res.end(JSON.stringify({ ok: true, ...hub.stats() }))
    }
    if (url.pathname === '/api/symbols') {
      res.setHeader('content-type', 'application/json')
      return res.end(JSON.stringify({ symbols: Object.keys(SYMBOLS) }))
    }
    if (url.pathname === '/api/candles') {
      const symbol = (url.searchParams.get('symbol') ?? '').toUpperCase()
      const interval = url.searchParams.get('interval') ?? '1m'
      res.setHeader('content-type', 'application/json')
      if (!hub.isKnown(symbol) || !INTERVALS.includes(interval)) { res.statusCode = 400; return res.end('{"error":"bad request"}') }
      candlesFor(symbol, interval).then(
        (candles) => res.end(JSON.stringify({ symbol, interval, candles })),
        () => { res.statusCode = 502; res.end('{"error":"exchange unavailable"}') },
      )
      return
    }
    res.statusCode = 404
    res.end('not found')
  })

  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 })

  http.on('upgrade', (req: IncomingMessage, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const symbol = (url.searchParams.get('symbol') ?? '').toUpperCase()
    const origin = req.headers.origin
    const reject = (code: number, why: string) => { socket.write(`HTTP/1.1 ${code} ${why}\r\nConnection: close\r\n\r\n`); socket.destroy() }

    if (url.pathname !== '/stream') return reject(404, 'Not Found')
    if (cfg.allowedOrigins.length && (!origin || !cfg.allowedOrigins.includes(origin))) return reject(403, 'Forbidden')
    if (!hub.isKnown(symbol)) return reject(400, 'Bad Request')
    if (hub.clientCount >= cfg.maxClients) return reject(503, 'Service Unavailable')

    wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
      const off = hub.subscribe(symbol, { send: (d) => ws.send(d), bufferedAmount: () => ws.bufferedAmount })
      ws.on('close', off)
      ws.on('error', off)
      ws.on('message', () => { /* browsers only listen */ })
    })
  })

  return {
    http,
    hub,
    listen: (port) => new Promise((resolve) => http.listen(port, () => resolve((http.address() as { port: number }).port))),
    close: () => new Promise((resolve) => {
      hub.close()
      for (const c of wss.clients) c.terminate()
      http.close(() => resolve())
      http.closeAllConnections?.()
    }),
  }
}
