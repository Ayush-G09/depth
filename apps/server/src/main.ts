import { SYMBOLS, loadConfig } from './config'
import { BinanceExchange } from './exchange'
import { RateGate } from './gate'
import { createDepthServer } from './server'

const cfg = loadConfig()
const server = createDepthServer(cfg, new BinanceExchange({ restUrl: cfg.restUrl, wsUrl: cfg.wsUrl }), new RateGate(cfg.snapshotGapMs))

server.listen(cfg.port).then((port) => {
  console.log(`depth server on http://localhost:${port}  (ws /stream?symbol=BTCUSDT, /health)`)
  console.log(`markets: ${Object.keys(SYMBOLS).join(', ')} · ${cfg.frameHz} frames/s · snapshot ${cfg.snapshotLimit} levels, one per ${cfg.snapshotGapMs / 1000}s`)
})

const shutdown = () => { void server.close().then(() => process.exit(0)) }
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
