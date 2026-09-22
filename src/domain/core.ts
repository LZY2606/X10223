import { createHash, randomUUID } from 'node:crypto';

/** 稳定身份：同一材料/决定/计算跨导出导入保持不变 */
export function newId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

/** 规范化 JSON（键排序），用于输入摘要 */
export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`).join(',')}}`;
}

export function digestOf(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

/** 诊断：带位置，绝不用空值/默认值伪装成功 */
export interface Diagnostic {
  code: string;
  message: string;
  location?: Location;
}

export interface Location {
  objectType?: string;
  objectId?: string;
  frame?: CoordFrame;
  x?: number;
  y?: number;
  field?: string;
}

/** 三种必须区分的失败结果 */
export type FailureKind = 'budget_exhausted' | 'format_corrupt' | 'semantic_unsolvable';

export interface Failure {
  kind: FailureKind;
  diagnostics: Diagnostic[];
}

export type Result<T> = { ok: true; value: T } | { ok: false; failure: Failure };

export function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}
export function fail<T>(kind: FailureKind, diagnostics: Diagnostic[]): Result<T> {
  return { ok: false, failure: { kind, diagnostics } };
}

/** 坐标基准：image = 原始像素坐标（保留来源），analysis = 方向归一化后的派生坐标 */
export type CoordFrame = 'image' | 'analysis';

export interface PixelPoint {
  x: number;
  y: number;
  frame: CoordFrame;
}

/** 领域量必须携带单位 */
export interface Quantity {
  value: number;
  unit: 'bp' | 'kDa' | 'px' | 'ms' | 'log10bp';
}

/** 分子量估计：点 / 区间（饱和、拖尾、重叠只允许候选或区间）/ 失效 */
export type MwEstimate =
  | { kind: 'point'; logMw: number; mw: Quantity; segment: [number, number] }
  | { kind: 'interval'; loMw: Quantity; hiMw: Quantity; reason: string }
  | { kind: 'invalid'; diagnostic: Diagnostic };

export const PARAM_VERSION = 'gel-scale/1.0.0';
