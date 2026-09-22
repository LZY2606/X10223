import { defineConfig } from 'vite';
import { gelRulerApi } from './src/server/vite-plugin-api';

export default defineConfig({
  root: '.',
  plugins: [gelRulerApi()],
  server: { host: '127.0.0.1', port: 5342, strictPort: true }
});
