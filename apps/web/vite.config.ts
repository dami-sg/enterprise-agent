import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// The frontend is served from Vite's dev server (5173) and proxies `/api/*` to
// the gateway's Web chat server (ea-gateway web, default :7318). Same-origin in
// dev means the session cookie flows without CORS. In production the built
// static assets are served behind the same origin as the API (web-app §6).
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5180,
    proxy: {
      '/api': { target: 'http://localhost:7318', changeOrigin: true },
    },
  },
});
