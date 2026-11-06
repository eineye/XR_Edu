import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// 개발 서버: /api, /health, /ws 요청을 로컬 FastAPI 서버로 전달
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const target = env.VITE_API_TARGET || 'http://127.0.0.1:8000'
  return {
    plugins: [react(), tailwindcss()],
    build: { chunkSizeWarningLimit: 1200 },
    server: {
      host: true,
      port: 5173,
      proxy: {
        '/api': target,
        '/health': target,
        '/ws': { target: target.replace(/^http/, 'ws'), ws: true },
      },
    },
  }
})
