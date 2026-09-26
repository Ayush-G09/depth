import type { TimelineSample } from '@depth/core'

/** World size of the terrain, in scene units. */
export const WIDTH = 100
export const DEPTH = 72
export const MAX_HEIGHT = 18

export const BID = [0.15, 0.82, 0.48] as const // green
export const ASK = [1.0, 0.3, 0.42] as const // red
const FLOOR = [0.05, 0.07, 0.11] as const
/** Where the book cannot vouch for the data (outside what the snapshot covered): flat, in a slightly different tone from a genuinely empty price. */
export const UNKNOWN = [0.11, 0.09, 0.16] as const

/** Scene x for a (fractional) column index. */
export const xOfCol = (col: number, cols: number) => (col / (cols - 1) - 0.5) * WIDTH
/** Scene z for a row: row 0 is the oldest (far back), the last row the newest (at the front). */
export const zOfRow = (row: number, rows: number) => (row / (rows - 1) - 0.5) * DEPTH

/** The column (fractional) a price sits at in this sample. Bucket j is centred on (k0 + j + 0.5) * bucket. */
export const colOfPrice = (price: number, s: Pick<TimelineSample, 'bucket' | 'k0'>) => price / s.bucket - s.k0 - 0.5
/** The price at a column. */
export const priceOfCol = (col: number, s: Pick<TimelineSample, 'bucket' | 'k0'>) => (s.k0 + col + 0.5) * s.bucket

/**
 * How big a "typical wall" is right now: a high percentile of the non-empty buckets. Heights are drawn relative to it,
 * so the picture stays readable whether the book is thin or thick. Sampled (not sorted in full) to stay cheap.
 */
export function referenceQty(s: TimelineSample): number {
  const values: number[] = []
  const stride = Math.max(1, Math.floor((s.rows * s.cols) / 4000))
  for (let i = 0; i < s.bids.length; i += stride) {
    const q = Math.max(s.bids[i], s.asks[i])
    if (q > 0) values.push(q)
  }
  if (!values.length) return 1
  values.sort((a, b) => a - b)
  return Math.max(values[Math.min(values.length - 1, Math.floor(values.length * 0.96))], 1e-9)
}

/**
 * Height for a quantity, on a log-like curve: a wall ten times the typical size is only a little taller than a typical
 * one, so thin buckets stay visible and one giant order cannot flatten the rest. (1 = a typical wall.)
 */
export const HEIGHT_CURVE = 24
export const heightOf = (qty: number, ref: number) => (qty <= 0 ? 0 : MAX_HEIGHT * Math.min(1.2, Math.log1p((HEIGHT_CURVE * qty) / ref) / Math.log1p(HEIGHT_CURVE)))

/**
 * Blur a row a little across price ([1 4 6 4 1] / 16). This is only for the picture: real books are jagged from one
 * price bucket to the next, and drawing that raw makes a wall of spikes. Everything the readouts show uses the raw data.
 */
export function smoothRow(src: Float32Array, dst: Float32Array, offset: number, cols: number) {
  const at = (i: number) => src[offset + Math.min(cols - 1, Math.max(0, i))]
  for (let c = 0; c < cols; c++) {
    dst[c] = (at(c - 2) + 4 * at(c - 1) + 6 * at(c) + 4 * at(c + 1) + at(c + 2)) / 16
  }
}

/** Fill positions' y and the colour buffer from a sample. `positions` has x, y, z per vertex; only y is touched. */
export function fillTerrain(s: TimelineSample, ref: number, positions: Float32Array, colors: Float32Array) {
  const { rows, cols } = s
  const sb = new Float32Array(cols)
  const sa = new Float32Array(cols)
  for (let r = 0; r < rows; r++) {
    // older rows fade toward the floor colour so the far end melts into the background
    const age = 1 - r / (rows - 1)
    const fade = 1 - 0.55 * age
    smoothRow(s.bids, sb, r * cols, cols)
    smoothRow(s.asks, sa, r * cols, cols)
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c
      if (!s.known[i]) {
        positions[i * 3 + 1] = 0
        colors[i * 3] = UNKNOWN[0] * fade
        colors[i * 3 + 1] = UNKNOWN[1] * fade
        colors[i * 3 + 2] = UNKNOWN[2] * fade
        continue
      }
      const b = sb[c]
      const a = sa[c]
      const isBid = b >= a
      const q = isBid ? b : a
      const h = heightOf(q, ref)
      positions[i * 3 + 1] = h
      const base = isBid ? BID : ASK
      const glow = q > 0 ? 0.32 + 0.68 * Math.min(1, h / MAX_HEIGHT) : 0
      colors[i * 3] = (FLOOR[0] + (base[0] - FLOOR[0]) * glow) * fade
      colors[i * 3 + 1] = (FLOOR[1] + (base[1] - FLOOR[1]) * glow) * fade
      colors[i * 3 + 2] = (FLOOR[2] + (base[2] - FLOOR[2]) * glow) * fade
    }
  }
}
