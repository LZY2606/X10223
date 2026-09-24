import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from './src/server/store.ts';
import { createApiHandler } from './src/server/api.ts';
import { loadCasePack, runCasePack } from './src/domain/casepack.ts';

function apiPlugin(): Plugin {
  return {
    name: 'gel-api',
    configureServer(server) {
      mkdirSync(join(process.cwd(), 'data'), { recursive: true });
      const store = new Store(join(process.cwd(), 'data', 'gel.db'));
      if (store.isEmpty()) {
        runCasePack(store, loadCasePack(join(process.cwd(), 'casepack', 'case.json')));
      }
      const handler = createApiHandler(store, join(process.cwd(), 'casepack', 'case.json'));
      server.middlewares.use(handler);
    },
  };
}

export default defineConfig({
  plugins: [react(), apiPlugin()],
  server: { strictPort: true },
});
