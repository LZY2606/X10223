import { defineConfig } from 'vite';
import { viteGelApi } from './src/server/vite-plugin.ts';

export default defineConfig({
  plugins: [viteGelApi()],
  server: {
    host: '127.0.0.1',
    port: 5342,
    strictPort: true
  },
  build: {
    target: 'es2022',
    sourcemap: true
  }
});
