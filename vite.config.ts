import { defineConfig } from 'vite';
import { gelApiPlugin } from './src/server/vite-plugin';

export default defineConfig({
  plugins: [gelApiPlugin()],
  server: { host: '127.0.0.1', port: 5342, strictPort: true },
  root: '.'
});
