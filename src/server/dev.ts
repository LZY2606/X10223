import { createServer } from 'node:http';
import { mkdirSync } from 'node:fs';
import { createServer as createViteServer } from 'vite';
import { openDatabase, committedSeq } from './db.js';
import { handleApi, type ApiContext } from './api.js';
import { seedCasePack } from './seed.js';

function argValue(name: string, def: string): string {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const host = argValue('--host', '127.0.0.1');
const port = Number(argValue('--port', '5342'));

mkdirSync('data', { recursive: true });
const dbPath = process.env.GEL_DB ?? 'data/gel.db';
const ctx: ApiContext = { db: openDatabase(dbPath), dbPath, exportPath: 'data/export.json' };
if (committedSeq(ctx.db) === 0) {
  seedCasePack(ctx.db);
  console.log('[gel] 案例包已导入：图像 A/B、ladder、lane 边界、条带中心、非单调反例');
}

const vite = await createViteServer({
  server: { middlewareMode: true },
  appType: 'custom',
  logLevel: 'warn',
});

const server = createServer((req, res) => {
  const url = req.url ?? '/';
  if (url.startsWith('/api/')) {
    void handleApi(ctx, req, res).then((handled) => {
      if (!handled) { res.writeHead(404); res.end('not found'); }
    });
    return;
  }
  vite.middlewares(req, res, () => {
    res.writeHead(404);
    res.end('not found');
  });
});

server.listen(port, host, () => {
  console.log(`[gel] 审阅页: http://${host}:${port}`);
});
