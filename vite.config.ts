import { defineConfig } from 'vite';

export default defineConfig({
  root: '.',
  publicDir: false,
  build: { outDir: 'dist/client' },
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 20000
  }
});
