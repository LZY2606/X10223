import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import type { Plugin } from 'vite';
import { createApiMiddleware } from './src/server/api.ts';

// 同一个 5342 端口：Vite 负责前端，/api/* 由 Node 服务端（SQLite + 业务规则）处理。
function gelApiPlugin(): Plugin {
  return {
    name: 'gel-api',
    configureServer(server) {
      server.middlewares.use(createApiMiddleware());
    },
    configurePreviewServer(server) {
      server.middlewares.use(createApiMiddleware());
    },
  };
}

export default defineConfig({
  plugins: [react(), gelApiPlugin()],
  server: { host: '127.0.0.1', port: 5342, strictPort: true },
  preview: { host: '127.0.0.1', port: 5342', strictPort: true },
  test: {
    environment: 'node',
    include: ['src/test/**/*.test.ts'],
    globals: false,
  },
});
