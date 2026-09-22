import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { createApiHandler } from './server/app';

export default defineConfig({
  plugins: [
    react(),
    {
      name: 'gel-ruler-api',
      configureServer(server) {
        const handler = createApiHandler();
        server.middlewares.use('/api', (req, res) => {
          void handler(req, res);
        });
      },
    },
  ],
});
