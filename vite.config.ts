import { defineConfig, type Plugin } from 'vite';
import { handleApiRequest } from './src/server/api';

function gelApiPlugin(): Plugin {
  return {
    name: 'gel-ruler-api',
    configureServer(server) {
      server.middlewares.use('/api', (req, res) => {
        handleApiRequest(req, res).catch((err) => {
          res.statusCode = 500;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ ok: false, error: String(err) }));
        });
      });
    },
  };
}

export default defineConfig({
  plugins: [gelApiPlugin()],
});
