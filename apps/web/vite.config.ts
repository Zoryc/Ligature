import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'

const API = 'http://127.0.0.1:3000'

export default defineConfig({
  plugins: [svelte()],
  server: {
    port: 5173,
    strictPort: true,
    // changeOrigin is deliberately NOT set: the server checks the browser's Origin (http://localhost:5173).
    proxy: {
      '/api': { target: API },
      '/collab': { target: API.replace('http', 'ws'), ws: true },
    },
  },
  build: {
    // pdf.js 6 targets modern browsers; do not down-level it.
    target: 'es2023',
    // No source maps in the shipped build (they were ~4.6 MB). Use `npx vite build --sourcemap` when debugging.
    sourcemap: false,
    // The editor chunk (CodeMirror + Yjs + collab client) is ~530 kB minified, ~170 kB gzipped; that is expected.
    chunkSizeWarningLimit: 800,
  },
})
