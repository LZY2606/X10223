import { defineConfig } from 'vite';
import { gelApiPlugin } from './src/server/vitePlugin';

export default defineConfig({
  root: '.',
  plugins: [gelApiPlugin()],
  server: { host: '127.0.0.1', port: 5342, strictPort: true },
  build: { target: 'es2022', outDir: 'dist' }
});
