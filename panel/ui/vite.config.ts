import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// 面板前端：构建产物 dist/ 将由 Go 后端 (panel/cmd/panel) 静态托管在 :9000
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { '/api': 'http://127.0.0.1:9000' }, // dev 时转发到 Go 面板
  },
})
