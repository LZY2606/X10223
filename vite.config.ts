import { defineConfig } from 'vite';

export default viteConfig;

const viteConfig = defineConfig({
  root: '.',
  server: {
    host: '127.0.0.1',
    port: 5342,
    strictPort: true
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true
  }
});
