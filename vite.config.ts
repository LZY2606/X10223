import { defineConfig, type Plugin } from 'vitest/config';
import { Store } from './src/server/store.js';
import { seedStore } from './src/server/workspace.js';
import { handleApi } from './src/server/api.js';

function apiPlugin(): Plugin {
  const dbPath = process.env.GEL_DB_PATH ?? './data/gel-workbench.sqlite';
  const store = new Store(dbPath);
  let seeded = false;
  const ensureSeeded = () => { if (!seeded) { store.recoverInterrupted(); seedStore(store); seeded = true; } };
  return {
    name: 'gel-api',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        try {
          const url = new URL(req.url ?? '/', 'http://127.0.0.1');
          const handled = await handleApi({ store, ensureSeeded }, req as never, res as never, url);
          if (!handled) next();
        } catch (err) {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: String(err) }));
        }
      });
    },
  };
}

export default defineConfig({
  plugins: [apiPlugin()],
  server: { host: '127.0.0.1', port: 5342, strictPort: true },
  test: { environment: 'node', include: ['tests/**/*.test.ts'] },
});
