/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import { gelApiPlugin } from './src/server/vitePlugin';

const isTest = process.env.VITEST === 'true';

// Node 24 的实验内置 node:sqlite 尚未进入 Vite 5 的内置表，显式外部化。
const externalSqlite = {
  name: 'external-node-sqlite',
  enforce: 'pre' as const,
  resolveId(source: string) {
    if (source === 'node:sqlite' || source === 'sqlite') return { id: 'node:sqlite', external: true };
    return null;
  },
};

export default defineConfig({
  plugins: isTest ? [externalSqlite] : [gelApiPlugin()],
  server: { host: '127.0.0.1', port: 5342, strictPort: true },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 20000,
  }
});
