/** HTTP API：业务规则全部在服务端，存储层与规则可被测试直接调用。 */
import express, { type Express } from 'express';
import { MW_PARAMS_V1, MW_PARAMS_V2 } from '../shared/infer.js';
import { TransferError } from '../shared/types.js';
import type { GelStore } from './db.js';
import { recomputeMW } from './recompute.js';
import { seedBaseline } from './seed.js';
import { runBoundaryScenarios } from './scenario.js';
import { bandTrace, projectState } from './view.js';

export function createApp(store: GelStore): Express {
  const app = express();
  app.use(express.json({ limit: '16mb' }));
  app.use(express.text({ type: 'application/gel-bundle', limit: '16mb' }));

  app.get('/api/project', (_req, res) => {
    res.json(projectState(store));
  });

  app.get('/api/image/:id', (req, res) => {
    const img = store.objectById(req.params.id);
    if (!img || img.kind !== 'gel-image') return res.status(404).json({ error: 'image not found' });
    res.json(img);
  });

  app.get('/api/bands/:bandId/trace', (req, res) => {
    const seq = req.query.seq ? Number(req.query.seq) : undefined;
    res.json(bandTrace(store, req.params.bandId, seq));
  });

  app.get('/api/events/:id/view', (req, res) => {
    const evt = store.eventById(req.params.id);
    if (!evt) return res.status(404).json({ error: 'event not found' });
    const { buildView } = require('./view.js') as typeof import('./view.js');
    res.json({ event: evt, computations: buildView(store, evt.seq) });
  });

  app.post('/api/decisions', (req, res) => {
    const { computationId, action, branch, note } = req.body ?? {};
    if (!computationId || !['accept', 'reject', 'adjust'].includes(action)) {
      return res.status(400).json({ error: '需要 computationId 与 action(accept|reject|adjust)' });
    }
    const comp = store.computations().find((c) => c.id === computationId);
    if (!comp) return res.status(404).json({ error: 'computation not found' });
    const evt = store.appendEvent(
      `decision.${action}`,
      {
        ruleId: `review/manual-${action}`,
        statement: `人工${action === 'accept' ? '接受' : action === 'reject' ? '否定' : '调整'}计算 ${computationId}`,
        inputs: [computationId],
        affected: [computationId],
        adopted: action !== 'reject',
        rationaleCode: `manual-${action}`,
        targetId: computationId,
        action,
        note: note ?? null
      },
      [computationId],
      branch ?? 'main'
    );
    res.json({ event: evt });
  });

  app.post('/api/recompute', (req, res) => {
    const version = req.body?.paramVersion;
    const params = version === MW_PARAMS_V1.version ? MW_PARAMS_V1 : MW_PARAMS_V2;
    const r = recomputeMW(store, params);
    store.appendEvent('compute.recomputed', {
      ruleId: 'compute/manual-recompute',
      statement: `按参数 ${params.version} 重算`,
      inputs: [],
      affected: r.inserted.map((c) => c.id),
      adopted: true,
      rationaleCode: 'manual-recompute',
      detail: { inserted: r.inserted.length, skipped: r.skippedUnchanged.length }
    });
    res.json({ inserted: r.inserted.length, skipped: r.skippedUnchanged.length, superseded: r.superseded.length });
  });

  app.get('/api/export', (_req, res) => {
    const bundle = store.exportBundle();
    res.setHeader('content-type', 'application/gel-bundle');
    res.setHeader('content-disposition', 'attachment; filename="gel-project.gel.json"');
    res.send(JSON.stringify(bundle));
  });

  app.post('/api/import', (req, res) => {
    const raw = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
    try {
      const result = store.importBundle(raw);
      res.json({ ok: true, ...result });
    } catch (err) {
      if (err instanceof TransferError) {
        return res.status(422).json({ ok: false, kind: err.kind, message: err.message, position: err.position ?? null });
      }
      res.status(500).json({ ok: false, kind: 'internal', message: String(err) });
    }
  });

  app.post('/api/reset', (_req, res) => {
    for (const table of ['objects', 'events', 'computations', 'import_staging']) {
      (store as any).db.exec(`DELETE FROM ${table}`);
    }
    (store as any).db.exec(`UPDATE seq_counter SET value = 0 WHERE id = 1`);
    seedBaseline(store);
    runBoundaryScenarios(store);
    res.json({ ok: true, seq: store.currentSeq() });
  });

  return app;
}
