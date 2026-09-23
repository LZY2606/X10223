import { defineConfig } from 'vite';

export default defineConfig({
  root: 'src/client',
  publicDir: false,
  server: {
    middlewareMode: true,
    host: '127.0.0.1',
    port: 5342,
    strictPort: true,
  },
  build: {
    outDir: '../../dist',
    emptyOutDir: true,
  },
  resolve: {
    alias: {
      '@shared': '/src/shared',
      '@engine': '/src/engine',
      '@store': '/src/store',
      '@service': '/src/service',
    },
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    globals: true,
  },
});
