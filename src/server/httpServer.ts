import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { GelStore } from './store';
import { ProjectService } from './projectService';
import { seedSampleProject, SAMPLE_PROJECT_ID } from './seeder';
import { exportPack, importPack } from './pack';
import { encodeGrayPng } from '../core/png';
import type { ProjectState } from '../provenance/reducer';
import { replay } from '../provenance/reducer';
import { BudgetExhaustedError, CorruptFormatError, SemanticUnresolvableError } from '../shared/diagnostic';
import type { ImageMaterial } from '../core/types';

export interface ServerHandle {
  close: () => void;
  service: ProjectService;
  port: number;
}

export function startApiServer(dbPath: string, port = 5342): ServerHandle {
  const store = new GelStore(dbPath);
  const service = new ProjectService(store);
  seedSampleProject(service);

  const server = createServer((req, res) => {
    void handle(req, res, service).catch((e) => sendError(res, e));
  });
  server.listen(port, '127.0.0.1');
  return { close: () => server.close(), service, port };
}

async function readBody(req: IncomingMessage, limitBytes = 256 * 1024 * 1024): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limitBytes)
      throw new BudgetExhaustedError(`请求体超过预算 ${limitBytes} 字节`, {
        name: 'request-body',
        limit: limitBytes,
        used: size,
      });
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

function json(res: ServerResponse, code: number, body: unknown) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

async function handle(req: IncomingMessage, res: ServerResponse, service: ProjectService) {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const p = url.pathname;
  const method = req.method ?? 'GET';

  if (p === '/api/health') return json(res, 200, { ok: true, service: 'gel-ladder-workbench' });
  if (p === '/api/projects' && method === 'GET') {
    return json(res, 200, {
      projects: service.getStore().listProjects(),
      sampleProjectId: SAMPLE_PROJECT_ID,
    });
  }
  if (p === '/api/import' && method === 'POST') {
    const buf = await readBody(req);
    const { state } = importPack(new Uint8Array(buf));
    service.persistPublic(state);
    return json(res, 200, { ok: true, projectId: state.projectId, project: projectView(state) });
  }

  const projMatch = /^\/api\/project\/([^/]+)(?:\/(.*))?$/.exec(p);
  if (projMatch) {
    const projectId = decodeURIComponent(projMatch[1]!);
    const sub = projMatch[2] ?? '';
    return await routeProject(req, res, service, method, projectId, sub, url);
  }
  return json(res, 404, { error: 'not-found', path: p });
}

async function routeProject(
  req: IncomingMessage,
  res: ServerResponse,
  service: ProjectService,
  method: string,
  projectId: string,
  sub: string,
  url: URL,
) {
  if (sub === '' && method === 'GET') {
    const state = service.load(projectId);
    return json(
      res,
      200,
      projectView(
        state,
        url.searchParams.get('branch') ?? undefined,
        url.searchParams.get('at') ?? undefined,
      ),
    );
  }
  if (sub === 'image' && method === 'GET') {
    const state = service.load(projectId);
    const image = state.materials[state.materialBindings.imageMaterialId] as ImageMaterial;
    res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' });
    return res.end(Buffer.from(encodeGrayPng(image.width, image.height, image.grayscale)));
  }
  if (sub === 'analyze' && method === 'POST') {
    const branch = url.searchParams.get('branch') ?? 'main';
    const { state } = service.runAutoAnalysis(projectId, branch);
    return json(res, 200, projectView(state, branch));
  }
  if (sub === 'recompute' && method === 'POST') {
    const body = JSON.parse((await readBody(req)).toString('utf8') || '{}') as {
      branch?: string;
      paramVersion: string;
    };
    const state = service.reviseAndRecompute(projectId, body.branch ?? 'main', body.paramVersion);
    return json(res, 200, projectView(state, body.branch ?? 'main'));
  }
  if (sub === 'revise-band' && method === 'POST') {
    const body = JSON.parse((await readBody(req)).toString('utf8')) as {
      branch?: string;
      bandId: string;
      x: number;
      y: number;
      note?: string;
    };
    const state = service.reviseBand(
      projectId,
      body.branch ?? 'main',
      body.bandId,
      { x: body.x, y: body.y },
      body.note ?? '人工拖动条带中心',
    );
    return json(res, 200, projectView(state, body.branch ?? 'main'));
  }
  if (sub === 'revise-lane' && method === 'POST') {
    const body = JSON.parse((await readBody(req)).toString('utf8')) as {
      branch?: string;
      laneId: string;
      points: { x: number; y: number }[];
      note?: string;
    };
    const state = service.reviseLaneCurve(
      projectId,
      body.branch ?? 'main',
      body.laneId,
      body.points,
      body.note ?? '人工修订泳道曲线',
    );
    return json(res, 200, projectView(state, body.branch ?? 'main'));
  }
  if (sub === 'decision' && method === 'POST') {
    const body = JSON.parse((await readBody(req)).toString('utf8')) as {
      branch?: string;
      detail: Parameters<ProjectService['decide']>[2];
    };
    const state = service.decide(projectId, body.branch ?? 'main', body.detail);
    return json(res, 200, projectView(state, body.branch ?? 'main'));
  }
  if (sub === 'branch' && method === 'POST') {
    const body = JSON.parse((await readBody(req)).toString('utf8')) as {
      newBranchId: string;
      fromBranch?: string;
    };
    const state = service.createBranch(projectId, body.newBranchId, body.fromBranch ?? 'main');
    return json(res, 200, projectView(state, body.newBranchId));
  }
  if (sub === 'export' && method === 'GET') {
    const state = service.load(projectId);
    const pack = exportPack(state);
    res.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-disposition': `attachment; filename="${projectId}.gelpack"`,
    });
    return res.end(Buffer.from(pack));
  }
  return json(res, 404, { error: 'not-found', sub });
}

export function projectView(state: ProjectState, branchId?: string, atEventId?: string) {
  const effective = atEventId ? replay(state, atEventId) : state;
  const bid = branchId ?? effective.headBranchId;
  const branch = effective.branches.get(bid) ?? effective.branches.get('main')!;
  const image = effective.materials[effective.materialBindings.imageMaterialId] as ImageMaterial | undefined;
  const ladder = effective.materials[effective.materialBindings.ladderMaterialId];
  return {
    projectId: effective.projectId,
    name: effective.name,
    createdAt: effective.createdAt,
    branchId: bid,
    branchOrder: effective.branchOrder,
    image: image
      ? {
          materialId: image.materialId,
          width: image.width,
          height: image.height,
          orientation: image.orientation,
          exposure: image.exposure,
          origin: image.origin,
        }
      : null,
    ladder,
    lanes: branch.lanes,
    bands: branch.bands,
    analysis: branch.latestAnalysis
      ? {
          snapshotId: branch.latestAnalysis.snapshotId,
          producerEventId: branch.latestAnalysis.producerEventId,
          adopted: branch.latestAnalysis.adopted,
          result: branch.latestAnalysis.result,
        }
      : null,
    adopted: branch.adopted,
    decisions: branch.decisions,
    conflicts: branch.conflicts,
    paramVersion: branch.paramVersion,
    events: effective.events.map((e) => ({
      eventId: e.eventId,
      seq: e.seq,
      branchId: e.branchId,
      type: e.type,
      timestamp: e.timestamp,
      paramVersion: e.paramVersion,
      parents: e.parents,
      selfHash: e.selfHash.slice(0, 12),
      payloadSummary: summarizePayload(e.payload),
      judgment: e.type === 'evidence-judgment' ? (e.payload.judgment as unknown) : undefined,
    })),
    judgments: effective.events
      .filter((e) => e.type === 'evidence-judgment')
      .map((e) => e.payload.judgment),
  };
}

function summarizePayload(payload: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(payload)) {
    if (k === 'snapshot') out[k] = '(analysis-snapshot)';
    else if (k === 'image') out[k] = '(raw-image-material)';
    else if (k === 'lanes') out[k] = `(${(v as unknown[]).length} lanes)`;
    else if (k === 'bands') out[k] = `(${(v as unknown[]).length} bands)`;
    else out[k] = v;
  }
  return out;
}

function sendError(res: ServerResponse, e: unknown) {
  if (e instanceof BudgetExhaustedError)
    return json(res, 507, { error: e.code, message: e.message, budget: e.budget });
  if (e instanceof CorruptFormatError)
    return json(res, 422, { error: e.code, message: e.message, detail: String(e.detail ?? '') });
  if (e instanceof SemanticUnresolvableError)
    return json(res, 409, { error: e.code, message: e.message, diagnostics: e.diagnostics });
  const message = (e as Error)?.message ?? String(e);
  json(res, 500, { error: 'INTERNAL', message });
}
