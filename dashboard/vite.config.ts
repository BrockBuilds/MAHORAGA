import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const agentPort = process.env.AGENT_PORT || '5000'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: parseInt(process.env.PORT || '5175'),
    host: '0.0.0.0',
    proxy: {
      '/api': {
        target: `http://localhost:${agentPort}`,
        changeOrigin: true,
      },
    },
  },
})
