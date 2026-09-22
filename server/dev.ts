/** 开发入口：单进程同时提供 API 与 Vite 前端（middleware 模式）。 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer as createViteServer } from 'vite';
import { createApp } from './app.js';
import { GelStore } from './db.js';
import { seedBaseline } from './seed.js';
import { runBoundaryScenarios } from './scenario.js';

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const host = argValue('--host') ?? '127.0.0.1';
const port = Number(argValue('--port') ?? 5342);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dbPath = process.env.GEL_DB ?? path.join(root, 'data', 'gel.db');
const store = new GelStore(dbPath);
if (store.events().length === 0) {
  seedBaseline(store);
  runBoundaryScenarios(store);
  console.log(`[gel] 案例包已播种：${store.events().length} 个事件，${store.computations().length} 条计算`);
}

const app = createApp(store);
const vite = await createViteServer({ root, server: { middlewareMode: true }, appType: 'spa' });
app.use(vite.middlewares);
app.listen(port, host, () => {
  console.log(`[gel] 审阅页: http://${host}:${port}`);
});
