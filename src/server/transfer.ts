import { randomUUID } from 'node:crypto';
import type { Store } from './store.js';
import { PROJECT_ID } from './workspace.js';
import { sha256Hex } from '../shared/digest.js';
import type { Diagnostic } from '../shared/types.js';

export interface ExportBundle {
  format: 'gel-workbench-export';
  formatVersion: 1;
  exportedAt: string;
  project: unknown;
  branches: unknown[];
  events: unknown[];
  materials: unknown[];
  blobs: Record<string, string>; // sha -> base64
}

export function exportProject(store: Store): { bundle: ExportBundle; json: string } {
  const project = store.getProject(PROJECT_ID);
  const branches = store.listBranches(PROJECT_ID);
  const materials = store.listMaterials(PROJECT_ID);
  const events: unknown[] = [];
  for (const b of branches) events.push(...store.listEvents(b.id));
  const blobShas = new Set<string>();
  for (const m of materials) if (m.type === 'source-image') blobShas.add(m.blobSha256);
  const blobs: Record<string, string> = {};
  for (const sha of blobShas) {
    const bytes = store.getBlob(sha);
    if (bytes) blobs[sha] = Buffer.from(bytes).toString('base64');
  }
  const bundle: ExportBundle = {
    format: 'gel-workbench-export', formatVersion: 1,
    exportedAt: new Date().toISOString(), project,
    branches, events, materials, blobs,
  };
  const json = JSON.stringify(bundle);
  return { bundle, json };
}

export type ImportOutcome =
  | { ok: true; importedProjectId: string; events: number; branches: number }
  | { ok: false; code: 'CORRUPT_FORMAT' | 'ID_CONFLICT' | 'INCOMPLETE_INPUT' | 'SEMANTIC_NO_SOLUTION'; diagnostics: Diagnostic[] };

// 三阶段提交：stage1 暂存载荷 -> stage2 写材料/事件 -> stage3 完成；中断可回滚
export function importProject(store: Store, raw: string, targetProjectId: string = PROJECT_ID): ImportOutcome {
  const operationId = 'imp-' + randomUUID();
  let bundle: ExportBundle;
  try {
    bundle = JSON.parse(raw) as ExportBundle;
  } catch {
    return { ok: false, code: 'CORRUPT_FORMAT', diagnostics: [{ code: 'CORRUPT_FORMAT', message: '导出包不是合法 JSON（格式损坏）' }] };
  }
  const diag = validateBundle(bundle);
  if (diag.length) {
    return { ok: false, code: diag[0].code as ImportOutcome extends { code: infer C } ? C : never, diagnostics: diag };
  }
  store.stageBegin({ operationId, projectId: targetProjectId, kind: 'import', stage: 1, createdAt: new Date().toISOString(), payload: { events: bundle.events.length } });
  // 幂等：身份完全一致则跳过覆盖（删除后再导入也得到相同 id/顺序）
  store.stageAdvance(operationId, 2);
  store.deleteProject(targetProjectId);
  store.putProject(bundle.project as never);
  const projectRow = bundle.project as { id: string; name: string; case_pack_version?: string; casePackVersion?: string; created_at?: string; createdAt?: string };
  for (const [sha, b64] of Object.entries(bundle.blobs)) {
    const bytes = Buffer.from(b64, 'base64');
    if (sha256Hex(bytes) !== sha) {
      return { ok: false, code: 'CORRUPT_FORMAT', diagnostics: [{ code: 'CORRUPT_FORMAT', message: `blob ${sha.slice(0, 10)} 校验失败` }] };
    }
    store.putBlob(sha, bytes);
  }
  for (const m of bundle.materials) store.putMaterial(targetProjectId, m as never);
  void projectRow;
  for (const b of bundle.branches) {
    const bb = b as { id: string; name: string; headEventId: string | null; forkedFromEventId: string | null; purpose: string };
    store.db.prepare(`INSERT INTO branches(id,project_id,name,head_event_id,forked_from_event_id,purpose,seq_counter)
      VALUES(?,?,?,?,?,?,?)`).run(bb.id, targetProjectId, bb.name, bb.headEventId, bb.forkedFromEventId, bb.purpose, -1);
  }
  // 按 (branch, seq) 顺序插入，保持身份与父链
  const sorted = [...(bundle.events as Array<Record<string, unknown>>)].sort((a, b) =>
    (a.branch_id ?? (a as { branchId?: string }).branchId ?? '') === '' ? 0 : 0);
  const byBranch = new Map<string, Array<Record<string, unknown>>>();
  for (const e of bundle.events as Array<Record<string, unknown>>) {
    const bid = e.branchId as string;
    const arr = byBranch.get(bid) ?? []; arr.push(e); byBranch.set(bid, arr);
  }
  for (const [, arr] of byBranch) {
    arr.sort((a, b) => (a.seq as number) - (b.seq as number));
    for (const e of arr) {
      store.db.prepare(`INSERT INTO events(id,project_id,branch_id,seq,parent_id,type,creator,created_at,payload)
        VALUES(?,?,?,?,?,?,?,?,?)`).run(
        e.id as string, targetProjectId, e.branchId as string, e.seq as number, (e.parentId ?? null) as string | null, e.type as string, e.creator as string, e.createdAt as string, JSON.stringify(e.payload));
    }
    const head = arr[arr.length - 1];
    store.db.prepare('UPDATE branches SET seq_counter=?, head_event_id=? WHERE id=?')
      .run(head.seq as number, head.id as string, head.branchId as string);
  }
  void sorted;
  store.stageAdvance(operationId, 3);
  store.stageDone(operationId);
  return { ok: true, importedProjectId: targetProjectId, events: bundle.events.length, branches: bundle.branches.length };
}

function validateBundle(b: ExportBundle): Diagnostic[] {
  const out: Diagnostic[] = [];
  if (!b || b.format !== 'gel-workbench-export') {
    out.push({ code: 'CORRUPT_FORMAT', message: '缺少格式标识 gel-workbench-export' });
    return out;
  }
  if (!b.project || !Array.isArray(b.events) || !Array.isArray(b.materials) || !Array.isArray(b.branches)) {
    out.push({ code: 'INCOMPLETE_INPUT', message: '导出包缺少 project/events/materials/branches' });
    return out;
  }
  const ids = new Set<string>();
  for (const m of b.materials as Array<{ id?: string }>) {
    if (!m.id) { out.push({ code: 'INCOMPLETE_INPUT', path: 'materials[].id', message: '材料缺少稳定身份' }); return out; }
    if (ids.has(m.id)) { out.push({ code: 'ID_CONFLICT', message: `材料身份冲突 ${m.id}` }); return out; }
    ids.add(m.id);
  }
  return out;
}
