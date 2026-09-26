import type { BookFrame } from '@depth/core'
import { SYMBOLS } from './config'
import type { ServerConfig } from './config'
import type { Exchange } from './exchange'
import { DepthFeed } from './feed'
import type { FeedOptions, SnapshotGate } from './feed'

/** A connected browser, as the hub sees it. */
export interface Client {
  send(data: string): void
  /** bytes queued to send but not yet on the wire; a slow browser must not make the server buffer forever */
  bufferedAmount(): number
}

const MAX_BUFFERED = 1_000_000

interface Room {
  feed: DepthFeed
  clients: Set<Client>
  seq: number
  timer: ReturnType<typeof setInterval>
  idleTimer?: ReturnType<typeof setTimeout>
  lastKey: string
  lastSentAt: number
}

/**
 * One feed per market, started when the first person opens it and stopped a while after the last one leaves.
 * Every feed is sampled ~10 times a second and the same frame goes to everyone watching that market.
 */
export class Hub {
  private readonly rooms = new Map<string, Room>()
  droppedFrames = 0

  constructor(
    private readonly exchange: Exchange,
    private readonly gate: SnapshotGate,
    private readonly cfg: Pick<ServerConfig, 'frameHz' | 'bins' | 'snapshotLimit' | 'idleMs'>,
    private readonly feedTiming: Partial<FeedOptions> = {},
  ) {}

  isKnown(symbol: string) { return Object.prototype.hasOwnProperty.call(SYMBOLS, symbol) }

  get clientCount() {
    let n = 0
    for (const r of this.rooms.values()) n += r.clients.size
    return n
  }

  subscribe(symbol: string, client: Client): () => void {
    if (!this.isKnown(symbol)) throw new Error(`unknown symbol ${symbol}`)
    const room = this.rooms.get(symbol) ?? this.startRoom(symbol)
    clearTimeout(room.idleTimer)
    room.idleTimer = undefined
    room.clients.add(client)
    client.send(JSON.stringify(room.feed.frame(room.seq))) // show something straight away (a 'syncing' frame if not ready)
    return () => this.unsubscribe(symbol, client)
  }

  private unsubscribe(symbol: string, client: Client) {
    const room = this.rooms.get(symbol)
    if (!room) return
    room.clients.delete(client)
    if (room.clients.size === 0 && !room.idleTimer) {
      room.idleTimer = setTimeout(() => this.stopRoom(symbol), this.cfg.idleMs)
      room.idleTimer.unref?.()
    }
  }

  private startRoom(symbol: string): Room {
    const feed = new DepthFeed(symbol, this.exchange, this.gate, {
      rangePct: SYMBOLS[symbol].rangePct, bins: this.cfg.bins, snapshotLimit: this.cfg.snapshotLimit, ...this.feedTiming,
    })
    const room: Room = { feed, clients: new Set(), seq: 0, timer: undefined as never, lastKey: '', lastSentAt: 0 }
    room.timer = setInterval(() => this.tick(room), 1000 / this.cfg.frameHz)
    this.rooms.set(symbol, room)
    feed.start()
    return room
  }

  private stopRoom(symbol: string) {
    const room = this.rooms.get(symbol)
    if (!room || room.clients.size > 0) return
    clearInterval(room.timer)
    room.feed.stop()
    this.rooms.delete(symbol)
  }

  private tick(room: Room) {
    if (!room.clients.size) return
    const frame: BookFrame = room.feed.frame(room.seq + 1)
    // skip frames that would tell everyone nothing new, but still send one about once a second so clients know we are alive
    const key = `${frame.status}|${frame.mid}|${frame.bids.join(',')}|${frame.asks.join(',')}`
    const now = Date.now()
    if (key === room.lastKey && now - room.lastSentAt < 1000) return
    room.lastKey = key
    room.lastSentAt = now
    room.seq++
    const json = JSON.stringify(frame)
    for (const c of room.clients) {
      if (c.bufferedAmount() > MAX_BUFFERED) { this.droppedFrames++; continue } // a slow browser skips frames instead of piling up memory
      try { c.send(json) } catch { /* the socket layer will clean it up */ }
    }
  }

  stats() {
    return {
      clients: this.clientCount,
      droppedFrames: this.droppedFrames,
      markets: [...this.rooms.entries()].map(([symbol, r]) => ({
        symbol, status: r.feed.status, viewers: r.clients.size, frames: r.seq, updatesPerSecond: r.feed.updatesPerSecond,
        mid: r.feed.book.mid(), levels: { bids: r.feed.book.bidCount, asks: r.feed.book.askCount },
        ...r.feed.stats, sync: r.feed.syncStats,
      })),
    }
  }

  close() {
    for (const [symbol, room] of [...this.rooms]) { clearTimeout(room.idleTimer); room.clients.clear(); this.stopRoom(symbol) }
  }
}
