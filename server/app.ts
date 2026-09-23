import type { IncomingMessage, ServerResponse } from 'node:http';
import { openDb } from './db';
import { Store } from './store';
import { ensureSeeded, loadCasePack } from './case-seed';
import { buildExportBundle, importBundle } from './export-import';
import { replay } from '../domain/state';
import { analyze } from '../domain/engine';
import { engineContext as mkCtx } from './case-seed';
import { makeEvent, nextSeq } from '../domain/replay';
import { GelBenchError } from '../domain/types';
import type { GelEvent } from '../domain/types';
import { branchEvents } from '../domain/replay';
import { forkBranch } from '../domain/replay';
import { stableId } from '../domain/hash';

const ROOT = process.cwd();
const DB_FILE = process.env.GEL_BENCH_DB ?? `${ROOT}/data/gelbench.db`;

export interface ApiDeps {
  store: Store;
  projectId: string;
}

export function createDeps(): ApiDeps {
  const db = openDb(DB_FILE);
  const store = new Store(db);
  const { projectId } = ensureSeeded(store, ROOT);
  return { store, projectId };
}

interface RouteCtx {
  store: Store;
  projectId: string;
  body: unknown;
  query: URLSearchParams;
}

export async function handleApi(req: IncomingMessage, res: ServerResponse, deps: ApiDeps): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  if (!url.pathname.startsWith('/api/')) return false;
  const ctx: RouteCtx = { store: deps.store, projectId: deps.projectId, body: null, query: url.searchParams };
  if (req.method === 'POST') {
    try {
      ctx.body = await readJson(req);
    } catch {
      return sendError(res, new GelBenchError('format-corrupt', '请求体不是合法 JSON（格式损坏）'));
    }
  }
  try {
    const p = url.pathname;
    if (p === '/api/state' && req.method === 'GET') return sendJson(res, buildState(ctx));
    if (p === '/api/image' && req.method === 'GET') return sendImage(ctx, res);
    if (p === '/api/case' && req.method === 'GET') return sendJson(res, loadCasePack(ROOT));
    if (p === '/api/decision' && req.method === 'POST') return sendJson(res, postDecision(ctx));
    if (p === '/api/branch' && req.method === 'POST') return sendJson(res, postBranch(ctx));
    if (p === '/api/recompute' && req.method === 'POST') return sendJson(res, postRecompute(ctx));
    if (p === '/api/archives' && req.method === 'GET') return sendJson(res, ctx.store.listArchives(ctx.projectId));
    if (p === '/api/export' && req.method === 'GET') return sendJson(res, buildExportBundle(ctx.store, ctx.projectId));
    if (p === '/api/import' && req.method === 'POST') return sendJson(res, importBundle(ctx.store, ctx.body));
    if (p === '/api/reset' && req.method === 'POST') {
      ctx.store.deleteProject(ctx.projectId);
      ensureSeeded(ctx.store, ROOT);
      return sendJson(res, { ok: true });
    }
    send(res, 404, { error: 'not-found' });
    return true;
  } catch (err) {
    return sendError(res, err);
  }
}

function postDecision(ctx: RouteCtx): unknown {
  const { branchId, verdict, chosen, reason, bandId } = ctx.body as {
    branchId: string;
    verdict: 'accepted' | 'rejected' | 'conflict';
    chosen: unknown;
    reason: string | null;
    bandId: string;
  };
  const events = ctx.store.listEvents(ctx.projectId);
  const branchEventsList = branchScopedEvents(ctx, events, branchId);
  const params = ctx.store.listParams(ctx.projectId);
  const pv = params[params.length - 1]?.version ?? null;
  const type = verdict === 'conflict' ? 'decision.conflict' : (`decision.${verdict}` as GelEvent['type']);
  const actor = verdict === 'conflict' ? 'reviewer.wang' : 'reviewer.ui';
  const event = makeEvent({
    projectId: ctx.projectId,
    branchId,
    seq: nextSeq(events),
    parentEventId: branchEventsList.at(-1)?.id ?? null,
    type,
    timestamp: Date.now(),
    actor,
    paramVersion: pv,
    payload: { resultId: bandId, verdict: verdict === 'conflict' ? 'rejected' : verdict, chosen, reason },
    summary: `界面${verdict === 'accepted' ? '接受' : verdict === 'rejected' ? '否定' : '冲突标记'}：${bandId}`
  });
  ctx.store.appendEvent(event);
  postRecompute(ctx, branchId);
  return { event: serializeEvent(event) };
}

function branchScopedEvents(ctx: RouteCtx, all: GelEvent[], branchId: string): GelEvent[] {
  const branch = ctx.store.listBranches(ctx.projectId).find((b) => b.id === branchId);
  if (!branch || !branch.parentBranchId) return all.filter((e) => e.branchId === branchId).sort((a, b) => a.seq - b.seq);
  return branchEvents(all, branch);
}

function postBranch(ctx: RouteCtx): unknown {
  const { name, forkEventId } = ctx.body as { name: string; forkEventId: string };
  const events = ctx.store.listEvents(ctx.projectId);
  const branches = ctx.store.listBranches(ctx.projectId);
  const branch = forkBranch(ctx.projectId, branches, name, 'br_main', forkEventId, Date.now());
  ctx.store.putBranch(branch);
  const event = makeEvent({
    projectId: ctx.projectId,
    branchId: branch.id,
    seq: nextSeq(events),
    parentEventId: null,
    type: 'branch.created',
    timestamp: Date.now(),
    actor: 'reviewer.ui',
    paramVersion: null,
    payload: { branch },
    summary: `界面创建分支：${name}`
  });
  ctx.store.appendEvent(event);
  return { branch };
}

function postRecompute(ctx: RouteCtx, fixedBranch?: string): unknown {
  const branchId = fixedBranch ?? ((ctx.body as { branchId?: string })?.branchId ?? 'br_main');
  const all = ctx.store.listEvents(ctx.projectId);
  const branches = ctx.store.listBranches(ctx.projectId);
  const branch = branches.find((b) => b.id === branchId);
  const scoped = branch && branch.parentBranchId ? branchEvents(all, branch) : all.filter((e) => e.branchId === branchId);
  const { state } = replay(ctx.projectId, scoped);
  const params = ctx.store.listParams(ctx.projectId);
  const pv = params[params.length - 1]?.version ?? 1;
  const basis = scoped.at(-1)!;
  const results = analyze(state, branchId, basis.id, mkCtx(ctx.store));
  for (const result of results) ctx.store.putResult(result);
  const event = makeEvent({
    projectId: ctx.projectId,
    branchId,
    seq: nextSeq(all),
    parentEventId: basis.id,
    type: 'result.computed',
    timestamp: Date.now(),
    actor: 'auto-analyzer',
    paramVersion: pv,
    payload: { resultIds: results.map((r) => r.id) },
    summary: `界面触发重算：${results.length} 个结果`
  });
  ctx.store.appendEvent(event);
  return { ok: true, count: results.length, event: serializeEvent(event) };
}

function buildState(ctx: RouteCtx): unknown {
  const project = ctx.store.getProject(ctx.projectId);
  const events = ctx.store.listEvents(ctx.projectId).map(serializeEvent);
  const branches = ctx.store.listBranches(ctx.projectId);
  if (!branches.some((b) => b.id === 'br_main')) {
    branches.unshift({ id: 'br_main', projectId: ctx.projectId, name: '主线审阅', parentBranchId: null, forkEventId: null, createdAt: project?.created_at ?? 0 });
  }
  const materials = ctx.store.listMaterials(ctx.projectId);
  const image = materials.find((m) => m.kind === 'image') as { sha256: string; widthPx: number; heightPx: number } | undefined;
  const params = ctx.store.listParams(ctx.projectId).sort((a, b) => a.version - b.version);
  const resultBranch = ctx.query.get('branch') ?? 'br_main';
  const results = ctx.store.listResults(ctx.projectId, resultBranch);
  const archives = ctx.store.listArchives(ctx.projectId);
  return {
    project: project ? { id: project.id, name: project.name, createdAt: project.created_at, casepackVersion: project.casepack_version } : null,
    image: image ? { sha256: image.sha256, width: image.widthPx, height: image.heightPx, url: `/api/image?sha=${image.sha256}` } : null,
    materials,
    params,
    branches,
    events,
    results,
    resultBranch,
    archives
  };
}

function sendImage(ctx: RouteCtx, res: ServerResponse): boolean {
  const sha = ctx.query.get('sha');
  if (!sha) {
    send(res, 400, { error: 'missing sha' });
    return true;
  }
  const blob = ctx.store.getImage(sha);
  if (!blob) {
    send(res, 404, { error: 'image not found' });
    return true;
  }
  res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' });
  res.end(Buffer.from(blob.bytes));
  return true;
}

export function serializeEvent(e: GelEvent): unknown {
  return { ...e };
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, data: unknown): boolean {
  send(res, 200, data);
  return true;
}

function sendError(res: ServerResponse, err: unknown): boolean {
  if (err instanceof GelBenchError) {
    const code = err.failure === 'format-corrupt' ? 422 : err.failure === 'budget-exhausted' ? 507 : 422;
    send(res, code, { failure: err.failure, error: err.message, diagnostics: err.diagnostics });
    return true;
  }
  send(res, 500, { error: (err as Error).message });
  return true;
}

function send(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(data));
}
