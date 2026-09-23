import { defineConfig } from 'vite';

export default defineConfig({
  root: '.',
  server: {
    host: '127.0.0.1',
    port: 5342,
    strictPort: true,
    proxy: {
      '/api': 'http://127.0.0.1:5343'
    }
  },
  build: {
    outDir: 'dist',
    target: 'es2022'
  }
});
