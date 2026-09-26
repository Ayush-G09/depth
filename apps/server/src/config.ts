export interface SymbolConfig {
  /** Price window to show, in percent of the price each side (shrunk automatically to what the snapshot covers). */
  rangePct: number
}

/** Only these markets can be requested, so nobody can make the server open arbitrary upstream connections. */
export const SYMBOLS: Record<string, SymbolConfig> = {
  BTCUSDT: { rangePct: 0.6 },
  ETHUSDT: { rangePct: 1.0 },
  SOLUSDT: { rangePct: 2.0 },
  BNBUSDT: { rangePct: 1.0 },
  XRPUSDT: { rangePct: 1.5 },
}

export interface ServerConfig {
  port: number
  restUrl: string
  wsUrl: string
  /** browser frames per second */
  frameHz: number
  bins: number
  snapshotLimit: number
  /** minimum gap between snapshot requests across all markets */
  snapshotGapMs: number
  /** stop a market's feed this long after its last viewer leaves */
  idleMs: number
  maxClients: number
  allowedOrigins: string[]
}

export function loadConfig(env = process.env): ServerConfig {
  const n = (v: string | undefined, d: number) => (v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : d)
  return {
    port: n(env.PORT, 3100),
    restUrl: env.BINANCE_REST ?? 'https://api.binance.com',
    wsUrl: env.BINANCE_WS ?? 'wss://stream.binance.com:9443',
    frameHz: n(env.FRAME_HZ, 10),
    bins: n(env.BINS, 100),
    snapshotLimit: n(env.SNAPSHOT_LIMIT, 5000),
    snapshotGapMs: n(env.SNAPSHOT_GAP_MS, 4000),
    idleMs: n(env.IDLE_MS, 30_000),
    maxClients: n(env.MAX_CLIENTS, 200),
    allowedOrigins: (env.ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
  }
}
