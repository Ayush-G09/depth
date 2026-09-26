import type { SnapshotGate } from './feed'

/**
 * Lets one snapshot request through per `minIntervalMs`, across every feed. Binance charges a heavy "weight" for
 * a deep snapshot (250 for 5000 levels, against 6000 per minute), so a resync storm must never turn into a ban.
 */
export class RateGate implements SnapshotGate {
  private next = 0
  constructor(private readonly minIntervalMs: number) {}

  wait(): Promise<void> {
    const now = Date.now()
    const at = Math.max(now, this.next)
    this.next = at + this.minIntervalMs
    const delay = at - now
    return delay <= 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, delay))
  }
}
