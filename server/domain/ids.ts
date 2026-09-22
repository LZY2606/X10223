import { createHash } from 'node:crypto';

// 规范化 JSON（键排序），保证等价输入得到等价摘要与稳定顺序。
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortDeep((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export function hashContent(value: unknown): string {
  return sha256(canonicalJson(value));
}

export function materialId(caseId: string, kind: string, name: string, version: number): string {
  return `mat_${caseId}_${kind}_${name}_v${version}`;
}

export function computationId(kind: string, subject: string, inputDigest: string): string {
  return `cmp_${sha256(`${kind}|${subject}|${inputDigest}`).slice(0, 24)}`;
}

export function eventId(seq: number, type: string, payloadDigest: string): string {
  return `evt_${seq}_${type}_${payloadDigest.slice(0, 12)}`;
}

export function decisionId(caseId: string, seq: number, targetId: string, action: string): string {
  return `dec_${caseId}_${seq}_${sha256(`${targetId}|${action}`).slice(0, 10)}`;
}

// 确定性伪随机数（样例图像噪声用），保证种子相同则图像逐字节一致。
export function makePrng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0xffffffff;
  };
}
