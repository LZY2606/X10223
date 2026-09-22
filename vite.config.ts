import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { gelApiPlugin } from './src/server/vitePlugin';

export default defineConfig({
  plugins: [react(), gelApiPlugin()],
});
