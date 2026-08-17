import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// https://vite.dev/config/
export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    // Honour PORT when the host assigns one; otherwise use Vite's default.
    port: Number(process.env.PORT) || 5173,
    proxy: {
      // In dev the API is served by `wrangler dev` (workerd + local D1).
      '/api': {
        target: `http://localhost:${process.env.WORKER_PORT || 8787}`,
        changeOrigin: true,
      },
    },
  },
})
