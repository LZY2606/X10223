/// <reference types="vitest" />
import { defineConfig } from 'vite';
import { gelApiPlugin } from './src/server/api';

export default defineConfig({
  plugins: [gelApiPlugin()],
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 20000
  }
});
