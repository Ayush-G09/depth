import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// where the depth server lives in development
const SERVER = process.env.DEPTH_SERVER ?? 'http://localhost:3100'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5190,
    proxy: {
      '/stream': { target: SERVER.replace(/^http/, 'ws'), ws: true },
      '/health': SERVER,
      '/api': SERVER,
    },
  },
  build: { chunkSizeWarningLimit: 1200 },
})
