import type { Whale } from './whales'

export type AlertRule =
  | { id: string; symbol: string; kind: 'price'; dir: 'above' | 'below'; price: number }
  | { id: string; symbol: string; kind: 'whale'; minUsd: number }

export interface AlertEvent {
  ruleId: string
  symbol: string
  message: string
  at: number
}

/** A price alert says which way the price must cross, decided from where the price is when the alert is made. */
export function priceRule(id: string, symbol: string, price: number, currentMid: number): AlertRule | null {
  if (!(price > 0) || !(currentMid > 0) || price === currentMid) return null
  return { id, symbol, kind: 'price', dir: price > currentMid ? 'above' : 'below', price }
}

/**
 * Decides when alerts fire. Price alerts fire once when the price reaches the level (they then stay quiet; the
 * caller removes them). Whale alerts fire when a wall of at least `minUsd` appears, once per wall: a wall that stays
 * does not fire again, and one that goes away and returns later may.
 */
export class AlertEngine {
  private readonly seen = new Map<string, Set<string>>() // ruleId -> walls already announced
  private readonly fired = new Set<string>()

  constructor(private readonly fmt: (symbol: string, price: number) => string = (_s, p) => String(p)) {}

  check(rules: readonly AlertRule[], symbol: string, mid: number | null, whales: readonly Whale[], now = Date.now()): AlertEvent[] {
    const out: AlertEvent[] = []
    for (const r of rules) {
      if (r.symbol !== symbol) continue
      if (r.kind === 'price') {
        if (mid === null || this.fired.has(r.id)) continue
        if ((r.dir === 'above' && mid >= r.price) || (r.dir === 'below' && mid <= r.price)) {
          this.fired.add(r.id)
          out.push({ ruleId: r.id, symbol, at: now, message: `${symbol} ${r.dir === 'above' ? 'rose to' : 'fell to'} ${this.fmt(symbol, mid)} (alert ${this.fmt(symbol, r.price)})` })
        }
      } else {
        const now_ = new Set<string>()
        const seen = this.seen.get(r.id) ?? new Set<string>()
        for (const w of whales) {
          if (w.usd < r.minUsd) continue
          const key = `${w.side}@${w.price}`
          now_.add(key)
          if (seen.has(key)) continue
          out.push({ ruleId: r.id, symbol, at: now, message: `${w.side === 'bid' ? 'Buy' : 'Sell'} wall of $${Math.round(w.usd / 1000).toLocaleString('en-US')}k at ${this.fmt(symbol, w.price)}` })
        }
        this.seen.set(r.id, now_) // walls that vanished are forgotten, so they can announce again if they return
      }
    }
    return out
  }

  /** Forget a rule that was removed. */
  forget(id: string) { this.seen.delete(id); this.fired.delete(id) }
}
