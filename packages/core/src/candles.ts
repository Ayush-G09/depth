export interface Candle {
  /** start of the candle, ms since the epoch */
  t: number
  o: number
  h: number
  l: number
  c: number
  /** base-currency volume traded in the candle */
  v: number
}

/**
 * Binance kline rows are arrays: [openTime, open, high, low, close, volume, ...] with prices as strings.
 * Anything malformed or self-contradictory (high below low, a price outside the high/low range) is dropped, not guessed at.
 */
export function parseKlines(raw: unknown): Candle[] {
  if (!Array.isArray(raw)) return []
  const out: Candle[] = []
  for (const row of raw) {
    if (!Array.isArray(row) || row.length < 6) continue
    const [t, o, h, l, c, v] = [Number(row[0]), Number(row[1]), Number(row[2]), Number(row[3]), Number(row[4]), Number(row[5])]
    if (![t, o, h, l, c, v].every(Number.isFinite) || o <= 0 || h <= 0 || l <= 0 || c <= 0 || v < 0) continue
    if (h < l || o > h || o < l || c > h || c < l) continue
    if (out.length && t <= out[out.length - 1].t) continue // must move forward in time
    out.push({ t, o, h, l, c, v })
  }
  return out
}
