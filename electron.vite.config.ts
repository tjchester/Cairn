import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

const shared = resolve(__dirname, 'src/shared')

// The renderer never talks to the network itself (all fetching happens in the main process),
// so it can be locked down hard. Remote images (covers, favicons) are the only external load.
const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data: http: https:",
  "font-src 'self'",
  "connect-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-src 'none'"
].join('; ')

// Production only: the dev server needs inline scripts and websockets for hot reload.
const injectCsp = {
  name: 'cairn:inject-csp',
  apply: 'build' as const,
  transformIndexHtml: () => [
    { tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: CSP }, injectTo: 'head-prepend' as const }
  ]
}

export default defineConfig({
  main: {
    resolve: { alias: { '@shared': shared } },
    build: {
      // `node:sqlite` is a scheme-only built-in; make sure the bundler leaves it alone.
      rollupOptions: { external: ['node:sqlite'] }
    }
  },
  preload: {
    resolve: { alias: { '@shared': shared } }
  },
  renderer: {
    resolve: {
      alias: { '@shared': shared }
    },
    plugins: [react(), injectCsp]
  }
})
