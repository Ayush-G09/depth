import { useEffect, useState } from 'react'
import type { Candle } from '@depth/core'
import { apiBase } from './api'

/** Recent trade candles for a market, refreshed every few seconds while `enabled`. */
export function useCandles(symbol: string, interval: string, enabled: boolean) {
  const [candles, setCandles] = useState<Candle[]>([])
  const [error, setError] = useState(false)
  useEffect(() => {
    if (!enabled) return
    let dead = false
    setCandles([])
    const load = () => {
      fetch(`${apiBase}/api/candles?symbol=${symbol}&interval=${interval}`)
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
        .then((d: { candles: Candle[] }) => { if (!dead) { setCandles(d.candles); setError(false) } })
        .catch(() => { if (!dead) setError(true) })
    }
    load()
    const t = setInterval(load, 10_000)
    return () => { dead = true; clearInterval(t) }
  }, [symbol, interval, enabled])
  return { candles, error }
}
