import { defineConfig, type Plugin } from 'vite';
import { createApiApp } from './src/server/api.js';
import { openStore } from './src/server/store.js';
import { seedIfEmpty } from './src/server/seed.js';
import path from 'node:path';
import fs from 'node:fs';

function gelApiPlugin(): Plugin {
  return {
    name: 'gel-api',
    configureServer(server) {
      const dataDir = path.resolve(process.cwd(), 'data');
      fs.mkdirSync(dataDir, { recursive: true });
      const store = openStore(path.join(dataDir, 'app.db'));
      seedIfEmpty(store);
      const app = createApiApp(store);
      server.middlewares.use('/api', app);
    },
  };
}

export default defineConfig({
  plugins: [gelApiPlugin()],
  server: { host: '127.0.0.1' },
});
