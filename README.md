# Depth

A live 3D view of a crypto order book. Real Binance data, kept provably correct, drawn as terrain you can orbit:
green ridges are bids (buyers), red ridges are asks (sellers), time runs toward you.

**Phase 1 of 5**: correct live book + 3D terrain. Next: whale orders, replay, 3D candles, alerts.

## Run it

```bash
npm install
npm run dev        # server :3100, web :5190
npm test           # 129 tests
```

## How it works

```
Binance WS (diffs) ─┐
                    ├─> SyncedBook ─> DepthFeed ─> Hub ─(WebSocket, ~10 Hz frames)─> Timeline ─> Three.js terrain
Binance REST (snap) ┘
```

- **Sync** follows Binance's documented procedure: buffer diffs, fetch a snapshot, drop stale events, require the first
  event to bridge the snapshot id, treat any gap or crossed book as a resync.
- **Coverage-honest**: a snapshot only vouches for the price range it contains. Outside it, data is *unknown*, not
  empty, so the server only shows a window inside coverage and refreshes the snapshot in the background before the
  price nears the edge. The client draws unknown cells flat in their own colour.
- **Rate-limit aware**: snapshots (weight 250) go through a global gate; 429/418 `Retry-After` is honoured.
- **Resilient server**: one feed per symbol, idle stop, watchdog, backoff with jitter, slow clients drop frames.

## Verification

- 129 unit/property/integration tests, including randomised joins, duplicates and dropped events against a simulator
  with a known-true book, and a fake exchange for the server.
- `npx tsx apps/server/scripts/verify-real.mts BTCUSDT` records the real stream, builds the book from two snapshots
  taken at different times, and checks both are identical. Passed for BTC, ETH and SOL.

## Deploy

- Server: Render blueprint in `render.yaml` (Frankfurt; Binance geo-blocks some regions). Set `ALLOWED_ORIGINS`.
- Web: Vercel, root directory `apps/web`, env `VITE_WS_URL=wss://<render-host>/stream`.
