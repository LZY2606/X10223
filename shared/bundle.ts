/**
 * 项目导出/导入包（单文件、离线、无云端）。
 * 包内含：事件历史（含分支与决定）、图像二进制（sha256 寻址）、重放校验摘要、
 * 机器可读反例档案。导入时重放并重算 digest，与存储的派生记录比对 ——
 * 身份、顺序与来源关系必须保持；不一致即 FORMAT_CORRUPT / SEMANTIC_UNRESOLVABLE。
 */
import { hashJson } from './hash';
import { deriveAtNode, replay } from './events';
import {
  FormatCorruptError,
  ResourceBudgetError,
  SemanticUnresolvableError,
  diag,
  type Diagnostic
} from './diagnostics';
import type { CounterexampleRecord, Event } from './types';
import { BUDGETS } from './types';

export const BUNDLE_FORMAT = 'gel-ruler-bundle/1';

export interface ImageBlob {
  sha256: string;
  mediaType: string;
  /** base64 原始字节；导入保留原始表示。 */
  base64: string;
  byteLength: number;
}

export interface Bundle {
  format: typeof BUNDLE_FORMAT;
  projectId: string;
  name: string;
  exportedAt: string;
  events: Event[];
  images: ImageBlob[];
  counterexamples: CounterexampleRecord[];
  /** 每个 derivationRecorded 的期望 digest（重放校验）。 */
  replayChecks: { eventId: string; digest: string }[];
}

export function bundleDigest(bundle: Bundle): string {
  return hashJson({
    format: bundle.format,
    projectId: bundle.projectId,
    events: bundle.events.map((e) => e.id),
    images: bundle.images.map((i) => ({ sha: i.sha256, n: i.byteLength })),
    checks: bundle.replayChecks
  });
}

export function validateBundleShape(raw: unknown): { ok: true; bundle: Bundle } | { ok: false; diagnostics: Diagnostic[] } {
  const ds: Diagnostic[] = [];
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, diagnostics: [diag('FORMAT_CORRUPT', '/', '导出包不是 JSON 对象')] };
  }
  const b = raw as Partial<Bundle>;
  if (b.format !== BUNDLE_FORMAT) ds.push(diag('FORMAT_CORRUPT', '/format', `未知格式: ${String(b.format)}`));
  if (!Array.isArray(b.events) || b.events.length === 0) ds.push(diag('FORMAT_CORRUPT', '/events', '事件缺失或为空'));
  if (!Array.isArray(b.images)) ds.push(diag('FORMAT_CORRUPT', '/images', '图像清单缺失'));
  if (b.events && b.events.length > BUDGETS.maxEvents) {
    return {
      ok: false,
      diagnostics: [diag('RESOURCE_BUDGET', '/events', `事件数超过预算 ${BUDGETS.maxEvents}`)]
    };
  }
  if (b.events) {
    const ids = new Set<string>();
    for (const [i, e] of b.events.entries()) {
      if (!e || typeof (e as Event).id !== 'string' || typeof (e as Event).kind !== 'string') {
        ds.push(diag('FORMAT_CORRUPT', `/events/${i}`, '事件结构损坏'));
        continue;
      }
      if (ids.has((e as Event).id)) ds.push(diag('FORMAT_CORRUPT', `/events/${i}`, `重复事件身份 ${(e as Event).id}`));
      ids.add((e as Event).id);
    }
  }
  if (b.images) {
    for (const [i, img] of b.images.entries()) {
      if (!img || typeof img.sha256 !== 'string' || typeof img.base64 !== 'string') {
        ds.push(diag('FORMAT_CORRUPT', `/images/${i}`, '图像条目损坏'));
      } else if (img.byteLength !== undefined && img.byteLength > BUDGETS.maxImageBytes) {
        return { ok: false, diagnostics: [diag('RESOURCE_BUDGET', `/images/${i}`, '图像超出资源预算')] };
      }
    }
  }
  if (ds.length) return { ok: false, diagnostics: ds };
  return { ok: true, bundle: raw as Bundle };
}

export interface ImportResult {
  events: Event[];
  images: ImageBlob[];
  counterexamples: CounterexampleRecord[];
  replayMismatches: { eventId: string; stored: string; recomputed: string }[];
}

/**
 * 导入：结构校验 -> 重放事件图 -> 对每个 derivation 重算并比对 digest。
 *  - 结构/哈希问题 -> FORMAT_CORRUPT
 *  - 事件图无法形成合法语义（环、未知父节点、重放 digest 不一致）-> SEMANTIC_UNRESOLVABLE
 *  - 超大包 -> RESOURCE_BUDGET（在 shape 阶段即返回）
 */
export function importBundle(raw: unknown): ImportResult {
  const shape = validateBundleShape(raw);
  if (!shape.ok) {
    const code = shape.diagnostics[0]!.code;
    if (code === 'RESOURCE_BUDGET') {
      throw new ResourceBudgetError('RESOURCE_BUDGET', '导入包超出资源预算', shape.diagnostics);
    }
    throw new FormatCorruptError('FORMAT_CORRUPT', '导出包结构损坏', shape.diagnostics);
  }
  const bundle = shape.bundle;

  const known = new Set(bundle.events.map((e) => e.id));
  for (const e of bundle.events) {
    if (e.parentId !== null && !known.has(e.parentId)) {
      throw new SemanticUnresolvableError('SEMANTIC_UNRESOLVABLE', `事件 ${e.id} 引用了未知父节点`, [
        diag('SEMANTIC_UNRESOLVABLE', `/events/${e.id}/parentId`, '父事件不在包内')
      ]);
    }
  }

  let state;
  try {
    state = replay(bundle.events);
  } catch (err) {
    throw new SemanticUnresolvableError('SEMANTIC_UNRESOLVABLE', `事件图无法重放: ${(err as Error).message}`);
  }

  const replayMismatches: ImportResult['replayMismatches'] = [];
  for (const check of bundle.replayChecks) {
    const node = state.byId.get(check.eventId);
    if (!node) {
      throw new SemanticUnresolvableError('SEMANTIC_UNRESOLVABLE', `重放校验引用未知事件 ${check.eventId}`);
    }
    const recomputed = deriveAtNode(node).digest;
    if (recomputed !== check.digest) {
      replayMismatches.push({ eventId: check.eventId, stored: check.digest, recomputed });
    }
  }
  if (replayMismatches.length) {
    throw new SemanticUnresolvableError(
      'SEMANTIC_UNRESOLVABLE',
      `重放得到的派生结果与导出时不一致（${replayMismatches.length} 处），身份/来源关系可能已被破坏`,
      replayMismatches.map((m) =>
        diag('SEMANTIC_UNRESOLVABLE', `/events/${m.eventId}`, `digest 不一致 stored=${m.stored.slice(0, 8)} recomputed=${m.recomputed.slice(0, 8)}`, 'error', [m.eventId])
      )
    );
  }

  return {
    events: bundle.events,
    images: bundle.images,
    counterexamples: bundle.counterexamples ?? [],
    replayMismatches
  };
}
