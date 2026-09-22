import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { createApiMiddleware } from './src/server/middleware.js';

export default defineConfig({
  plugins: [
    react(),
    {
      name: 'gelwb-api',
      configureServer(server) {
        server.middlewares.use(createApiMiddleware());
      },
    },
  ],
  server: { host: '127.0.0.1', port: 5342, strictPort: true },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    testTimeout: 20000,
  },
} as any);
