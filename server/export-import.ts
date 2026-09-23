import type { AnalysisResult, BranchInfo, GelEvent, Material, ParamSet } from '../domain/types';
import { GelBenchError } from '../domain/types';
import { canonicalize, sha256Hex } from '../domain/hash';
import type { Store } from './store';

/**
 * 导出包是单个 JSON：原始图像字节 base64 内嵌，全部 id/seq/parent 原样保留。
 * manifest.checksum 覆盖除 checksum 外全部内容，导入先校验 => 格式损坏在落库前被拒。
 */

export interface ExportBundle {
  format: 'gel-bench-bundle';
  schemaVersion: 1;
  project: { id: string; name: string; createdAt: number; casepackVersion: string | null };
  images: { sha256: string; width: number; height: number; base64: string }[];
  materials: Material[];
  params: ParamSet[];
  branches: BranchInfo[];
  events: GelEvent[];
  results: AnalysisResult[];
  manifest: { exportedAt: number; checksum?: string };
}

export function buildExportBundle(store: Store, projectId: string): ExportBundle {
  const project = store.getProject(projectId);
  if (!project) throw new GelBenchError('semantic-unresolvable', `项目不存在：${projectId}`);
  const materials = store.listMaterials(projectId);
  const imageShas = new Set(
    materials.filter((m) => m.kind === 'image').map((m) => (m as { sha256: string }).sha256)
  );
  const images = [...imageShas].map((sha) => {
    const blob = store.getImage(sha);
    if (!blob) throw new GelBenchError('semantic-unresolvable', `导出时缺少图像字节 ${sha}`);
    return { sha256: sha, width: blob.width, height: blob.height, base64: Buffer.from(blob.bytes).toString('base64') };
  });
  const bundle: ExportBundle = {
    format: 'gel-bench-bundle',
    schemaVersion: 1,
    project: {
      id: project.id,
      name: project.name,
      createdAt: project.created_at,
      casepackVersion: project.casepack_version
    },
    images,
    materials,
    params: store.listParams(projectId),
    branches: store.listBranches(projectId),
    events: store.listEvents(projectId),
    results: store.listResults(projectId),
    manifest: { exportedAt: Date.now() }
  };
  bundle.manifest.checksum = checksum(bundle);
  return bundle;
}

export function checksum(bundle: ExportBundle): string {
  const copy = structuredClone(bundle);
  delete copy.manifest.checksum;
  return sha256Hex(canonicalize(copy));
}

export interface ImportOptions {
  /** 故障注入：在 intent 写入后、数据落库前“崩溃”（半写） */
  crashAfterIntent?: boolean;
  /** 故障注入：数据写入后、置 committed 前“崩溃”（事务回滚） */
  crashBeforeCommit?: boolean;
  now?: () => number;
}

export function importBundle(store: Store, raw: unknown, options: ImportOptions = {}): { projectId: string; recovered: boolean } {
  const bundle = parseBundle(raw);
  const projectId = bundle.project.id;
  if (store.getProject(projectId)) {
    throw new GelBenchError('semantic-unresolvable', `项目 ${projectId} 已存在，导入会覆盖身份，已拒绝`);
  }
  const now = options.now ?? Date.now;
  const intentId = `intent_${projectId}_${now()}`;

  store.db
    .prepare('INSERT INTO commit_intents(id, project_id, kind, status, created_at) VALUES(?,?,?,?,?)')
    .run(intentId, projectId, 'import', 'open', now());

  if (options.crashAfterIntent) {
    throw new GelBenchError('budget-exhausted', '【故障注入】intent 已写、数据未落库（模拟进程被杀）');
  }

  const tx = store.db.transaction(() => {
    store.createProject(bundle.project.id, bundle.project.name, bundle.project.createdAt, bundle.project.casepackVersion);
    for (const img of bundle.images) {
      store.putImage(img.sha256, new Uint8Array(Buffer.from(img.base64, 'base64')), img.width, img.height);
    }
    for (const material of bundle.materials) store.putMaterial(material);
    for (const param of bundle.params) store.putParam(param);
    for (const branch of bundle.branches) store.putBranch(branch);
    for (const event of bundle.events) store.appendEvent(event);
    for (const result of bundle.results) store.putResult(result);
    if (options.crashBeforeCommit) {
      throw new GelBenchError('budget-exhausted', '【故障注入】数据已写但未置 committed（模拟提交前崩溃）');
    }
    store.db.prepare('UPDATE commit_intents SET status = ?, finished_at = ? WHERE id = ?').run('committed', now(), intentId);
  });
  tx();
  return { projectId, recovered: false };
}

export function parseBundle(raw: unknown): ExportBundle {
  if (typeof raw !== 'object' || raw === null) {
    throw new GelBenchError('format-corrupt', '导出包不是 JSON 对象');
  }
  const bundle = raw as ExportBundle;
  if (bundle.format !== 'gel-bench-bundle') {
    throw new GelBenchError('format-corrupt', `格式标识错误：${String(bundle.format)}（格式损坏，拒绝导入）`);
  }
  if (bundle.schemaVersion !== 1) {
    throw new GelBenchError('format-corrupt', `不支持的 schemaVersion：${String(bundle.schemaVersion)}`);
  }
  const claimed = bundle.manifest?.checksum;
  if (!claimed) {
    throw new GelBenchError('format-corrupt', '导出包缺少 checksum（格式损坏）');
  }
  if (checksum(bundle) !== claimed) {
    throw new GelBenchError('format-corrupt', 'checksum 不匹配：导出包已被截断或篡改（格式损坏）');
  }
  for (const event of bundle.events) {
    if (typeof event.seq !== 'number' || !event.id || !event.branchId) {
      throw new GelBenchError('format-corrupt', `事件缺少身份字段：${JSON.stringify(event).slice(0, 120)}`);
    }
  }
  const seqs = new Set<string>();
  for (const e of bundle.events) {
    const key = `${e.branchId}:${e.seq}`;
    if (seqs.has(key)) throw new GelBenchError('format-corrupt', `事件序号冲突：${key}`);
    seqs.add(key);
  }
  if (!Array.isArray(bundle.materials) || !Array.isArray(bundle.events)) {
    throw new GelBenchError('format-corrupt', '导出包缺少 materials/events 数组');
  }
  return bundle;
}
