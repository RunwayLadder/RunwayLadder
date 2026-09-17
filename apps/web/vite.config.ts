import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// The base path is set only by the deployment: on GitHub Pages the site lives under
// /<repo>/, locally and on preview — at the root. Without the variable nothing changes.
const base = process.env.PAGES_BASE ?? '/'

export default defineConfig({
  base,
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
})
