import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import { createApiMiddleware } from './server/vite-middleware';

export default defineConfig({
  root: '.',
  server: {
    host: '127.0.0.1',
    port: 5342,
    strictPort: true,
    fs: { strict: false }
  },
  preview: {
    host: '127.0.0.1',
    port: 5342,
    strictPort: true
  },
  plugins: [
    {
      name: 'gel-bench-api',
      configureServer(server) {
        server.middlewares.use(createApiMiddleware());
      },
      configurePreviewServer(server) {
        server.middlewares.use(createApiMiddleware());
      }
    }
  ],
  build: {
    outDir: 'dist',
    rollupOptions: {
      input: { main: resolve(__dirname, 'index.html') }
    }
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts']
  }
});
