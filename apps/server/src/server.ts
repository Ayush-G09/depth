import { createServer } from 'node:http'
import type { IncomingMessage, Server } from 'node:http'
import { WebSocketServer } from 'ws'
import type { WebSocket } from 'ws'
import { SYMBOLS } from './config'
import type { ServerConfig } from './config'
import type { Exchange } from './exchange'
import type { FeedOptions, SnapshotGate } from './feed'
import { Hub } from './hub'

export interface DepthServer {
  http: Server
  hub: Hub
  listen(port: number): Promise<number>
  close(): Promise<void>
}

/** The HTTP + WebSocket front door. Everything about the exchange is injected, so tests can use a simulated one. */
export function createDepthServer(cfg: ServerConfig, exchange: Exchange, gate: SnapshotGate, feedTiming: Partial<FeedOptions> = {}): DepthServer {
  const hub = new Hub(exchange, gate, cfg, feedTiming)

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
