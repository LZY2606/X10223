import { createHash } from 'node:crypto';

/**
 * 规范化 JSON：键排序、无多余空白。
 * 等价输入必须得到等价序列化结果（Uint8Array 以 hex 参与）。
 */
export function canonicalJSON(value: unknown): string {
  return JSON.stringify(cloneCanonical(value));
}

function cloneCanonical(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Uint8Array) return { __bin__: toHex(value) };
  if (Array.isArray(value)) return value.map(cloneCanonical);
  const obj = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) {
    const v = obj[key];
    if (v === undefined) continue;
    out[key] = cloneCanonical(v);
  }
  return out;
}

export function sha256Hex(...parts: Array<string | Uint8Array>): string {
  const h = createHash('sha256');
  for (const p of parts) h.update(p);
  return h.digest('hex');
}

export function shortId(kind: string, ...parts: unknown[]): string {
  return `${kind}_${sha256Hex(canonicalJSON(parts)).slice(0, 16)}`;
}

export function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

export function fromHex(hex: string): Uint8Array {
  return new Uint8Array(Buffer.from(hex, 'hex'));
}
