import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Store } from './store.js';
import { seedStore, PROJECT_ID } from './workspace.js';
import { computeAt } from './replay-compute.js';
import { exportProject, importProject } from './transfer.js';
import type { EventType } from '../shared/types.js';

export interface ApiDeps {
  store: Store;
  ensureSeeded: () => void;
}

async function readBody(req: IncomingMessage, limit = 64 * 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) { reject(new Error('payload too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

export async function handleApi(deps: ApiDeps, req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const { store, ensureSeeded } = deps;
  const path = url.pathname;

  if (path === '/api/health') { json(res, 200, { ok: true }); return true; }

  if (path === '/api/reset' && req.method === 'POST') {
    const interrupted = store.recoverInterrupted();
    seedStore(store, { force: true });
    json(res, 200, { ok: true, recovered: interrupted });
    return true;
  }

  if (path === '/api/project') {
    ensureSeeded();
    json(res, 200, { project: store.getProject(PROJECT_ID), branches: store.listBranches(PROJECT_ID) });
    return true;
  }

  if (path === '/api/materials') {
    ensureSeeded();
    json(res, 200, { materials: store.listMaterials(PROJECT_ID) });
    return true;
  }

  if (path.startsWith('/api/image/')) {
    ensureSeeded();
    const sha = decodeURIComponent(path.slice('/api/image/'.length));
    const bytes = store.getBlob(sha);
    if (!bytes) { json(res, 404, { error: 'blob not found' }); return true; }
    res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'immutable' });
    res.end(Buffer.from(bytes));
    return true;
  }

  if (path === '/api/branch') {
    ensureSeeded();
    const branchId = url.searchParams.get('id')!;
    const upto = url.searchParams.get('seq');
    const events = store.listEvents(branchId);
    const compute = computeAt(store, branchId, upto ? Number(upto) : undefined);
    json(res, 200, { branch: store.getBranch(branchId), events, compute: serializeCompute(compute) });
    return true;
  }

  if (path === '/api/event' && req.method === 'POST') {
    ensureSeeded();
    const body = JSON.parse(await readBody(req)) as { branchId: string; type: EventType; payload: unknown };
    const ev = store.appendEvent(PROJECT_ID, body.branchId, body.type, body.payload as never);
    json(res, 200, { event: ev });
    return true;
  }

  if (path === '/api/fork' && req.method === 'POST') {
    ensureSeeded();
    const body = JSON.parse(await readBody(req)) as { newBranchId: string; name: string; purpose: string; sourceBranchId: string; uptoEventId: string };
    const branch = store.forkBranch(PROJECT_ID, body.newBranchId, body.name, body.purpose, body.sourceBranchId, body.uptoEventId);
    json(res, 200, { branch });
    return true;
  }

  if (path === '/api/export') {
    ensureSeeded();
    const { json: body } = exportProject(store);
    res.writeHead(200, {
      'content-type': 'application/json',
      'content-disposition': 'attachment; filename="gel-workbench-export.json"',
    });
    res.end(body);
    return true;
  }

  if (path === '/api/import' && req.method === 'POST') {
    ensureSeeded();
    const raw = await readBody(req);
    const outcome = importProject(store, raw, PROJECT_ID);
    json(res, outcome.ok ? 200 : 422, outcome);
    return true;
  }

  if (path === '/api/recover' && req.method === 'POST') {
    const interrupted = store.recoverInterrupted();
    json(res, 200, { recovered: interrupted, log: store.getMeta('recovery-log') });
    return true;
  }

  if (path === '/api/simulate-halfwrite' && req.method === 'POST') {
    // 故意制造一个停在 stage=1 的暂存操作，验证“半写恢复”
    store.stageBegin({
      operationId: 'imp-simulated-crash', projectId: PROJECT_ID, kind: 'import',
      stage: 1, createdAt: new Date().toISOString(), payload: { simulated: true },
    });
    json(res, 200, { ok: true, message: '已制造停在 stage=1 的半写操作，重启或调用 /api/recover 可回滚' });
    return true;
  }

  return false;
}

function serializeCompute(c: ReturnType<typeof computeAt>) {
  return {
    nodes: c.nodes,
    diagnostics: c.diagnostics,
    calibration: c.calibration,
    bandResults: c.bandResults,
    rotatedSize: c.rotatedSize,
    laneViewPoints: c.laneViewPoints,
    profiles: c.profiles,
    peaks: c.peaks,
    paramsVersion: c.paramsVersion,
    imageSha256: c.imageSha256,
    events: c.events.map((e) => ({ id: e.id, seq: e.seq, type: e.type, parentId: e.parentId, payload: e.payload })),
  };
}
