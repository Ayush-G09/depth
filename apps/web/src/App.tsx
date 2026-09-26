import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Canvas, useThree } from '@react-three/fiber'
import { Grid, Html, OrbitControls } from '@react-three/drei'
import * as THREE from 'three'
import type { TimelineSample, Whale } from '@depth/core'
import { Terrain } from './Terrain'
import { DEPTH, WIDTH, priceOfCol, xOfCol, zOfRow } from './terrainMath'
import { SLICES, STEP_MS, useBookStream } from './useBookStream'

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
function Framing() {
  const { camera, size } = useThree()
  useEffect(() => {
    const aspect = size.width / size.height
    const back = aspect < 1.2 ? Math.min(2.4, 1.2 / Math.max(aspect, 0.4)) : 1
    camera.position.set(0, 58 * back, 92 * back)
    camera.updateProjectionMatrix()
  }, [camera, size.width, size.height])
  return null
}

export function App() {
  const [symbols, setSymbols] = useState(DEFAULT_SYMBOLS)
  const [symbol, setSymbol] = useState(() => new URLSearchParams(location.search).get('symbol')?.toUpperCase() ?? 'BTCUSDT')
  const stream = useBookStream(symbol)
  const [info, setInfo] = useState<{ bucket: number; k0: number; cols: number } | null>(null)
  const lastInfo = useRef(0)
  const [whales, setWhales] = useState<Whale[]>([])

  useEffect(() => {
    fetch('/api/symbols').then((r) => r.json()).then((d: { symbols: string[] }) => { if (d.symbols?.length) setSymbols(d.symbols) }).catch(() => {})
  }, [])

  // labels only need refreshing about once a second
  const onSample = useCallback((s: TimelineSample) => {
    const now = performance.now()
    if (now - lastInfo.current < 1000) return
    lastInfo.current = now
    setInfo({ bucket: s.bucket, k0: s.k0, cols: s.cols })
  }, [])
  useEffect(() => { setInfo(null); lastInfo.current = 0 }, [symbol])

  const f = stream.frame
  const live = stream.link === 'open' && f?.status === 'live'
  const state = live ? 'live' : stream.link !== 'open' ? 'offline' : 'syncing'
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
        <Framing />
        <Terrain stream={stream} onSample={onSample} onWhales={setWhales} showWhales={live} />
        <Grid position={[0, -0.05, 0]} args={[WIDTH * 1.6, DEPTH * 1.6]} cellSize={5} cellThickness={0.5} cellColor="#1a2233" sectionSize={25} sectionThickness={1} sectionColor="#2a3550" fadeDistance={190} fadeStrength={1.5} infiniteGrid={false} />
        <Axes info={info} />
        <OrbitControls enableDamping dampingFactor={0.07} target={[0, 0, -4]} minDistance={22} maxDistance={190} maxPolarAngle={Math.PI * 0.485} />
      </Canvas>

      <header className="top panel">
        <div className="brand"><i />Depth</div>
        <nav className="symbols" aria-label="Market">
          {symbols.map((s) => (
            <button key={s} className={s === symbol ? 'on' : ''} aria-pressed={s === symbol} onClick={() => { setSymbol(s); history.replaceState(null, '', `?symbol=${s}`) }}>{base(s)}</button>
          ))}
        </nav>
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
