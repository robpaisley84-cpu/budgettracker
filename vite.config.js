import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  define: {
    // Unique version per build — forces session clear on new deployments
    __APP_VERSION__: JSON.stringify(Date.now().toString(36)),
  },
})
