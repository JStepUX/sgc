import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { resolve } from 'path';

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src/client'),
    },
  },
  server: {
    port: 5555,
    // Fail loudly if 5555 is taken rather than silently drifting to the next
    // free port — a drifted port breaks the server's CORS_ORIGIN match.
    strictPort: true,
    // The browser never talks to api.anthropic.com directly. /api is proxied
    // to the Express server, which holds ANTHROPIC_API_KEY.
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist/client',
    emptyOutDir: true,
  },
});
