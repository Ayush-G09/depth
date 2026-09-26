import type { BookFrame } from './types'

export interface TimelineOptions {
  /** Rows kept (time steps). */
  slices: number
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
    if (bin < this.newest - this.opts.slices) return false // older than anything we keep
    const have = this.bins.get(bin)
    if (have && have.ts > f.ts) return false // an older frame arriving late must not replace a newer one
    this.bins.set(bin, f)
    if (bin > this.newest) this.newest = bin
    for (const k of this.bins.keys()) if (k <= this.newest - this.opts.slices) this.bins.delete(k)
    return true
  }

  /** Build the grid. Returns null until there is a frame. */
  sample(): TimelineSample | null {
    if (this.newest === -Infinity) return null
    const { slices, intervalMs } = this.opts
    const cols = this.cols
    const bids = new Float32Array(slices * cols)
    const asks = new Float32Array(slices * cols)
    const known = new Uint8Array(slices * cols)
    const mids: number[] = new Array(slices).fill(NaN)
    const times: number[] = new Array(slices)
    const newestFrame = this.bins.get(this.newest)!
    const k0 = newestFrame.k0

    for (let r = 0; r < slices; r++) {
      const bin = this.newest - (slices - 1 - r)
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
