import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'

// Dev only: where the API server listens (LIGATURE_API_PORT) and Vite's own port (LIGATURE_WEB_PORT).
const API_PORT = Number(process.env.LIGATURE_API_PORT ?? 3000)
const WEB_PORT = Number(process.env.LIGATURE_WEB_PORT ?? 5173)
const API = `http://127.0.0.1:${API_PORT}`

export default defineConfig({
  plugins: [svelte()],
  server: {
    port: WEB_PORT,
    strictPort: true,
    // changeOrigin is deliberately NOT set: the server checks the browser's Origin (http://localhost:5173).
    // *.localhost subdomains (alice.localhost, bob.localhost) are allowed by Vite by default and get their own cookies.
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
