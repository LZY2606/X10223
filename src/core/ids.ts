import { createHash } from 'node:crypto';

/** 规范化 JSON：键排序，保证等价输入得到稳定摘要与稳定顺序。 */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalize).join(',') + ']';
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalize(obj[k])).join(',') + '}';
}

export function sha256Hex(value: unknown): string {
  return createHash('sha256').update(canonicalize(value)).digest('hex');
}

export function shortHash(value: unknown, len = 12): string {
  return sha256Hex(value).slice(0, len);
}

/** 材料稳定身份：类型 + 内容摘要。导出/删除/导入后保持不变。 */
export function materialId(type: string, content: unknown): string {
  return `MAT-${type}-${shortHash({ type, content }, 16)}`;
}

/** 计算节点身份：kind + 输入摘要 + 参数版本 + 父级，完全内容寻址。 */
export function nodeId(
  kind: string,
  inputDigest: string,
  paramsVersion: string,
  parents: string[],
  laneId?: string,
): string {
  return `NODE-${kind}-${shortHash({ kind, inputDigest, paramsVersion, parents, laneId: laneId ?? '' }, 16)}`;
}

/** 显示值的稳定身份：绑死 band、所用插值段与节点，重放/导入后稳定。 */
export function valueId(bandId: string, nodeIdRef: string, segmentId: string | null): string {
  return `VAL-${shortHash({ bandId, nodeIdRef, segmentId: segmentId ?? '' }, 16)}`;
}

/** 插值段稳定身份：泳道 + 端点弧长 + 端点分子量。 */
export function segmentId(laneId: string, sMin: number, sMax: number, mwLow: number, mwHigh: number): string {
  return `SEG-${shortHash({ laneId, sMin, sMax, mwLow, mwHigh }, 12)}`;
}

/** 候选条带身份：泳道 + 像素中心（像素级来源）。 */
export function candidateId(laneId: string, x: number, y: number): string {
  return `CAND-${shortHash({ laneId, x: Math.round(x * 100) / 100, y: Math.round(y * 100) / 100 }, 12)}`;
}

export function decisionId(actor: string, at: string, target: unknown, kind: string): string {
  return `DEC-${shortHash({ actor, at, target, kind }, 14)}`;
}
