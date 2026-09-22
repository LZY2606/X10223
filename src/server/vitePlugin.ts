import type { Plugin } from 'vite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GelStore } from './store';
import { ProjectService } from './projectService';
import { seedSampleProject } from './seeder';
import { exportPack, importPack } from './pack';
import { encodeGrayPng } from '../core/png';
import { replay } from '../provenance/reducer';
import { projectView } from './httpServer';
import { BudgetExhaustedError, CorruptFormatError, SemanticUnresolvableError } from '../shared/diagnostic';
import type { ImageMaterial } from '../core/types';
import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * dev 同端口中间件：业务规则在服务端，浏览器只拿 JSON/PNG。
 * 数据库放在本地 data/ 目录，删除后重启即从案例包重建。
 */
export function gelApiPlugin(): Plugin {
  let service: ProjectService;
  return {
    name: 'gel-api-middleware',
    configureServer(server) {
      const dbPath = join(process.cwd(), 'data', 'gel-workbench.db');
      const store = new GelStore(dbPath);
      service = new ProjectService(store);
      seedSampleProject(service);

      server.middlewares.use(async (req, res, next) => {
        try {
          const url = new URL(req.url ?? '/', 'http://127.0.0.1');
          const p = url.pathname;
          if (!p.startsWith('/api/')) return next();

          if (p === '/api/health') return send(res, 200, { ok: true });
          if (p === '/api/projects') {
            return send(res, 200, {
              projects: store.listProjects(),
            });
          }
          if (p === '/api/import' && req.method === 'POST') {
            const buf = await readBody(req);
            const { state } = importPack(new Uint8Array(buf));
            service.persistPublic(state);
            return send(res, 200, { ok: true, projectId: state.projectId, project: projectView(state) });
          }

          const m = /^\/api\/project\/([^/]+)(?:\/(.*))?$/.exec(p);
          if (!m) return send(res, 404, { error: 'not-found' });
          const projectId = decodeURIComponent(m[1]!);
          const sub = m[2] ?? '';
          const state0 = service.load(projectId);

          if (sub === '' ) return send(res, 200, projectView(state0, url.searchParams.get('branch') ?? undefined, url.searchParams.get('at') ?? undefined));
          if (sub === 'image') {
            const image = state0.materials[state0.materialBindings.imageMaterialId] as ImageMaterial;
            res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' });
            return res.end(Buffer.from(encodeGrayPng(image.width, image.height, image.grayscale)));
          }
          if (sub === 'analyze' && req.method === 'POST') {
            const branch = url.searchParams.get('branch') ?? 'main';
            const { state } = service.runAutoAnalysis(projectId, branch);
            return send(res, 200, projectView(state, branch));
          }
          if (sub === 'recompute' && req.method === 'POST') {
            const body = await readJson(req);
            const state = service.reviseAndRecompute(projectId, body.branch ?? 'main', body.paramVersion);
            return send(res, 200, projectView(state, body.branch ?? 'main'));
          }
          if (sub === 'revise-band' && req.method === 'POST') {
            const body = await readJson(req);
            const state = service.reviseBand(projectId, body.branch ?? 'main', body.bandId, { x: body.x, y: body.y }, body.note ?? '人工拖动条带中心');
            return send(res, 200, projectView(state, body.branch ?? 'main'));
          }
          if (sub === 'revise-lane' && req.method === 'POST') {
            const body = await readJson(req);
            const state = service.reviseLaneCurve(projectId, body.branch ?? 'main', body.laneId, body.points, body.note ?? '人工修订泳道曲线');
            return send(res, 200, projectView(state, body.branch ?? 'main'));
          }
          if (sub === 'decision' && req.method === 'POST') {
            const body = await readJson(req);
            const state = service.decide(projectId, body.branch ?? 'main', body.detail);
            return send(res, 200, projectView(state, body.branch ?? 'main'));
          }
          if (sub === 'branch' && req.method === 'POST') {
            const body = await readJson(req);
            const state = service.createBranch(projectId, body.newBranchId, body.fromBranch ?? 'main');
            return send(res, 200, projectView(state, body.newBranchId));
          }
          if (sub === 'export') {
            const pack = exportPack(state0);
            res.writeHead(200, {
              'content-type': 'application/octet-stream',
              'content-disposition': `attachment; filename="${projectId}.gelpack"`,
            });
            return res.end(Buffer.from(pack));
          }
          return send(res, 404, { error: 'not-found', sub });
        } catch (e) {
          sendError(res, e);
        }
      });
    },
  };
}

function send(res: ServerResponse, code: number, body: unknown) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage, limit = 256 * 1024 * 1024): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit)
      throw new BudgetExhaustedError(`请求体超过预算 ${limit} 字节`, { name: 'request-body', limit, used: size });
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

async function readJson(req: IncomingMessage): Promise<any> {
  const buf = await readBody(req);
  return JSON.parse(buf.toString('utf8') || '{}');
}

function sendError(res: ServerResponse, e: unknown) {
  if (e instanceof BudgetExhaustedError) return send(res, 507, { error: e.code, message: e.message, budget: e.budget });
  if (e instanceof CorruptFormatError) return send(res, 422, { error: e.code, message: e.message });
  if (e instanceof SemanticUnresolvableError)
    return send(res, 409, { error: e.code, message: e.message, diagnostics: e.diagnostics });
  send(res, 500, { error: 'INTERNAL', message: (e as Error)?.message ?? String(e) });
}

void tmpdir;
