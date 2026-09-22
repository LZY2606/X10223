import { defineConfig } from 'vite';
import { resolve } from 'node:path';

export default defineConfig({
  root: resolve('client'),
  build: { outDir: resolve('dist'), emptyOutDir: true },
  server: {
    host: '127.0.0.1',
    port: 5342,
    strictPort: true,
  },
  test: {
    include: ['../test/**/*.test.ts'],
    environment: 'node',
    hookTimeout: 30000,
    testTimeout: 20000,
  },
});
