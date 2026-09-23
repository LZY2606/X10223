import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { gelApiPlugin } from './server/devPlugin';

export default defineConfig({
  plugins: [react(), gelApiPlugin()],
  server: { host: '127.0.0.1' },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
