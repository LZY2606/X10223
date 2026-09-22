import { defineConfig } from 'vite';

export default defineConfig({
  appType: 'custom',
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node'
  }
} as never);
