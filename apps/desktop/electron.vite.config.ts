/**
 * electron-vite build config (desktop-app §10). Main and preload are Node
 * bundles: workspace deps (`@dami-sg/gateway/process|paths|admin-auth`,
 * `@dami-sg/agent-client`, `ws`) are BUNDLED so the packaged app needs no
 * node_modules — only `electron` itself, `electron-updater` (the one packed
 * runtime dep) and ws's optional native addons stay external. The renderer is
 * a React SPA with Tailwind v4 + shadcn/ui.
 */
import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        external: ['electron', 'electron-updater', 'bufferutil', 'utf-8-validate'],
      },
    },
  },
  preload: {
    build: {
      rollupOptions: {
        external: ['electron'],
        // Sandboxed preloads must be CJS; `.cjs` keeps Node's ESM inference
        // (package `"type": "module"`) from misreading it.
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
  },
  renderer: {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@': resolve(import.meta.dirname, 'src/renderer/src'),
      },
    },
  },
});
