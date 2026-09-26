/**
 * Price buckets: the order book is far too detailed to draw (BTC has a level every cent), so quantities are
 * summed into buckets of equal price width. Bucket `k` covers prices in [k * width, (k + 1) * width).
 */

/** Round up to a "nice" width: 1, 2 or 5 times a power of ten (0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, ...). */
export function niceStep(x: number): number {
  if (!(x > 0) || !Number.isFinite(x)) return 1
  const exp = Math.floor(Math.log10(x))
  const base = 10 ** exp
  const m = x / base
  const nice = m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10
  return roundTo(nice * base, Math.max(0, -exp + 1))
}

/**
 * Like niceStep but never larger than `x`: the biggest of 1, 2, 5 times a power of ten that is <= x.
 * Use this when `x` is a limit that must not be exceeded (e.g. how wide a window can safely be).
 */
export function niceStepDown(x: number): number {
  if (!(x > 0) || !Number.isFinite(x)) return 1
  const exp = Math.floor(Math.log10(x))
  const base = 10 ** exp
  const m = x / base + 1e-12
  const nice = m >= 5 ? 5 : m >= 2 ? 2 : 1
  return roundTo(nice * base, Math.max(0, -exp + 1))
}

/** Index of the bucket a price falls in. The tiny nudge stops 0.3 / 0.1 style float error from landing one bucket low. */
export function bucketIndex(price: number, width: number): number {
  return Math.floor(price / width + 1e-9)
}

/** The lower edge of bucket `k`, without float noise (0.05 * 3 = 0.15000000000000002 becomes 0.15). */
export function bucketPrice(k: number, width: number): number {
  return roundTo(k * width, decimalsOf(width) + 1)
}

export function decimalsOf(x: number): number {
  const s = String(x)
  if (s.includes('e-')) return Number(s.split('e-')[1]) + (s.split('e-')[0].split('.')[1]?.length ?? 0)
  return s.split('.')[1]?.length ?? 0
}

export function roundTo(x: number, decimals: number): number {
  const f = 10 ** decimals
  return Math.round(x * f) / f
}
