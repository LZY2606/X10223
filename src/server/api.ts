import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFileSync, writeFileSync, renameSync, existsSync, rmSync } from 'node:fs';
import type { DB } from './db.js';
import { committedSeq, openDatabase } from './db.js';
import {
  appendEvent, applyDecision, exportArchive, getBlob, getMaterial, importArchive,
  insertMaterial, invalidateFrom, listMaterials, stateAsOf, currentParams,
} from './store.js';
import { eventId } from '../domain/util.js';
import { runBoundaryChecks, runNarrative, seedCasePack } from './seed.js';
import { encodePngGray8 } from '../domain/png.js';
import type { BandCenterMaterial, ImageMaterial, MwEstimateData } from '../shared/types.js';

function sendJson(res: ServerResponse, code: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(data);
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export interface ApiContext { db: DB; dbPath: string; exportPath: string }

export async function handleApi(ctx: ApiContext, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname;
  const { db } = ctx;
  try {
    if (req.method === 'GET' && path === '/api/state') {
      const seq = url.searchParams.get('seq');
      sendJson(res, 200, stateAsOf(db, seq ? Number(seq) : undefined));
      return true;
    }
    if (req.method === 'GET' && path.startsWith('/api/materials/') && path.endsWith('/pixels')) {
      const id = path.split('/')[3];
      const img = getMaterial<ImageMaterial>(db, id);
      const blob = getBlob(db, id);
      if (!img || img.kind !== 'image' || !blob) { sendJson(res, 404, { error: 'image not found' }); return true; }
      const png = encodePngGray8(img.width, img.height, blob);
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end(png);
      return true;
    }
    if (req.method === 'GET' && path.startsWith('/api/derived/') && path.endsWith('/provenance')) {
      const subjectId = decodeURIComponent(path.split('/')[3]);
      const state = stateAsOf(db);
      const row = state.derived.find((r) => r.subject_id === subjectId);
      if (!row) { sendJson(res, 404, { error: 'subject not found' }); return true; }
      const data = row.data as MwEstimateData;
      const band = getMaterial<BandCenterMaterial>(db, data.band_id);
      const cal = state.derived.find((r) => r.subject_id === `cal:${data.image_id}`);
      const ladder = listMaterials(db).find((m) => m.kind === 'ladder' && m.image_id === data.image_id && !m.id.includes('nonmono'));
      sendJson(res, 200, { row, band, calibration: cal ?? null, ladder, image: getMaterial(db, data.image_id) });
      return true;
    }
    if (req.method === 'POST' && path === '/api/events/decision') {
      const body = await readBody(req) as { subject_id: string; decision: 'accepted' | 'rejected'; reviewer?: string };
      const existing = listEventsForSubject(db, body.subject_id);
      const conflicting = existing.find((e) => (e.payload as { decision?: string }).decision && (e.payload as { decision?: string }).decision !== body.decision);
      const evt = appendEvent(db, {
        kind: 'decision',
        summary: `人工决定：${body.decision === 'accepted' ? '接受' : '否定'} ${body.subject_id}`,
        payload: { subject_id: body.subject_id, decision: body.decision, reviewer: body.reviewer ?? 'reviewer' },
        parents: [body.subject_id],
      }, (seq) => applyDecision(db, body.subject_id, body.decision, seq));
      if (conflicting) {
        appendEvent(db, {
          kind: 'conflict',
          summary: `冲突：${body.subject_id} 存在相互矛盾的人工决定，双方均保留`,
          payload: { subject_id: body.subject_id, kept: [conflicting.id, evt.id], resolution: 'contested' },
          parents: [conflicting.id, evt.id],
        }, (seq) => applyDecision(db, body.subject_id, 'contested', seq));
      }
      sendJson(res, 200, { event: evt, conflict: !!conflicting });
      return true;
    }
    if (req.method === 'POST' && path === '/api/case/run-narrative') {
      const result = runNarrative(db);
      sendJson(res, 200, result);
      return true;
    }
    if (req.method === 'POST' && path === '/api/case/boundary-checks') {
      sendJson(res, 200, runBoundaryChecks(db));
      return true;
    }
    if (req.method === 'POST' && path === '/api/case/reset') {
      resetDatabase(ctx);
      sendJson(res, 200, { ok: true, committed_seq: committedSeq(ctx.db) });
      return true;
    }
    if (req.method === 'POST' && path === '/api/export') {
      const archive = exportArchive(db);
      const tmp = `${ctx.exportPath}.tmp`;
      if (existsSync(tmp)) rmSync(tmp); // 清理上次可能半写的临时文件
      writeFileSync(tmp, JSON.stringify(archive));
      renameSync(tmp, ctx.exportPath); // 原子落盘，半写可恢复
      appendEvent(db, { kind: 'export', summary: `导出档案 ${ctx.exportPath}（含 manifest 校验和）`, payload: { path: ctx.exportPath, seq: archive.exported_seq }, parents: [] });
      sendJson(res, 200, { path: ctx.exportPath, exported_seq: archive.exported_seq });
      return true;
    }
    if (req.method === 'POST' && path === '/api/import') {
      const raw = readFileSync(ctx.exportPath);
      const report = importArchive(db, raw);
      sendJson(res, report.status === 'ok' ? 200 : 422, report);
      return true;
    }
    if (req.method === 'POST' && path === '/api/case/reimport') {
      // 删除本地数据库再导入：身份、顺序、来源关系必须保持
      const raw = readFileSync(ctx.exportPath);
      ctx.db.close();
      rmSync(ctx.dbPath, { force: true });
      ctx.db = openDatabase(ctx.dbPath);
      const report = importArchive(ctx.db, raw);
      sendJson(res, report.status === 'ok' ? 200 : 422, report);
      return true;
    }
    if (req.method === 'POST' && path === '/api/events/source-change') {
      const body = await readBody(req) as { band_id: string; delta_y: number };
      const band = getMaterial<BandCenterMaterial>(db, body.band_id);
      if (!band) { sendJson(res, 404, { error: 'band not found' }); return true; }
      const revised: BandCenterMaterial = {
        ...band, id: `${band.id}_rev${Date.now() % 100000}`,
        pixel: { x: band.pixel.x, y: band.pixel.y + body.delta_y },
        provenance: { ...band.provenance, source: 'manual', original_pixel: { ...band.pixel }, note: `人工修订：条带中心移动 ${body.delta_y}px` },
      };
      let invalidated: string[] = [];
      const evt = appendEvent(db, {
        kind: 'source-change',
        summary: `局部源改动：人工修订 ${band.id}（${body.delta_y > 0 ? '+' : ''}${body.delta_y}px）`,
        payload: { replaced: band.id, revised: revised.id },
        parents: [band.id],
      }, (seq) => {
        insertMaterial(db, revised, seq);
        invalidated = invalidateFrom(db, [band.id, revised.id], seq, eventId(seq), currentParams(db));
      });
      sendJson(res, 200, { event: evt, invalidated });
      return true;
    }
    return false;
  } catch (err) {
    sendJson(res, 500, { error: String(err) });
    return true;
  }
}

function listEventsForSubject(db: DB, subjectId: string) {
  return stateAsOf(db).events.filter((e) => e.kind === 'decision' &&
    (e.payload as { subject_id?: string }).subject_id === subjectId);
}

export function resetDatabase(ctx: ApiContext): void {
  ctx.db.close();
  rmSync(ctx.dbPath, { force: true });
  // 动态重开，避免调用方持有旧句柄
  ctx.db = openDatabase(ctx.dbPath);
  seedCasePack(ctx.db);
}
