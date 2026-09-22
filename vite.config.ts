import { defineConfig } from 'vite';
import { createApiMiddleware } from './server/app';

export default defineConfig({
  plugins: [
    {
      name: 'gel-workbench-api',
      configureServer(server) {
        server.middlewares.use('/api', createApiMiddleware());
      },
    },
  ],
});
