import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { Store } from './store.ts';
import { loadCasePack, runCasePack } from '../domain/casepack.ts';
import { runPipeline } from '../domain/engine.ts';
import { SCENARIO_SPECS } from '../domain/scenarios.ts';
import { PARAMS_V1, type ParamSet } from '../domain/types.ts';

type Next = () => void;
export type Handler = (req: IncomingMessage, res: ServerResponse, next: Next) => void;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(text);
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      if (chunks.length === 0) return resolve(undefined);
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('invalid json body'));
      }
    });
    req.on('error', reject);
  });
}

export function createApiHandler(store: Store, casepackPath: string): Handler {
  const state = (upTo?: number) => {
    const seq = upTo ?? store.latestSeq();
    return {
      title: '胶道标尺：电泳条带、泳道弯曲与分子量校准工作台',
      seq,
      latestSeq: store.latestSeq(),
      materials: store.listMaterials(),
      events: store.eventsUpTo(seq),
      results: store.resultsUpTo(seq),
      branches: store.branches(),
      scenarios: SCENARIO_SPECS,
    };
  };

  return (req, res, next) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    if (!path.startsWith('/api/')) return next();
    const method = req.method ?? 'GET';

    const run = async () => {
      if (method === 'GET' && path === '/api/state') {
        const at = url.searchParams.get('at');
        return sendJson(res, 200, state(at ? Number(at) : undefined));
      }
      if (method === 'GET' && path === '/api/scenarios') {
        return sendJson(res, 200, SCENARIO_SPECS);
      }
      if (method === 'POST' && path === '/api/seed') {
        store.reset();
        const report = runCasePack(store, loadCasePack(casepackPath));
        return sendJson(res, 200, { report, state: state() });
      }
      if (method === 'POST' && path === '/api/compute') {
        const body = (await readBody(req)) as { params?: Partial<ParamSet>; branch?: string } | undefined;
        const params: ParamSet = { ...PARAMS_V1, ...(body?.params ?? {}) };
        const materials = store.listMaterials();
        const imageMat = materials.filter((m) => m.kind === 'gel_image').sort((a, b) => b.seq - a.seq)[0];
        const image = imageMat ? store.imageAccess(imageMat.id) : undefined;
        const pipeline = runPipeline(materials, params, image, body?.branch ?? 'main');
        const seq = store.latestSeq() + 1;
        store.putResults(pipeline.results, seq);
        store.appendEvent('candidates.generated', {
          params_version: params.version,
          outcome: pipeline.outcome.kind,
          result_ids: pipeline.results.map((r) => r.id),
          diagnostics: pipeline.diagnostics,
        }, materials.map((m) => m.id), body?.branch ?? 'main');
        return sendJson(res, 200, { pipeline, state: state() });
      }
      if (method === 'POST' && path === '/api/events') {
        const body = (await readBody(req)) as { type: string; payload: unknown; parents?: string[]; branch?: string };
        if (!body?.type) return sendJson(res, 400, { error: 'type required' });
        const event = store.appendEvent(body.type as never, body.payload, body.parents ?? [], body.branch ?? 'main');
        return sendJson(res, 200, { event, state: state() });
      }
      if (method === 'GET' && path === '/api/export') {
        const bundle = store.exportBundle();
        store.appendEvent('snapshot.exported', { digest: bundle.digest }, []);
        return sendJson(res, 200, bundle);
      }
      if (method === 'POST' && path === '/api/import') {
        const body = await readBody(req);
        const outcome = store.importBundle(body);
        if (outcome.kind === 'ok') {
          store.appendEvent('snapshot.imported', { digest: (body as { digest?: string }).digest }, []);
        }
        return sendJson(res, outcome.kind === 'ok' ? 200 : 422, { outcome, state: state() });
      }
      if (method === 'GET' && path.startsWith('/api/image/')) {
        const id = decodeURIComponent(path.slice('/api/image/'.length));
        const blob = store.getBlob(id);
        if (!blob) return sendJson(res, 404, { error: 'no such image' });
        res.writeHead(200, { 'content-type': 'image/png' });
        return res.end(blob);
      }
      if (method === 'GET' && path.startsWith('/api/results/')) {
        const id = decodeURIComponent(path.slice('/api/results/'.length));
        const result = store.currentResults().find((r) => r.id === id);
        if (!result) return sendJson(res, 404, { error: 'no such result' });
        const parents = store.listMaterials().filter((m) => result.parents.includes(m.id));
        const ruler = store.currentResults().find(
          (r) => r.kind === 'ruler' && (r.value as { lane_index?: number }).lane_index ===
            (result.value as { lane_index?: number }).lane_index);
        return sendJson(res, 200, { result, parents, ruler });
      }
      if (method === 'GET' && path === '/api/casepack') {
        return sendJson(res, 200, JSON.parse(readFileSync(casepackPath, 'utf8')));
      }
      sendJson(res, 404, { error: `no route: ${method} ${path}` });
    };

    run().catch((err) => sendJson(res, 500, { error: String(err) }));
  };
}
