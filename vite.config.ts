import { defineConfig, type Plugin } from 'vite';
import { createApiMiddleware } from './src/server/api';

function gelApi(): Plugin {
  return {
    name: 'gel-api',
    configureServer(server) {
      server.middlewares.use('/api', createApiMiddleware());
    },
  };
}

export default defineConfig({
  plugins: [gelApi()],
  test: { include: ['tests/**/*.test.ts'] },
} as never);
