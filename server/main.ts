import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { createDeps, handleApi } from './app';

const PORT = Number(process.env.PORT ?? 5342);
const HOST = '127.0.0.1';
const ROOT = process.cwd();
const deps = createDeps();

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.ts': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.json': 'application/json'
};

const server = createServer(async (req, res) => {
  if (await handleApi(req, res, deps)) return;
  let path = new URL(req.url ?? '/', `http://${HOST}`).pathname;
  if (path === '/') path = '/index.html';
  const file = normalize(join(ROOT, path));
  if (!file.startsWith(ROOT)) {
    res.writeHead(403);
    res.end('forbidden');
    return;
  }
  try {
    const data = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found (dev: 用 npm run dev 启动 Vite)');
  }
});

server.listen(PORT, HOST, () => {
  console.log(`胶道标尺工作台: http://${HOST}:${PORT}`);
});
