import { createHash } from 'node:crypto';

/** 规范化 JSON：键排序，保证等价输入得到等价摘要与稳定顺序。 */
export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonical(obj[k])).join(',') + '}';
}

export function sha256(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

export function digestOf(value: unknown): string {
  return sha256(canonical(value));
}

export function eventId(seq: number): string {
  return `evt-${String(seq).padStart(6, '0')}`;
}

/** 旋转/方向变换：把某方向坐标系下的像素点换算回 as-captured 坐标系。 */
export function toCapturedFrame(
  p: { x: number; y: number },
  orientation: string,
  width: number,
  height: number
): { x: number; y: number } {
  switch (orientation) {
    case 'rotated-90': return { x: p.y, y: width - 1 - p.x };
    case 'rotated-180': return { x: width - 1 - p.x, y: height - 1 - p.y };
    case 'rotated-270': return { x: height - 1 - p.y, y: p.x };
    default: return { x: p.x, y: p.y };
  }
}
