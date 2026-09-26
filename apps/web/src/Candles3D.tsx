import { useMemo } from 'react'
import { Html } from '@react-three/drei'
import type { Candle, Whale } from '@depth/core'
import { C_HEIGHT, C_WIDTH, layoutCandles, thickness } from './candleMath'
import { ASK, BID } from './terrainMath'

const rgb = (c: readonly number[]) => `rgb(${c.map((x) => Math.round(x * 255)).join(',')})`
const GREEN = rgb(BID)
const RED = rgb(ASK)

/**
 * Trade candles standing in 3D: time left to right, price up, and the thickness of each candle is how much traded.
 * The live middle price and the whale walls from the order book are drawn across them as levels, so you can see
 * whether price is heading toward a big wall.
 */
export function Candles3D({ candles, whales, mid, format }: { candles: Candle[]; whales: Whale[]; mid: number | null; format: (p: number) => string }) {
  const layout = useMemo(() => layoutCandles(candles, [...whales.map((w) => w.price), ...(mid ? [mid] : [])]), [candles, whales, mid])
  const maxV = useMemo(() => candles.reduce((m, c) => Math.max(m, c.v), 0), [candles])
  if (!layout) return null
  const { y, x, step } = layout
  const ticks = Array.from({ length: 5 }, (_, i) => layout.lo + ((layout.hi - layout.lo) * i) / 4)
  const inside = (p: number) => p >= layout.lo && p <= layout.hi

  return (
    <group position={[0, 0, 0]}>
      {candles.map((c, i) => {
        const up = c.c >= c.o
        const color = up ? GREEN : RED
        const top = y(Math.max(c.o, c.c))
        const bottom = y(Math.min(c.o, c.c))
        const d = thickness(c.v, maxV)
        return (
          <group key={c.t} position={[x(i), 0, 0]}>
            <mesh position={[0, (top + bottom) / 2, 0]}>
              <boxGeometry args={[step * 0.7, Math.max(0.12, top - bottom), d]} />
              <meshStandardMaterial color={color} roughness={0.45} emissive={color} emissiveIntensity={0.18} />
            </mesh>
            <mesh position={[0, (y(c.h) + y(c.l)) / 2, 0]}>
              <boxGeometry args={[0.12, Math.max(0.12, y(c.h) - y(c.l)), 0.12]} />
              <meshStandardMaterial color={color} />
            </mesh>
          </group>
        )
      })}

      {whales.filter((w) => inside(w.price)).map((w) => {
        const col = w.side === 'bid' ? GREEN : RED
        return (
          <mesh key={`${w.side}${w.price}`} position={[0, y(w.price), 0]}>
            <boxGeometry args={[C_WIDTH * 1.05, 0.08, 3]} />
            <meshBasicMaterial color={col} transparent opacity={0.4} depthWrite={false} />
          </mesh>
        )
      })}

      {mid !== null && inside(mid) && (
        <mesh position={[0, y(mid), 0]}>
          <boxGeometry args={[C_WIDTH * 1.05, 0.1, 0.1]} />
          <meshBasicMaterial color="#ffd166" />
        </mesh>
      )}

      {ticks.map((p) => (
        <group key={p} position={[C_WIDTH / 2 + 6, y(p), 0]}>
          <Html center distanceFactor={105} style={{ pointerEvents: 'none' }}>
            <span className="axis mono">{format(p)}</span>
          </Html>
        </group>
      ))}
      <mesh position={[0, -0.05, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[C_WIDTH * 1.1, 22]} />
        <meshBasicMaterial color="#0d1424" />
      </mesh>
      <mesh position={[0, C_HEIGHT / 2, -6]}>
        <planeGeometry args={[C_WIDTH * 1.1, C_HEIGHT * 1.1]} />
        <meshBasicMaterial color="#0a0f1b" transparent opacity={0.6} />
      </mesh>
    </group>
  )
}
