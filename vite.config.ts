import { defineConfig, type Plugin } from 'vite';
import { createGelApiPlugin } from './src/server/vite-plugin';

export default defineConfig({
  server: { host: '127.0.0.1', port: 5342, strictPort: true },
  plugins: [createGelApiPlugin() as Plugin],
  build: { target: 'es2022' }
});
