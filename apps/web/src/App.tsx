import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Canvas, useThree } from '@react-three/fiber'
import { Grid, Html, OrbitControls } from '@react-three/drei'
import * as THREE from 'three'
import type { TimelineSample, Whale } from '@depth/core'
import { Terrain } from './Terrain'
import { Candles3D } from './Candles3D'
import { useCandles } from './useCandles'
import { apiBase } from './api'
import { useAlerts } from './useAlerts'
import { DEPTH, WIDTH, priceOfCol, xOfCol, zOfRow } from './terrainMath'
import { KEEP, SLICES, STEP_MS, useBookStream } from './useBookStream'

const DEFAULT_SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT']

const fmtPrice = (p: number, bucket: number) => p.toLocaleString('en-US', { minimumFractionDigits: Math.max(0, Math.min(6, -Math.floor(Math.log10(bucket)))), maximumFractionDigits: Math.max(0, Math.min(6, -Math.floor(Math.log10(bucket)))) })
const fmtUsd = (v: number) => (v >= 1e6 ? `$${(v / 1e6).toFixed(2)}M` : `$${Math.round(v / 1000)}k`)
const fmtQty = (q: number) => (q >= 1000 ? `${(q / 1000).toFixed(1)}k` : q >= 10 ? q.toFixed(1) : q.toFixed(2))
const base = (symbol: string) => symbol.replace(/USDT$/, '')

/** Price ticks along the front edge and time ticks along the left edge, placed in the scene. */
function Axes({ info }: { info: { bucket: number; k0: number; cols: number } | null }) {
  const times = useMemo(() => {
    const secondsPerRow = STEP_MS / 1000
    return [0, 30, 60, 90, 119].map((t) => ({ t, row: SLICES - 1 - Math.round(t / secondsPerRow) }))
  }, [])
  const timeLabel = (t: number) => (t === 0 ? 'now' : t < 60 ? `−${t}s` : t === 119 ? '−2m' : `−${Math.floor(t / 60)}m${t % 60 ? ` ${t % 60}s` : ''}`)
  return (
    <>
      {info && [0.08, 0.29, 0.5, 0.71, 0.92].map((f) => {
        const col = f * (info.cols - 1)
        return (
          <Html key={f} position={[xOfCol(col, info.cols), 0, DEPTH / 2 + 3]} center className="tick" zIndexRange={[5, 0]}>
            {fmtPrice(priceOfCol(col, info), info.bucket)}
          </Html>
        )
      })}
      {times.map(({ t, row }) => (
        <Html key={t} position={[-WIDTH / 2 - 4, 0, zOfRow(row, SLICES)]} center className="tick" zIndexRange={[5, 0]}>{timeLabel(t)}</Html>
      ))}
    </>
  )
}

/** On a narrow (portrait) window the terrain would be cut off at the sides, so start further back. */
function Framing({ view }: { view: View }) {
  const { camera, size } = useThree()
  useEffect(() => {
    const aspect = size.width / size.height
    const back = aspect < 1.2 ? Math.min(2.4, 1.2 / Math.max(aspect, 0.4)) : 1
    if (view === 'candles') camera.position.set(28 * back, 26 * back, 92 * back)
    else camera.position.set(0, 58 * back, 92 * back)
    camera.updateProjectionMatrix()
  }, [camera, size.width, size.height, view])
  return null
}

type View = 'terrain' | 'candles'
const INTERVALS = ['1m', '5m', '15m']

export function App() {
  const [view, setView] = useState<View>('terrain')
  const [interval, setIntervalKey] = useState('1m')
  const [symbols, setSymbols] = useState(DEFAULT_SYMBOLS)
  const [symbol, setSymbol] = useState(() => new URLSearchParams(location.search).get('symbol')?.toUpperCase() ?? 'BTCUSDT')
  const stream = useBookStream(symbol)
  const { candles, error: candleError } = useCandles(symbol, interval, view === 'candles')
  const [info, setInfo] = useState<{ bucket: number; k0: number; cols: number } | null>(null)
  const lastInfo = useRef(0)
  const [whales, setWhales] = useState<Whale[]>([])
  // Replay: null means live. Otherwise the time step the view ends at, which stays fixed while paused.
  const [cursor, setCursor] = useState<number | null>(null)
  const [playing, setPlaying] = useState(false)
  const [span, setSpan] = useState<{ oldest: number; newest: number } | null>(null)

  useEffect(() => {
    fetch(`${apiBase}/api/symbols`).then((r) => r.json()).then((d: { symbols: string[] }) => { if (d.symbols?.length) setSymbols(d.symbols) }).catch(() => {})
  }, [])

  // labels only need refreshing about once a second
  const onSample = useCallback((s: TimelineSample) => {
    const now = performance.now()
    if (now - lastInfo.current < 1000) return
    lastInfo.current = now
    setInfo({ bucket: s.bucket, k0: s.k0, cols: s.cols })
  }, [])
  // the span only changes when a step passes, which is about every half second
  useEffect(() => { const t = setInterval(() => setSpan(stream.timeline.range()), 500); return () => clearInterval(t) }, [stream.timeline])
  useEffect(() => { setCursor(null); setPlaying(false) }, [symbol])
  // playing forward at real speed; catching up with the present goes back to live
  useEffect(() => {
    if (!playing || cursor === null) return
    const t = setInterval(() => setCursor((c) => {
      const newest = stream.timeline.range()?.newest
      if (c === null || newest === undefined || c + 1 >= newest) { setPlaying(false); return null }
      return c + 1
    }), STEP_MS)
    return () => clearInterval(t)
  }, [playing, cursor === null, stream.timeline])
  const replaying = cursor !== null
  const oldest = span ? Math.max(span.oldest, span.newest - KEEP) + 10 : 0 // earliest point worth showing (older rows of the view stay unknown)
  const canRewind = !!span && span.newest - oldest >= 20
  const timeLabel = (bin: number) => new Date(bin * STEP_MS).toLocaleTimeString([], { hour12: false })
  const rewind = (bin: number) => { if (span) setCursor(Math.max(oldest, Math.min(bin, span.newest))) }

  useEffect(() => { setInfo(null); lastInfo.current = 0 }, [symbol])

  const f = stream.frame
  const live = stream.link === 'open' && f?.status === 'live'
  const state = live ? 'live' : stream.link !== 'open' ? 'offline' : 'syncing'
  const alerts = useAlerts(symbol, f?.mid ?? null, whales, live && !replaying, (_s, p) => fmtPrice(p, f?.bucket ?? 0.01))
  const [alertsOpen, setAlertsOpen] = useState(false)
  const [priceText, setPriceText] = useState('')
  const [alertError, setAlertError] = useState<string | null>(null)
  const whaleOn = alerts.rules.some((r) => r.kind === 'whale' && r.symbol === symbol)
  const mine = alerts.rules.filter((r) => r.symbol === symbol)
  const submitPrice = (e: React.FormEvent) => {
    e.preventDefault()
    const v = Number(priceText.replace(/,/g, ''))
    if (!Number.isFinite(v)) { setAlertError('Enter a price'); return }
    const err = alerts.addPrice(v)
    setAlertError(err)
    if (!err) setPriceText('')
  }
  const bidQty = f && live ? f.bids.reduce((a, b) => a + b, 0) : 0
  const askQty = f && live ? f.asks.reduce((a, b) => a + b, 0) : 0
  const share = bidQty + askQty > 0 ? bidQty / (bidQty + askQty) : 0.5
  const halfRange = f && f.mid ? ((f.bucket * f.bids.length) / 2 / f.mid) * 100 : null

  return (
    <div className="app">
      <Canvas
        camera={{ position: [0, 58, 92], fov: 40, near: 0.5, far: 600 }}
        dpr={[1, 2]}
        gl={{ antialias: true, powerPreference: 'high-performance' }}
        onCreated={({ scene }) => { scene.background = new THREE.Color('#070a11'); scene.fog = new THREE.Fog('#070a11', 90, 230) }}
      >
        <ambientLight intensity={0.85} />
        <directionalLight position={[30, 60, 40]} intensity={1.4} />
        <directionalLight position={[-40, 25, -30]} intensity={0.45} color="#7c97f2" />
        <Framing view={view} />
        <group visible={view === 'terrain'}>
          <Terrain stream={stream} onSample={onSample} onWhales={setWhales} showWhales={(live || replaying) && view === 'terrain'} endBin={cursor} />
        </group>
        {view === 'candles' && <Candles3D candles={candles} whales={live ? whales : []} mid={live ? f?.mid ?? null : null} format={(p) => fmtPrice(p, Math.max(p / 1e5, 0.01))} />}
        <Grid position={[0, -0.05, 0]} args={[WIDTH * 1.6, DEPTH * 1.6]} cellSize={5} cellThickness={0.5} cellColor="#1a2233" sectionSize={25} sectionThickness={1} sectionColor="#2a3550" fadeDistance={190} fadeStrength={1.5} infiniteGrid={false} />
        {view === 'terrain' && <Axes info={info} />}
        <OrbitControls enableDamping dampingFactor={0.07} target={view === 'candles' ? [0, 16, 0] : [0, 0, -4]} minDistance={22} maxDistance={190} maxPolarAngle={Math.PI * 0.485} />
      </Canvas>

      <header className="top panel">
        <div className="brand"><i />Depth</div>
        <nav className="symbols" aria-label="Market">
          {symbols.map((s) => (
            <button key={s} className={s === symbol ? 'on' : ''} aria-pressed={s === symbol} onClick={() => { setSymbol(s); history.replaceState(null, '', `?symbol=${s}`) }}>{base(s)}</button>
          ))}
        </nav>
        <div className="views" role="group" aria-label="View">
          <button className={view === 'terrain' ? 'on' : ''} aria-pressed={view === 'terrain'} onClick={() => setView('terrain')}>Order book</button>
          <button className={view === 'candles' ? 'on' : ''} aria-pressed={view === 'candles'} onClick={() => setView('candles')}>Candles</button>
          {view === 'candles' && INTERVALS.map((i) => <button key={i} className={`sub ${i === interval ? 'on' : ''}`} aria-pressed={i === interval} onClick={() => setIntervalKey(i)}>{i}</button>)}
        </div>
        {view === 'candles' && candleError && candles.length === 0 && <span className="muted">Candles unavailable</span>}
        <div className="alerts-wrap">
          <button className={`bell ${mine.length ? 'on' : ''}`} aria-expanded={alertsOpen} onClick={() => setAlertsOpen((o) => !o)}>Alerts{mine.length ? ` · ${mine.length}` : ''}</button>
          {alertsOpen && (
            <div className="alerts panel" role="dialog" aria-label="Alerts">
              <form onSubmit={submitPrice}>
                <label>Alert me when {base(symbol)} reaches
                  <span className="row"><input inputMode="decimal" placeholder={f?.mid ? fmtPrice(f.mid, f.bucket) : 'price'} value={priceText} onChange={(e) => setPriceText(e.target.value)} /><button type="submit">Add</button></span>
                </label>
                {alertError && <small className="err">{alertError}</small>}
              </form>
              <label className="check"><input type="checkbox" checked={whaleOn} onChange={() => alerts.toggleWhale(1_000_000)} /> New whale wall over $1M</label>
              <ul>
                {mine.map((r) => (
                  <li key={r.id}><span>{r.kind === 'price' ? `${r.dir === 'above' ? '≥' : '≤'} ${fmtPrice(r.price, f?.bucket ?? 0.01)}` : `Whale walls ≥ $${(r.minUsd / 1e6).toFixed(0)}M`}</span><button aria-label="Remove alert" onClick={() => alerts.remove(r.id)}>✕</button></li>
                ))}
              </ul>
              <small className="muted">Alerts live in this browser and fire only while this page is open.</small>
            </div>
          )}
        </div>
        <span className={`pill ${state}`} role="status"><i />{state === 'live' ? 'Live' : state === 'syncing' ? 'Syncing order book…' : stream.link === 'connecting' ? 'Connecting…' : 'Offline, reconnecting…'}</span>
      </header>

      <aside className="whales panel" aria-label="Large resting orders">
        <h2>Whale walls</h2>
        {live && whales.length > 0 ? (
          <ul>
            {whales.slice(0, 6).map((w) => (
              <li key={`${w.side}${w.col}`} className={w.side}>
                <i />
                <span className="mono">{fmtPrice(w.price, f!.bucket)}</span>
                <b className="mono">{fmtUsd(w.usd)}</b>
                <small>{w.age < 2 ? 'new' : `${Math.round((w.age * STEP_MS) / 1000)}s`}</small>
              </li>
            ))}
          </ul>
        ) : <p className="muted">{live ? 'No unusually large orders right now.' : '—'}</p>}
      </aside>

      <aside className="stats panel" aria-label="Market readout">
        <div className="pair mono">{base(symbol)} / USDT</div>
        <div className="mid">{f?.mid && live ? fmtPrice(f.mid, f.bucket) : '—'}</div>
        <dl>
          <div><dt>Spread</dt><dd>{f?.spread != null && f.mid && live ? `${f.spread < 1 ? f.spread.toFixed(4).replace(/0+$/, '').replace(/\.$/, '') : f.spread.toFixed(2)} (${((f.spread / f.mid) * 1e4).toFixed(2)} bp)` : '—'}</dd></div>
          <div><dt>Window</dt><dd>{halfRange && live ? `±${halfRange.toFixed(2)}% · ${fmtPrice(f!.bucket, f!.bucket)} per bar` : '—'}</dd></div>
          <div><dt>Data age</dt><dd>{stream.lagMs !== null && live ? `${Math.max(0, stream.lagMs)} ms` : '—'}</dd></div>
        </dl>
        <div className="balance" aria-label="Resting orders in view">
          <div className="bar"><span className="b" style={{ width: `${share * 100}%` }} /><span className="a" style={{ width: `${(1 - share) * 100}%` }} /></div>
          <div className="nums mono"><span className="g">{fmtQty(bidQty)} {base(symbol)} bids</span><span className="r">{fmtQty(askQty)} asks</span></div>
        </div>
      </aside>

      <div className={`replay panel ${replaying ? 'on' : ''}`} hidden={view !== 'terrain'}>
        <button onClick={() => { if (!replaying) { if (span) { rewind(span.newest - 20); setPlaying(false) } } else setPlaying((p) => !p) }} disabled={!canRewind && !replaying} aria-label={replaying ? (playing ? 'Pause' : 'Play') : 'Rewind'}>
          {replaying ? (playing ? '❚❚' : '▶') : '⏪'}
        </button>
        <input type="range" aria-label="Replay position" min={oldest} max={span?.newest ?? 0} step={1} disabled={!canRewind}
          value={cursor ?? span?.newest ?? 0}
          onChange={(e) => { const v = Number(e.target.value); if (span && v >= span.newest) { setCursor(null); setPlaying(false) } else { setPlaying(false); rewind(v) } }} />
        <span className="mono when">{replaying ? `${timeLabel(cursor!)}` : 'LIVE'}</span>
        {replaying && <button className="go" onClick={() => { setCursor(null); setPlaying(false) }}>Go live</button>}
      </div>

      <div className="toasts" aria-live="polite">
        {alerts.toasts.map((t) => (
          <div key={t.key} className="toast panel" role="status"><span>{t.message}</span><button aria-label="Dismiss" onClick={() => alerts.dismiss(t.key)}>✕</button></div>
        ))}
      </div>

      <footer className="legend panel">
        <span><i className="sw g" />Bids (buyers)</span>
        <span><i className="sw r" />Asks (sellers)</span>
        <span><i className="sw y" />Middle price</span>
        <span><i className="sw o" />Whale wall</span>
        <span className="muted">Height = size resting at that price · time flows away from you</span>
      </footer>
      <p className="hint">Drag to orbit · scroll to zoom · right-drag to pan</p>

      {state !== 'live' && !info && <div className="overlay" role="status">{stream.link === 'open' ? 'Building a correct order book from the exchange…' : 'Connecting to the server…'}</div>}
    </div>
  )
}
