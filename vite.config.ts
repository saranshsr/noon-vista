import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'node:path'

/**
 * Dev/preview port.
 *
 * Takes an assigned `PORT` when the launcher provides one, otherwise 6100 as the habitual
 * default. Previously 6100 was hardcoded with `strictPort: true`, so the dev server refused
 * to start at all whenever anything else held that port — which happened the moment an
 * unrelated app claimed it.
 *
 * 6100 is not load-bearing here: there is no backend, no OAuth callback, no webhook, and no
 * CORS origin that has to match. The app is a static SPA that persists to localStorage, so
 * any port works.
 */
const PORT = process.env.PORT ? Number(process.env.PORT) : 6100

// https://vite.dev/config/
export default defineConfig({
  build: {
    // es2022 for top-level await: the Supabase adapter loads behind `await import`
    // so its ~330KB chunk is fetched only when that backend is configured. Vite's
    // default (es2020/chrome87) predates TLA; every browser this tool supports is
    // years past it.
    target: 'es2022',
  },
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: PORT,
    // Fall forward to the next free port instead of refusing to boot. See PORT above.
    strictPort: false,
  },
  preview: {
    port: PORT,
    strictPort: false,
  },
})
