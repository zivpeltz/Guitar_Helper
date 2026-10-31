import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { alphaTab } from '@coderline/alphatab-vite'

// The backend (FastAPI) runs on :8765; in dev, Vite proxies /api to it.
export default defineConfig({
  plugins: [react(), alphaTab()],
  build: { chunkSizeWarningLimit: 4000 },
  server: {
    port: 5173,
    proxy: { '/api': 'http://127.0.0.1:8765' },
  },
})
