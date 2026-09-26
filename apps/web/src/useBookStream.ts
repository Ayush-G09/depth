import { useEffect, useRef, useState } from 'react'
import { Timeline } from '@depth/core'
import type { BookFrame } from '@depth/core'

export type Link = 'connecting' | 'open' | 'closed'

export const SLICES = 240
export const STEP_MS = 500
/** How much history is kept for replay: 10 minutes. */
export const KEEP = 1200

export interface Stream {
  /** the websocket to the server */
  link: Link
  /** the newest frame (updated a few times a second: for readouts, not for drawing) */
  frame: BookFrame | null
  /** the history the 3D view draws from; mutated in place as frames arrive */
  timeline: Timeline
  /** milliseconds between the server making a frame and us receiving it (rough: the clocks may differ) */
  lagMs: number | null
  /** increases whenever the timeline has new data */
  tick: React.MutableRefObject<number>
}

const wsBase = () => {
  const configured = import.meta.env.VITE_WS_URL as string | undefined
  if (configured) return configured
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/stream`
}

/** Connects to the depth server for one market, reconnecting on its own, and keeps a Timeline of what it sends. */
export function useBookStream(symbol: string): Stream {
  const timeline = useRef(new Timeline({ slices: SLICES, keep: KEEP, intervalMs: STEP_MS }))
  const tick = useRef(0)
  const [link, setLink] = useState<Link>('connecting')
  const [frame, setFrame] = useState<BookFrame | null>(null)
  const [lagMs, setLagMs] = useState<number | null>(null)

  useEffect(() => {
    timeline.current.reset()
    setFrame(null)
    setLink('connecting')
    let ws: WebSocket | null = null
    let retry = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    let dead = false
    let lastShown = 0
    let latest: BookFrame | null = null

    const open = () => {
      if (dead) return
      setLink('connecting')
      ws = new WebSocket(`${wsBase()}?symbol=${encodeURIComponent(symbol)}`)
      ws.onopen = () => { retry = 0; setLink('open') }
      ws.onmessage = (e) => {
        let f: BookFrame
        try { f = JSON.parse(e.data as string) as BookFrame } catch { return }
        if (f.type !== 'book' || f.symbol !== symbol) return
        latest = f
        if (timeline.current.push(f)) tick.current++
        const now = performance.now()
        if (now - lastShown > 200) { lastShown = now; setFrame(f); setLagMs(Date.now() - f.ts) }
      }
      ws.onclose = () => {
        setLink('closed')
        if (dead) return
        timer = setTimeout(open, Math.min(8000, 400 * 2 ** retry++) * (0.8 + Math.random() * 0.4))
      }
      ws.onerror = () => ws?.close()
    }
    open()
    const flush = setInterval(() => { if (latest) setFrame(latest) }, 1000) // make sure the last frame is shown even after a burst

    return () => {
      dead = true
      clearTimeout(timer)
      clearInterval(flush)
      ws?.close()
    }
  }, [symbol])

  return { link, frame, timeline: timeline.current, lagMs, tick }
}
