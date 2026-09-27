import { defineConfig } from 'vite';
import { openDb, seedIfEmpty } from './server/db';
import { createApi } from './server/app';

export default defineConfig({
  plugins: [
    {
      name: 'gel-ruler-api',
      configureServer(server) {
        const db = openDb(process.env.GEL_DB ?? 'data/gel.db');
        seedIfEmpty(db);
        server.middlewares.use('/api', createApi(db));
      },
    },
  ],
});
