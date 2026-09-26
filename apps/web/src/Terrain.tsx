import { useEffect, useMemo, useRef, useState } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { findWhales } from '@depth/core'
import type { TimelineSample, Whale } from '@depth/core'
import type { Stream } from './useBookStream'
import { SLICES } from './useBookStream'
import { ASK, BID, DEPTH, colOfPrice, fillTerrain, heightOf, referenceQty, xOfCol, zOfRow } from './terrainMath'

/** How the terrain reports what it is drawing, so the HTML labels can line up with it. */
export interface TerrainInfo { bucket: number; k0: number; cols: number; times: number[] }

/**
 * The order book as a landscape: price runs left to right, time runs away from you (now is at the front), and
 * height is how much is resting there: green mountains are bids (buyers), red are asks (sellers).
 */
const rgb = (c: readonly number[]) => `rgb(${c.map((x) => Math.round(x * 255)).join(',')})`

export function Terrain({ stream, onSample, onWhales, showWhales = true, endBin = null }: { endBin?: number | null; stream: Stream; onSample?: (s: TimelineSample) => void; onWhales?: (w: Whale[]) => void; showWhales?: boolean }) {
  const [whales, setWhales] = useState<{ w: Whale; x: number; y: number; z: number }[]>([])
  const lastWhale = useRef(0)
  const group = useRef<THREE.Group>(null)
  const seen = useRef(-1)
  const lastEnd = useRef<number | null>(null)
  const ref = useRef(1)
  const scroll = useRef(0)
  const lastRowTime = useRef(0)
  const cols = useRef(0)

  // The vertex grid depends on the number of columns, which we only learn from the first frame.
  const geometry = useMemo(() => new THREE.BufferGeometry(), [])
  const midGeometry = useMemo(() => {
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(SLICES * 3), 3))
    return g
  }, [])
  const midLine = useMemo(() => new THREE.Line(midGeometry, new THREE.LineBasicMaterial({ color: '#ffd166' })), [midGeometry])
  useEffect(() => () => { geometry.dispose(); midGeometry.dispose(); midLine.material.dispose() }, [geometry, midGeometry, midLine])

  const build = (s: TimelineSample) => {
    const { rows, cols: c } = s
    const positions = new Float32Array(rows * c * 3)
    for (let r = 0; r < rows; r++) for (let j = 0; j < c; j++) {
      const i = r * c + j
      positions[i * 3] = xOfCol(j, c)
      positions[i * 3 + 2] = zOfRow(r, rows)
    }
    const index: number[] = []
    for (let r = 0; r < rows - 1; r++) for (let j = 0; j < c - 1; j++) {
      const a = r * c + j
      const b = a + 1
      const d = a + c
      const e = d + 1
      index.push(a, d, b, b, d, e)
    }
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(rows * c * 3), 3))
    geometry.setIndex(index)
    cols.current = c
  }

  useFrame((_, delta) => {
    // ease the terrain toward the viewer's side between updates so time flows smoothly instead of in 500 ms steps
    if (endBin !== null) scroll.current = 0 // no easing while replaying
    scroll.current *= Math.pow(0.001, delta) // fast exponential decay
    if (group.current) group.current.position.z = scroll.current

    if (seen.current === stream.tick.current && lastEnd.current === endBin) return
    seen.current = stream.tick.current
    lastEnd.current = endBin
    const s = stream.timeline.sample(endBin ?? undefined)
    if (!s) return
    if (cols.current !== s.cols) build(s)

    // the whole picture moves back by one row when a new time step begins
    const newestTime = s.times[s.rows - 1]
    if (lastRowTime.current && newestTime > lastRowTime.current) scroll.current = DEPTH / (s.rows - 1)
    lastRowTime.current = newestTime

    const pos = geometry.getAttribute('position') as THREE.BufferAttribute
    const col = geometry.getAttribute('color') as THREE.BufferAttribute
    ref.current += (referenceQty(s) - ref.current) * (ref.current === 1 ? 1 : 0.06) // follow the scale gently so it does not pump
    fillTerrain(s, ref.current, pos.array as Float32Array, col.array as Float32Array)
    pos.needsUpdate = true
    col.needsUpdate = true
    geometry.computeBoundingSphere()

    // the path of the middle price, laid along the ground (starting where we first have data)
    const mp = midGeometry.getAttribute('position') as THREE.BufferAttribute
    let first = -1
    let prevX = 0
    for (let r = 0; r < s.rows; r++) {
      const m = s.mids[r]
      if (!Number.isNaN(m)) { prevX = xOfCol(colOfPrice(m, s), s.cols); if (first < 0) first = r }
      mp.setXYZ(r, prevX, 0.3, zOfRow(r, s.rows)) // a gap keeps the last known position rather than jumping
    }
    midGeometry.setDrawRange(first < 0 ? 0 : first, first < 0 ? 0 : s.rows - first)
    mp.needsUpdate = true
    onSample?.(s)

    const now = performance.now()
    if (now - lastWhale.current > 500) {
      lastWhale.current = now
      const found = findWhales(s)
      onWhales?.(found)
      setWhales(found.map((w) => ({ w, x: xOfCol(w.col, s.cols), y: heightOf(w.side === 'bid' ? s.bids[(s.rows - 1) * s.cols + w.col] : s.asks[(s.rows - 1) * s.cols + w.col], ref.current), z: zOfRow(s.rows - 1, s.rows) })))
    }
  })

  return (
    <group ref={group}>
      <mesh geometry={geometry}>
        <meshStandardMaterial vertexColors flatShading roughness={0.7} metalness={0.05} side={THREE.DoubleSide} />
      </mesh>
      <mesh geometry={geometry} position={[0, 0.02, 0]}>
        <meshBasicMaterial wireframe color="#7c97f2" transparent opacity={0.05} depthWrite={false} />
      </mesh>
      <primitive object={midLine} />
      {showWhales && whales.map(({ w, x, y, z }) => {
        const c = rgb(w.side === 'bid' ? BID : ASK)
        const r = 0.9 + Math.min(2.6, Math.max(0, Math.log10(w.usd / 250_000)) * 1.6) // bigger order, bigger sphere
        return (
          <group key={`${w.side}${w.col}`} position={[x, y + r + 1, z]}>
            <mesh>
              <sphereGeometry args={[r, 24, 16]} />
              <meshStandardMaterial color={c} emissive={c} emissiveIntensity={0.9} roughness={0.3} />
            </mesh>
            <mesh>
              <sphereGeometry args={[r * 1.7, 20, 12]} />
              <meshBasicMaterial color={c} transparent opacity={0.12} depthWrite={false} />
            </mesh>
          </group>
        )
      })}
    </group>
  )
}
