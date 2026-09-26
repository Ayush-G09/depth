import type { BookFrame } from './types'

export interface TimelineOptions {
  /** Rows kept (time steps). */
  slices: number
  /** Time steps remembered for replay (default: just `slices`). */
  keep?: number
  /** Milliseconds of history each row covers. */
  intervalMs: number
}

export interface TimelineSample {
  bucket: number
  /** price-bucket index of column 0 (the newest frame's window) */
  k0: number
  cols: number
  rows: number
  /** rows x cols, row 0 = oldest, last row = newest; index = row * cols + col */
  bids: Float32Array
  asks: Float32Array
  /**
   * rows x cols: 1 where we genuinely know the quantity (the frame vouched for that price range), 0 where we do not:
   * outside the book's coverage, outside an older frame's window, or during a gap. Unknown is not the same as empty.
   */
  known: Uint8Array
  /** per row: the middle price, or NaN if we had no live data for that step */
  mids: number[]
  /** per row: the start of the step, in ms since the epoch */
  times: number[]
}

/**
 * The last few minutes of the book as a grid: time along one axis, price along the other.
 *
 * Frames arrive ~10 times a second; each row keeps the latest frame of its time step, so the newest row keeps
 * updating live. Prices are lined up by absolute bucket index, so a wall of orders stays at the same column while the
 * market drifts under it. Time steps with no live data (a reconnect, a resync) stay empty rather than being invented.
 */
export class Timeline {
  private readonly bins = new Map<number, BookFrame>()
  private newest = -Infinity
  private cols = 0
  private bucket = 0

  constructor(readonly opts: TimelineOptions) {}

  get size() { return this.bins.size }
  get currentBucket() { return this.bucket }
  private get keep() { return Math.max(this.opts.keep ?? 0, this.opts.slices) }

  /** The oldest and newest time steps (as step numbers) that can be replayed, or null if there is nothing yet. */
  range(): { oldest: number; newest: number } | null {
    if (this.newest === -Infinity) return null
    let oldest = this.newest
    for (const k of this.bins.keys()) if (k < oldest) oldest = k
    return { oldest, newest: this.newest }
  }

  reset() {
    this.bins.clear()
    this.newest = -Infinity
    this.cols = 0
    this.bucket = 0
  }

  /** Returns true if the frame was used. Frames that are not live, or malformed, are ignored. */
  push(f: BookFrame): boolean {
    if (f.status !== 'live' || f.mid === null || !(f.bucket > 0) || f.bids.length === 0 || f.bids.length !== f.asks.length) return false
    // a different grid (another market, or the width was re-chosen): the old rows no longer line up
    if (this.bucket !== 0 && (f.bucket !== this.bucket || f.bids.length !== this.cols)) this.reset()
    this.bucket = f.bucket
    this.cols = f.bids.length

    const bin = Math.floor(f.ts / this.opts.intervalMs)
    if (bin < this.newest - this.keep) return false // older than anything we keep
    const have = this.bins.get(bin)
    if (have && have.ts > f.ts) return false // an older frame arriving late must not replace a newer one
    this.bins.set(bin, f)
    if (bin > this.newest) this.newest = bin
    for (const k of this.bins.keys()) if (k <= this.newest - this.keep) this.bins.delete(k)
    return true
  }

  /**
   * Build the grid ending at time step `endBin` (default: the newest, i.e. live). Returns null until there is a frame.
   * Rewinding shows exactly what was recorded then; steps we never received stay unknown.
   */
  sample(endBin?: number): TimelineSample | null {
    if (this.newest === -Infinity) return null
    const end = endBin === undefined ? this.newest : Math.min(endBin, this.newest)
    const { slices, intervalMs } = this.opts
    const cols = this.cols
    const bids = new Float32Array(slices * cols)
    const asks = new Float32Array(slices * cols)
    const known = new Uint8Array(slices * cols)
    const mids: number[] = new Array(slices).fill(NaN)
    const times: number[] = new Array(slices)
    let anchor = this.bins.get(end)
    for (let b = end - 1; !anchor && b > end - slices; b--) anchor = this.bins.get(b)
    if (!anchor) return null
    const k0 = anchor.k0

    for (let r = 0; r < slices; r++) {
      const bin = end - (slices - 1 - r)
      times[r] = bin * intervalMs
      const f = this.bins.get(bin)
      if (!f) continue
      mids[r] = f.mid as number
      const shift = f.k0 - k0 // how far this frame's window sits from the newest one
      const cover = f.cover
      const eps = f.bucket * 1e-6
      for (let c = 0; c < cols; c++) {
        const src = c - shift
        if (src < 0 || src >= cols) continue
        // a bucket is only known if the frame vouched for its whole price range
        const lo = (f.k0 + src) * f.bucket
        if (!cover || lo < cover[0] - eps || lo + f.bucket > cover[1] + eps) continue
        bids[r * cols + c] = f.bids[src]
        asks[r * cols + c] = f.asks[src]
        known[r * cols + c] = 1
      }
    }
    return { bucket: this.bucket, k0, cols, rows: slices, bids, asks, known, mids, times }
  }
}
