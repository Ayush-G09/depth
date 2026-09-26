import { useEffect, useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import type { TimelineSample } from '@depth/core'
import type { Stream } from './useBookStream'
import { SLICES } from './useBookStream'
import { DEPTH, WIDTH, colOfPrice, fillTerrain, referenceQty, xOfCol, zOfRow } from './terrainMath'

/** How the terrain reports what it is drawing, so the HTML labels can line up with it. */
export interface TerrainInfo { bucket: number; k0: number; cols: number; times: number[] }

/**
 * The order book as a landscape: price runs left to right, time runs away from you (now is at the front), and
 * height is how much is resting there: green mountains are bids (buyers), red are asks (sellers).
 */
export function Terrain({ stream, onSample }: { stream: Stream; onSample?: (s: TimelineSample) => void }) {
  const group = useRef<THREE.Group>(null)
  const seen = useRef(-1)
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
    scroll.current *= Math.pow(0.001, delta) // fast exponential decay
    if (group.current) group.current.position.z = scroll.current

    if (seen.current === stream.tick.current) return
    seen.current = stream.tick.current
    const s = stream.timeline.sample()
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
    </group>
  )
}
