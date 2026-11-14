import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'electron-vite'
import { copyFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { playerOrigin, playerScheme } from './src/shared/contracts'

export default defineConfig({
  main: {
    plugins: [{
      name: 'mustplay-window-icon',
      writeBundle({ dir }) {
        copyFileSync('src/assets/mustplay.ico', resolve(dir!, 'mustplay.ico'))
      },
    }],
  },
  preload: {
    build: {
      rollupOptions: { output: { format: 'cjs', entryFileNames: '[name].cjs' } },
    },
  },
  renderer: {
    server: { host: '127.0.0.1' },
    build: { assetsInlineLimit: 0 },
    plugins: [react(), tailwindcss(), {
      name: 'player-content-security-policy',
      transformIndexHtml(_html, { server }) {
        const policy = [
          "default-src 'none'",
          `script-src 'self'${server ? " 'unsafe-inline'" : ''}`,
          `style-src 'self'${server ? " 'unsafe-inline'" : ''}`,
          `media-src ${server ? `${playerScheme}:` : "'self'"}`,
          `img-src ${server ? playerOrigin : "'self'"}`,
          `connect-src 'self'${server ? ' ws://127.0.0.1:*' : ''}`,
          "base-uri 'none'",
          "form-action 'none'",
        ].join('; ')
        return [{
          tag: 'meta',
          attrs: { 'http-equiv': 'Content-Security-Policy', content: policy },
          injectTo: 'head-prepend',
        }]
      },
    }],
  },
})
