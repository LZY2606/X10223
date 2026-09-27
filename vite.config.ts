import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import { serverApiPlugin } from './server/vite-plugin.mjs';

export default defineConfig({
  root: resolve('packages/client'),
  resolve: {
    alias: { '@shared': resolve('packages/shared/src') }
  },
  server: {
    host: '127.0.0.1',
    port: 5342,
    strictPort: true
  },
  plugins: [serverApiPlugin()]
});
