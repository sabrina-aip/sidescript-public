import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const api = `http://127.0.0.1:${process.env.PORT || 8080}`

// The dev proxy rewrites Host to the API address; tell the server which host the browser used.
const forwardHost = (proxy: any) =>
  proxy.on('proxyReq', (proxyReq: any, req: any) => proxyReq.setHeader('X-Forwarded-Host', req.headers.host || ''))

export default defineConfig({
  root: 'client',
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    chunkSizeWarningLimit: 900,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: api, configure: forwardHost },
      '/ws': {
        target: api.replace('http', 'ws'),
        ws: true,
        configure: (proxy: any) => {
          forwardHost(proxy)
          proxy.on('proxyReqWs', (proxyReq: any, req: any) => proxyReq.setHeader('X-Forwarded-Host', req.headers.host || ''))
        },
      },
    },
  },
})
