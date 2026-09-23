import { defineConfig } from 'vite';
import { gelApiPlugin } from './src/server/plugin.js';

export default defineConfig({
  server: {
    host: '127.0.0.1',
    port: 5342,
    strictPort: true,
  },
  plugins: [gelApiPlugin()],
});
