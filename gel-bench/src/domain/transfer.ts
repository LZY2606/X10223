import { Store } from '../storage/store';
import { canonical, contentId, sha256Hex } from './ids';
import type { DecisionEvent, DerivedRecord, Material } from './types';

export interface ExportBundle {
  bundleFormat: 'gel-bench-export/1';
  project: {
    id: string;
    name: string;
    kind: string;
    spec: Record<string, unknown>;
  };
  materials: Material[];
  events: DecisionEvent[];
  derived: DerivedRecord[];
  branches: { branch: string; headEventId: string | null; seqLast: number }[];
  materialLinks: Record<
    string,
    { logicalId: string; createdEventId: string | null; supersededBy: string | null; supersededEventId: string | null }
  >;
  blobs: { sha256: string; format: string; base64: string }[];
  exportedOrder: { materials: string[]; events: string[]; derived: string[] };
  digest: string;
}

export type ImportOutcome =
  | { outcome: 'imported'; projectId: string; events: number; materials: number; derived: number }
  | { outcome: 'format_corrupt'; diagnostics: { message: string; jsonPath?: string }[] }
  | { outcome: 'semantic_no_solution'; diagnostics: { message: string; jsonPath?: string }[] }
  | { outcome: 'budget_exhausted'; diagnostics: { message: string; budget: string }[] };

const BUDGETS = { maxBytes: 200 * 1024 * 1024, maxEvents: 200_000, maxMaterials: 200_000 };

/** 导出：不可变材料 + 事件链 + 派生记录 + blob 全部打包，身份原样保留 */
export function exportProject(store: Store, projectId: string, opts: { failAfter?: number } = {}): ExportBundle {
  const project = store.getProject(projectId);
  if (!project) throw new Error(`PROJECT_NOT_FOUND:${projectId}`);
  const materials = store.listMaterialsCurrent(projectId).concat(
    // 历史版本也导出（被取代的旧材料），保证分支/决定历史可重放
    historicalVersions(store, projectId)
  );
  const dedup = new Map<string, Material>();
  for (const m of materials) dedup.set(m.id, m);
  const allMats = [...dedup.values()];
  const events = store.listEvents(projectId);
  const derived = store.listDerivedAll(projectId);

  const blobShas = new Set<string>();
  for (const m of allMats) if (m.type === 'image') blobShas.add(m.blobSha256);
  const blobs = [...blobShas].map((sha) => {
    const blob = store.getBlob(sha)!;
    return { sha256: sha, format: blob.format, base64: blob.bytes.toString('base64') };
  });

  // 故障注入：模拟导出写到一半进程崩溃（半写恢复测试）
  if (opts.failAfter !== undefined) {
    throw new HalfWriteError(`EXPORT_HALF_WRITE:after=${opts.failAfter}`);
  }

  const links = collectMaterialLinks(store, projectId);
  const body: Omit<ExportBundle, 'digest'> = {
    bundleFormat: 'gel-bench-export/1',
    project: { id: project.id, name: project.name, kind: project.kind, spec: project.spec },
    materials: allMats.sort((a, b) => a.createdAtLogical - b.createdAtLogical || a.id.localeCompare(b.id)),
    events: events.sort((a, b) => a.logicalClock - b.logicalClock || a.id.localeCompare(b.id)),
    derived,
    branches: store.listBranches(projectId).map((br) => ({ branch: br, ...store.getHead(projectId, br) })),
    materialLinks: links,
    blobs,
    exportedOrder: {
      materials: allMats.map((m) => m.id),
      events: events.map((e) => e.id),
      derived: derived.map((d) => `${d.id}@${d.atEventId}`),
    },
  };
  const digest = sha256Hex(canonical(body));
  return { ...body, digest };
}

function historicalVersions(store: Store, projectId: string): Material[] {
  // SQLite 直接取所有行（含被取代版本）
  const rows = (store as unknown as {
    db: { prepare: (sql: string) => { all: (...a: unknown[]) => { body_json: string }[] } };
  }).db
    .prepare(`SELECT body_json FROM materials WHERE project_id=? ORDER BY logical_clock`)
    .all(projectId);
  return rows.map((r) => JSON.parse(r.body_json) as Material);
}

export class HalfWriteError extends Error {}

function collectMaterialLinks(store: Store, projectId: string): ExportBundle['materialLinks'] {
  const rows = (store as unknown as {
    db: { prepare: (sql: string) => { all: (...a: unknown[]) => Record<string, unknown>[] } };
  }).db
    .prepare(
      `SELECT id, logical_id, created_event_id, superseded_by, superseded_event_id FROM materials WHERE project_id=?`
    )
    .all(projectId);
  const out: ExportBundle['materialLinks'] = {};
  for (const r of rows) {
    out[r.id as string] = {
      logicalId: (r.logical_id as string) ?? (r.id as string),
      createdEventId: (r.created_event_id as string | null) ?? null,
      supersededBy: (r.superseded_by as string | null) ?? null,
      supersededEventId: (r.superseded_event_id as string | null) ?? null,
    };
  }
  return out;
}

/** 解析并校验导出包：区分 格式损坏 / 语义无解 / 预算耗尽 三种结果 */
export function parseBundle(jsonText: string, bytesLen: number):
  | { ok: true; bundle: ExportBundle }
  | { ok: false; outcome: Exclude<ImportOutcome, { outcome: 'imported' }> } {
  if (bytesLen > BUDGETS.maxBytes) {
    return {
      ok: false,
      outcome: {
        outcome: 'budget_exhausted',
        diagnostics: [{ message: `导出包 ${bytesLen} 字节超过预算 ${BUDGETS.maxBytes}`, budget: 'maxBytes' }],
      },
    };
  }
  let bundle: ExportBundle;
  try {
    bundle = JSON.parse(jsonText) as ExportBundle;
  } catch (e) {
    return {
      ok: false,
      outcome: {
        outcome: 'format_corrupt',
        diagnostics: [{ message: `JSON 解析失败：${(e as Error).message}`, jsonPath: '$' }],
      },
    };
  }
  const corrupt = validateShape(bundle);
  if (corrupt.length) return { ok: false, outcome: { outcome: 'format_corrupt', diagnostics: corrupt } };

  if (bundle.events.length > BUDGETS.maxEvents || bundle.materials.length > BUDGETS.maxMaterials) {
    return {
      ok: false,
      outcome: {
        outcome: 'budget_exhausted',
        diagnostics: [{ message: '事件/材料数量超过资源预算', budget: 'maxEvents|maxMaterials' }],
      },
    };
  }

  // 摘要校验（半写会破坏 digest）
  const { digest, ...body } = bundle;
  if (sha256Hex(canonical(body)) !== digest) {
    return {
      ok: false,
      outcome: {
        outcome: 'format_corrupt',
        diagnostics: [{ message: '导出摘要不一致：文件半写或被截断', jsonPath: '$.digest' }],
      },
    };
  }

  const semantic = validateSemantics(bundle);
  if (semantic.length) return { ok: false, outcome: { outcome: 'semantic_no_solution', diagnostics: semantic } }

  return { ok: true, bundle };
}

function validateShape(b: Partial<ExportBundle>) {
  const errs: { message: string; jsonPath?: string }[] = [];
  if (b.bundleFormat !== 'gel-bench-export/1') errs.push({ message: 'bundleFormat 不匹配', jsonPath: '$.bundleFormat' });
  if (!b.project || typeof b.project.id !== 'string') errs.push({ message: '缺少 project.id', jsonPath: '$.project.id' });
  if (!Array.isArray(b.materials)) errs.push({ message: 'materials 必须是数组', jsonPath: '$.materials' });
  if (!Array.isArray(b.events)) errs.push({ message: 'events 必须是数组', jsonPath: '$.events' });
  if (!Array.isArray(b.derived)) errs.push({ message: 'derived 必须是数组', jsonPath: '$.derived' });
  if (!Array.isArray(b.blobs)) errs.push({ message: 'blobs 必须是数组', jsonPath: '$.blobs' });
  for (const [i, m] of (b.materials ?? []).entries()) {
    if (!m || typeof (m as Material).id !== 'string' || !(m as Material).type) {
      errs.push({ message: `材料 #${i} 缺 id/type`, jsonPath: `$.materials[${i}]` });
    }
  }
  for (const [i, e] of (b.events ?? []).entries()) {
    if (!e || typeof (e as DecisionEvent).id !== 'string' || !(e as DecisionEvent).type) {
      errs.push({ message: `事件 #${i} 缺 id/type`, jsonPath: `$.events[${i}]` });
    }
  }
  return errs;
}

/** 语义校验：ladder 标称单调、事件父链闭合、派生输入依赖可解析 */
function validateSemantics(b: ExportBundle) {
  const errs: { message: string; jsonPath?: string }[] = [];
  const eventIds = new Set(b.events.map((e) => e.id));
  for (const e of b.events) {
    if (e.parentId && !eventIds.has(e.parentId)) {
      errs.push({ message: `事件 ${e.id} 的父事件缺失，历史链断裂`, jsonPath: '$.events' });
    }
  }
  for (const m of b.materials) {
    if (m.type === 'ladder_nominal') {
      for (let i = 1; i < m.bands.length; i++) {
        if (!(m.bands[i]!.molecularWeight.value < m.bands[i - 1]!.molecularWeight.value)) {
          errs.push({
            message: `导入包内 ladder ${m.name} 标称非单调（rank ${m.bands[i - 1]!.rank}），语义无解`,
            jsonPath: `$.materials[?@.id='${m.id}'].bands`,
          });
        }
      }
    }
  }
  const matIds = new Set(b.materials.map((m) => m.id));
  for (const d of b.derived) {
    for (const mid of d.inputSummary.materialIds) {
      if (!matIds.has(mid)) {
        errs.push({ message: `派生结果 ${d.id} 依赖的材料 ${mid} 不在包内`, jsonPath: '$.derived' });
      }
    }
  }
  return errs;
}

/**
 * 导入：在单个 SQLite savepoint 中写入，身份/分支/顺序原样恢复。
 * simulateCrashAt 在写入若干步后抛错 -> 回滚（半写恢复，库恢复到导入前）。
 */
export function importBundle(
  store: Store,
  bundle: ExportBundle,
  opts: { newProjectId?: string; simulateCrashAt?: number } = {}
): ImportOutcome {
  const projectId = opts.newProjectId ?? bundle.project.id;
  const journal = store.journalStart(projectId, 'import', null);
  const db = (store as unknown as { db: { exec: (s: string) => void } }).db;
  db.exec('SAVEPOINT import_bundle');
  try {
    let steps = 0;
    const tick = () => {
      steps++;
      if (opts.simulateCrashAt !== undefined && steps >= opts.simulateCrashAt) throw new HalfWriteError('IMPORT_HALF_WRITE');
    };
    for (const blob of bundle.blobs) {
      tick();
      store.putBlob(Buffer.from(blob.base64, 'base64'), blob.format);
    }
    tick();
    store.insertProjectRaw({
      id: projectId,
      name: bundle.project.name,
      kind: bundle.project.kind,
      headEventId: null,
      createdLogical: Math.min(...bundle.events.map((e) => e.logicalClock), 1),
      spec: bundle.project.spec,
    });
    for (const e of bundle.events) {
      tick();
      store.appendEventRaw({ ...e, projectId });
      store.bumpClock(e.logicalClock);
    }
    for (const m of bundle.materials) {
      tick();
      const link = bundle.materialLinks?.[m.id];
      store.putMaterial({ ...m, projectId }, m.branch ?? 'main', null, link?.logicalId ?? m.id, m.createdAtLogical);
      store.setMaterialLinks(
        projectId,
        m.id,
        link?.createdEventId ?? null,
        link?.supersededBy ?? null,
        link?.supersededEventId ?? null,
        link?.logicalId ?? m.id
      );
    }
    for (const d of bundle.derived) {
      tick();
      store.putDerived({ ...d, projectId });
    }
    for (const br of bundle.branches) {
      tick();
      store.setHead(projectId, br.branch, br.headEventId, br.seqLast);
    }
    db.exec('RELEASE SAVEPOINT import_bundle');
    store.journalFinish(journal, 'committed');
    return {
      outcome: 'imported',
      projectId,
      events: bundle.events.length,
      materials: bundle.materials.length,
      derived: bundle.derived.length,
    };
  } catch (e) {
    db.exec('ROLLBACK TO SAVEPOINT import_bundle');
    db.exec('RELEASE SAVEPOINT import_bundle');
    store.journalFinish(journal, 'rolled_back');
    if (e instanceof HalfWriteError) {
      return { outcome: 'format_corrupt', diagnostics: [{ message: '写入中途失败，事务已回滚（半写恢复）', jsonPath: '$' }] };
    }
    throw e;
  }
}

export { contentId };
