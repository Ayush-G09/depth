import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertEngine, priceRule } from '@depth/core'
import type { AlertEvent, AlertRule, Whale } from '@depth/core'

const KEY = 'depth.alerts.v1'

const load = (): AlertRule[] => {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '[]') as unknown
    return Array.isArray(v) ? (v.filter((r) => r && typeof r.id === 'string' && typeof r.symbol === 'string' && (r.kind === 'price' || r.kind === 'whale')) as AlertRule[]) : []
  } catch { return [] }
}

function beep() {
  try {
    const ctx = new AudioContext()
    const o = ctx.createOscillator()
    const g = ctx.createGain()
    o.frequency.value = 880
    g.gain.setValueAtTime(0.08, ctx.currentTime)
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.35)
    o.connect(g).connect(ctx.destination)
    o.start()
    o.stop(ctx.currentTime + 0.4)
    setTimeout(() => void ctx.close(), 600)
  } catch { /* no audio available: the toast is enough */ }
}

export interface Toast extends AlertEvent { key: number }

/**
 * Alerts kept in this browser (nothing is sent to a server). They only fire on live data, while the page is open.
 * A toast is always shown; a system notification too if the user allowed it.
 */
export function useAlerts(symbol: string, mid: number | null, whales: Whale[], live: boolean, fmt: (symbol: string, price: number) => string) {
  const [rules, setRules] = useState<AlertRule[]>(load)
  const [toasts, setToasts] = useState<Toast[]>([])
  const fmtRef = useRef(fmt)
  fmtRef.current = fmt
  const engine = useRef(new AlertEngine((s, p) => fmtRef.current(s, p)))
  const n = useRef(0)

  useEffect(() => { try { localStorage.setItem(KEY, JSON.stringify(rules)) } catch { /* private mode */ } }, [rules])

  useEffect(() => {
    if (!live) return
    const events = engine.current.check(rules, symbol, mid, whales)
    if (events.length === 0) return
    for (const e of events) {
      const r = rules.find((x) => x.id === e.ruleId)
      if (r?.kind === 'price') setRules((all) => all.filter((x) => x.id !== e.ruleId)) // a price alert is used up once it fires
      try { if (typeof Notification !== 'undefined' && Notification.permission === 'granted') new Notification('Depth', { body: e.message }) } catch { /* ignore */ }
    }
    beep()
    setToasts((t) => [...t, ...events.map((e) => ({ ...e, key: ++n.current }))].slice(-4))
  }, [rules, symbol, mid, whales, live])

  useEffect(() => {
    if (toasts.length === 0) return
    const t = setTimeout(() => setToasts((all) => all.slice(1)), 7000)
    return () => clearTimeout(t)
  }, [toasts])

  const askPermission = () => { try { if (typeof Notification !== 'undefined' && Notification.permission === 'default') void Notification.requestPermission() } catch { /* ignore */ } }

  const addPrice = useCallback((price: number): string | null => {
    if (mid === null) return 'Wait for a live price first'
    const r = priceRule(crypto.randomUUID(), symbol, price, mid)
    if (!r) return 'Pick a price different from the current one'
    setRules((all) => [...all, r])
    askPermission()
    return null
  }, [symbol, mid])

  const toggleWhale = useCallback((minUsd: number) => {
    setRules((all) => {
      const has = all.some((r) => r.kind === 'whale' && r.symbol === symbol)
      return has ? all.filter((r) => !(r.kind === 'whale' && r.symbol === symbol)) : [...all, { id: crypto.randomUUID(), symbol, kind: 'whale', minUsd }]
    })
    askPermission()
  }, [symbol])

  const remove = useCallback((id: string) => { engine.current.forget(id); setRules((all) => all.filter((r) => r.id !== id)) }, [])
  const dismiss = useCallback((key: number) => setToasts((all) => all.filter((t) => t.key !== key)), [])

  return { rules, toasts, addPrice, toggleWhale, remove, dismiss }
}
