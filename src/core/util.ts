import { createHash } from 'node:crypto';
import type { PxPoint, PxPolyline, PhysicalQuantity } from './types';

/** 规范化 JSON：键排序、稳定编码，用于等价输入得到稳定身份/顺序。 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortValue((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  if (value instanceof Uint8Array) return { __bytes__: bytesToHex(value) };
  return value;
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function sha256Hex(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex');
}

/** 材料稳定身份：mat-<12hex>，由内容规范化哈希决定，导入/导出保持一致。 */
export function stableMaterialId(kind: string, payload: unknown): string {
  return `mat-${kind}-${sha256Hex(canonicalJson({ kind, payload })).slice(0, 12)}`;
}

export function hashMaterial(payload: unknown): string {
  return sha256Hex(canonicalJson(payload));
}

/** 事件稳定身份：ev-<branch>-<seq>-<10hash>，重放/导入保持一致。 */
export function stableEventId(branch: string, seq: number, payload: unknown): string {
  return `ev-${branch}-${seq.toString().padStart(5, '0')}-${sha256Hex(
    canonicalJson({ branch, seq, payload })
  ).slice(0, 10)}`;
}

// ---------- 几何：沿折线的弧长 ----------

export function polylineLength(line: PxPolyline): number {
  let total = 0;
  for (let i = 1; i < line.points.length; i++) {
    total += distance(line.points[i - 1], line.points[i]);
  }
  return total;
}

export function distance(a: PxPoint, b: PxPoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** 从起点累积弧长数组（与 points 等长）。 */
export function cumulativeArc(line: PxPolyline): number[] {
  const arcs = [0];
  for (let i = 1; i < line.points.length; i++) {
    arcs.push(arcs[i - 1] + distance(line.points[i - 1], line.points[i]));
  }
  return arcs;
}

/** 在给定弧长处取折线上的点（线性插值）。 */
export function pointAtArc(line: PxPolyline, arc: number): PxPoint {
  const pts = line.points;
  if (pts.length === 0) throw new Error('empty polyline');
  const arcs = cumulativeArc(line);
  if (arc <= 0) return { ...pts[0], basis: 'raw-image-px' };
  const total = arcs[arcs.length - 1];
  if (arc >= total) return { ...pts[pts.length - 1], basis: 'raw-image-px' };
  for (let i = 1; i < pts.length; i++) {
    if (arc <= arcs[i]) {
      const span = arcs[i] - arcs[i - 1] || 1;
      const t = (arc - arcs[i - 1]) / span;
      return {
        x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * t,
        y: pts[i - 1].y + (pts[i].y - pts[i - 1].y) * t,
        basis: 'raw-image-px'
      };
    }
  }
  return { ...pts[pts.length - 1], basis: 'raw-image-px' };
}

/** 点到折线最近弧长位置（投影），并返回像素距离。 */
export function nearestArc(line: PxPolyline, p: PxPoint): { arcPx: number; distPx: number } {
  let best = { arcPx: 0, distPx: Infinity };
  let baseArc = 0;
  const pts = line.points;
  for (let i = 1; i < pts.length; i++) {
    const segLen = distance(pts[i - 1], pts[i]);
    const t = segLen === 0
      ? 0
      : clamp01(((p.x - pts[i - 1].x) * (pts[i].x - pts[i - 1].x) +
                 (p.y - pts[i - 1].y) * (pts[i].y - pts[i - 1].y)) / (segLen * segLen));
    const qx = pts[i - 1].x + t * (pts[i].x - pts[i - 1].x);
    const qy = pts[i - 1].y + t * (pts[i].y - pts[i - 1].y);
    const dist = Math.hypot(p.x - qx, p.y - qy);
    if (dist < best.distPx) best = { arcPx: baseArc + t * segLen, distPx: dist };
    baseArc += segLen;
  }
  if (pts.length === 1) best = { arcPx: 0, distPx: distance(p, pts[0]) };
  return best;
}

export function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

// ---------- 单位 ----------

/** 分子量单位族（仅同族可比较）。无法转换保留 raw 并产生诊断。 */
const MW_UNIT_FAMILY: Record<string, { family: string; toRef: number }> = {
  bp: { family: 'mw-length', toRef: 1 },
  kb: { family: 'mw-length', toRef: 1000 },
  Da: { family: 'mw-mass', toRef: 1 },
  kDa: { family: 'mw-mass', toRef: 1000 }
};

export function parseQuantity(rawIn: string | number, unit: string): PhysicalQuantity {
  const raw = String(rawIn).trim();
  const value = Number(raw);
  const ok = raw.length > 0 && Number.isFinite(value);
  return {
    value: ok ? value : null,
    raw,
    unit,
    basis: unitFamily(unit)?.family
  };
}

export function unitFamily(unit: string): { family: string; toRef: number } | null {
  return MW_UNIT_FAMILY[unit] ?? null;
}

/** 转换为同族参考单位；无法转换返回 null（保留原值在原位置 + 诊断）。 */
export function toReferenceUnit(q: PhysicalQuantity): number | null {
  if (q.value === null) return null;
  const fam = MW_UNIT_FAMILY[q.unit];
  if (!fam) return null;
  return q.value * fam.toRef;
}

export function formatQuantity(q: PhysicalQuantity): string {
  const v = q.value === null ? q.raw : formatNum(q.value);
  return `${v} ${q.unit}`;
}

export function formatNum(v: number): string {
  if (Number.isInteger(v)) return String(v);
  return v.toPrecision(5).replace(/\.?0+$/, '');
}
