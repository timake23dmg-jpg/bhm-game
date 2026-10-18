import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // Relative asset paths so the same build works at a site root (Netlify)
  // or under a sub-path (GitHub Pages: /fakeout/).
  base: './',
  server: { host: true, port: 5173 },
  // The AI-voice worker (src/lib/tts.worker.js) imports code-split modules.
  worker: { format: 'es' },
})
