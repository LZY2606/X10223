import { defineConfig } from 'vite';

export default defineConfig({
  appType: 'spa',
  server: { middlewareMode: true },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 20000
  }
});
