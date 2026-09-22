import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { gelApiPlugin } from './src/server/plugin';

export default defineConfig({
  plugins: [react(), gelApiPlugin()],
  server: { host: '127.0.0.1', port: 5342, strictPort: true },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    globals: false,
    testTimeout: 20000
  }
} as any);
