import type { Candle } from '@depth/core'

export const C_WIDTH = 100
export const C_HEIGHT = 34

export interface CandleLayout {
  lo: number
  hi: number
  /** height above the ground for a price */
  y: (price: number) => number
  /** x position of candle i */
  x: (i: number) => number
  step: number
}

/** Price to height and time to x, with a little room above and below so nothing touches the edge. */
export function layoutCandles(candles: readonly Candle[], extra: readonly number[] = []): CandleLayout | null {
  if (candles.length === 0) return null
  let lo = Infinity
  let hi = -Infinity
  for (const c of candles) { lo = Math.min(lo, c.l); hi = Math.max(hi, c.h) }
  // levels a little way outside the candles are worth showing; ones far away would flatten the candles, so they are left out
  const range = hi - lo || hi * 0.001
  const [near0, near1] = [lo - range * 0.5, hi + range * 0.5]
  for (const p of extra) { if (p >= near0 && p <= near1) { lo = Math.min(lo, p); hi = Math.max(hi, p) } }
  const pad = (hi - lo || hi * 0.001) * 0.08
  lo -= pad
  hi += pad
  const n = candles.length
  const step = C_WIDTH / Math.max(n, 30)
  return { lo, hi, step, y: (p) => ((p - lo) / (hi - lo)) * C_HEIGHT, x: (i) => (i - (n - 1) / 2) * step }
}

/** Volume as thickness: the busiest candle is thickest, but a quiet one never disappears. */
export function thickness(volume: number, maxVolume: number) {
  return 0.6 + (maxVolume > 0 ? Math.sqrt(volume / maxVolume) : 0) * 5
}
