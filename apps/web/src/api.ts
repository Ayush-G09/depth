/** Where the HTTP API lives: the same host as the stream (derived from VITE_WS_URL in production, proxied in development). */
export const apiBase = (() => {
  const ws = import.meta.env.VITE_WS_URL as string | undefined
  if (!ws) return ''
  return ws.replace(/^ws/, 'http').replace(/\/stream\/?$/, '')
})()
