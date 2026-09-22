import type { Plugin } from 'vite';
import { PARAM_V1, PARAM_V2 } from '../domain/params';
import {
  doExport,
  doImport,
  getState,
  projectImage,
  projectView,
} from './services';

function send(res: any, status: number, body: unknown, type = 'application/json') {
  res.statusCode = status;
  res.setHeader('content-type', type);
  const payload = type === 'application/json' ? JSON.stringify(body) : (body as Buffer);
  res.end(payload);
}

async function readBody(req: any): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    let data = '';
    req.on('data', (c: Buffer) => {
      data += c.toString('utf8');
      if (data.length > 250 * 1024 * 1024) reject(new Error('too large'));
    });
    req.on('end', () => resolvePromise(data));
    req.on('error', reject);
  });
}

export function gelApiPlugin(): Plugin {
  return {
    name: 'gel-bench-api',
    configureMiddleware(server) {
      server.middlewares.use('/api', async (req, res) => {
        try {
          const url = new URL(req.url!, 'http://127.0.0.1');
          const { store, engine, seedInfo } = getState();
          const path = url.pathname;

          if (req.method === 'GET' && path === '/api/health') return send(res, 200, { ok: true });

          if (req.method === 'GET' && path === '/api/projects') {
            const projects = store.listProjects();
            return send(res, 200, { projects, seedInfo });
          }

          if (req.method === 'GET' && path.startsWith('/api/projects/')) {
            const rest = path.replace('/api/projects/', '');
            const seg = rest.split('/');
            const projectId = decodeURIComponent(seg[0]!);
            if (seg[1] === 'image' && seg[2]) {
              const img = projectImage(projectId, seg[2]);
              if (!img) return send(res, 404, { error: 'image not found' });
              res.statusCode = 200;
              res.setHeader('content-type', 'image/png');
              res.setHeader('cache-control', 'no-store');
              return res.end(img.bytes);
            }
            const atEvent = url.searchParams.get('atEvent') ?? undefined;
            const view = projectView(projectId, atEvent);
            if (!view) return send(res, 404, { error: 'project not found' });
            return send(res, 200, view);
          }

          if (req.method === 'POST' && path.startsWith('/api/projects/')) {
            const rest = path.replace('/api/projects/', '');
            const seg = rest.split('/');
            const projectId = decodeURIComponent(seg[0]!);
            const action = seg[1];
            const body = JSON.parse((await readBody(req)) || '{}');

            if (action === 'analyze') {
              const r = engine.runAutoAnalysis(projectId, { acceptedAlignment: body.acceptedAlignment, branch: body.branch });
              return send(res, 200, { event: r.event, diagnostics: r.diagnostics, derived: r.derived.map(stripDerived) });
            }
            if (action === 'accept') {
              const ev = engine.acceptCandidate(projectId, body.bandId, body.alignmentIndex);
              return send(res, 200, { event: ev });
            }
            if (action === 'reject') {
              const ev = engine.rejectCandidate(projectId, body.bandId, body.reason ?? '');
              return send(res, 200, { event: ev });
            }
            if (action === 'revise') {
              const v = body.version === PARAM_V1.version ? PARAM_V1.version : PARAM_V2.version;
              const ev = engine.reviseParameters(projectId, v, body.note ?? '参数修订');
              return send(res, 200, { event: ev });
            }
            if (action === 'edit-band') {
              const r = engine.manualEditBand(projectId, body.logicalBandId, body.center, body.frameId);
              return send(res, 200, r);
            }
            if (action === 'conflict') {
              const r = engine.conflictingDecision(projectId, body.bandId, body.secondAction ?? 'reject', body.branch ?? 'human-alt');
              return send(res, 200, r);
            }
            if (action === 'checkout') {
              const ev = engine.checkoutView(projectId, body.eventId);
              return send(res, 200, { event: ev });
            }
            if (action === 'replace-lane') {
              const moved = engine.shiftLaneTrace(projectId, body.logicalLaneId, body.shift ?? { y: 6 });
              const ev = engine.replaceSingleSource({
                projectId,
                kind: 'lane_trace',
                logicalId: body.logicalLaneId,
                newMaterial: moved,
                reason: body.reason ?? '人工修订 lane 曲线',
                affectedSubjects: [body.logicalLaneId],
              });
              return send(res, 200, { event: ev });
            }
            return send(res, 404, { error: `unknown action ${action}` });
          }

          if (req.method === 'GET' && path === '/api/export') {
            const projectId = url.searchParams.get('projectId')!;
            const bundle = doExport(projectId);
            res.statusCode = 200;
            res.setHeader('content-type', 'application/json');
            res.setHeader('content-disposition', `attachment; filename="gel-project-${projectId.slice(0, 10)}.json"`);
            return res.end(JSON.stringify(bundle));
          }

          if (req.method === 'POST' && path === '/api/import') {
            const text = await readBody(req);
            const simulateCrashAt = url.searchParams.get('crash') ? Number(url.searchParams.get('crash')) : undefined;
            const outcome = doImport(text, text.length, simulateCrashAt);
            return send(res, outcome.outcome === 'imported' ? 200 : 422, outcome);
          }

          return send(res, 404, { error: `no route for ${path}` });
        } catch (e) {
          return send(res, 500, { error: (e as Error).message, stack: (e as Error).stack });
        }
      });
    },
  };
}

function stripDerived(d: any) {
  return { ...d, inputSummary: { ...d.inputSummary, materialHashes: undefined } };
}
