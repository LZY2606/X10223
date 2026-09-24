import { defineConfig } from 'vite';
import { GelService } from './src/server/service';
import { createApiMiddleware } from './src/server/middleware';

export default defineConfig({
  plugins: [
    {
      name: 'gel-ruler-api',
      configureServer(server) {
        const svc = new GelService(process.env.APP_DB ?? 'data/app.db');
        svc.recover();
        svc.seedIfEmpty();
        server.middlewares.use(createApiMiddleware(svc));
      },
    },
  ],
  server: { strictPort: true },
  test: { environment: 'node', include: ['tests/**/*.test.ts'] },
});
