import { defineConfig } from 'vite';
import { createServerApi } from './src/server/index.js';

export default defineConfig({
  root: '.',
  server: {
    host: '127.0.0.1',
    port: 5342,
    strictPort: true,
    fs: { strict: false },
  },
  build: { outDir: 'dist' },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    globals: false,
    testTimeout: 20000,
  },
  plugins: [
    {
      name: 'gel-ruler-api',
      configureServer(server) {
        server.middlewares.use(createServerApi());
      },
      configurePreviewServer(server) {
        server.middlewares.use(createServerApi());
      },
    },
  ],
});
