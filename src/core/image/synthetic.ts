import type { Angle90, PxPoint, PxPolyline } from '../types';
import { pointAtArc } from '../util';

/** 可复现的确定性伪随机（mulberry32）。 */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface SyntheticBand {
  /** 沿 lane 中线从上样端起的弧长（像素）。 */
  arcPx: number;
  /** 峰值强度 0..255（>255 会被钳制并形成饱和平台）。 */
  intensity: number;
  /** 沿弧长方向的高斯 sigma（像素）。 */
  sigmaAlong: number;
  /** 跨 lane 宽度 sigma（像素）。 */
  sigmaAcross: number;
  /** 拖尾长度（像素，沿弧长正向拖尾），0 表示无拖尾。 */
  smearLength: number;
  id: string;
}

export interface SyntheticLane {
  laneId: string;
  /** 中心折线（弯曲泳道为多点）。 */
  centerline: PxPolyline;
  halfWidthPx: number;
  bands: SyntheticBand[];
}

export interface SyntheticGelSpec {
  width: number;
  height: number;
  seed: number;
  background: number;
  noiseAmp: number;
  lanes: SyntheticLane[];
}

/** 折线切向量（在指定弧长处）。 */
function tangentAt(line: PxPolyline, arc: number): { tx: number; ty: number } {
  const pts = line.points;
  const eps = 0.5;
  const p0 = pointAtArc(line, Math.max(0, arc - eps));
  const p1 = pointAtArc(line, arc + eps);
  const dx = p1.x - p0.x;
  const dy = p1.y - p0.y;
  const len = Math.hypot(dx, dy) || 1;
  return { tx: dx / len, ty: dy / len };
}

/** 渲染合成凝胶为 8 位灰度。返回灰度与实际饱和像素集合标记。 */
export function renderGel(spec: SyntheticGelSpec): {
  gray: Uint8Array;
  width: number;
  height: number;
  /** 每像素是否饱和（255 平台）。 */
  saturatedMask: Uint8Array;
} {
  const { width, height } = spec;
  const gray = new Float32Array(width * height);
  gray.fill(spec.background);
  const rand = rng(spec.seed);
  for (let i = 0; i < gray.length; i++) gray[i] += (rand() - 0.5) * spec.noiseAmp;

  for (const lane of spec.lanes) {
    const totalArc = polyLen(lane.centerline);
    for (const band of lane.bands) {
      for (let s = 0; s <= totalArc; s += 1) {
        const center = pointAtArc(lane.centerline, s);
        const { tx, ty } = tangentAt(lane.centerline, s);
        // 法向
        const nx = -ty;
        const ny = tx;
        for (let across = -lane.halfWidthPx; across <= lane.halfWidthPx; across += 1) {
          const px = center.x + nx * across;
          const py = center.y + ny * across;
          const x = Math.round(px);
          const y = Math.round(py);
          if (x < 0 || y < 0 || x >= width || y >= height) continue;
          const alongG = Math.exp(-((s - band.arcPx) ** 2) / (2 * band.sigmaAlong ** 2));
          let smearG = 0;
          if (band.smearLength > 0 && s >= band.arcPx && s <= band.arcPx + band.smearLength) {
            smearG =
              0.55 *
              Math.exp(-(s - band.arcPx) / (band.smearLength * 0.5)) *
              Math.exp(-(across ** 2) / (2 * band.sigmaAcross ** 2));
          }
          const acrossG = Math.exp(-(across ** 2) / (2 * band.sigmaAcross ** 2));
          const add = band.intensity * (alongG * acrossG + smearG);
          if (add > 0) gray[y * width + x] += add;
        }
      }
    }
  }

  const out = new Uint8Array(width * height);
  const saturatedMask = new Uint8Array(width * height);
  for (let i = 0; i < gray.length; i++) {
    const v = Math.round(gray[i]);
    if (v >= 255) {
      out[i] = 255;
      saturatedMask[i] = 1;
    } else {
      out[i] = Math.max(0, v);
    }
  }
  return { gray: out, width, height, saturatedMask };
}

export function polyLen(line: PxPolyline): number {
  let total = 0;
  for (let i = 1; i < line.points.length; i++) {
    total += Math.hypot(line.points[i].x - line.points[i - 1].x, line.points[i].y - line.points[i - 1].y);
  }
  return total;
}

/** 构造直线 lane（可选整体“微笑”弯曲幅度，单位像素）。 */
export function makeLane(
  laneId: string,
  topX: number,
  topY: number,
  bottomY: number,
  halfWidth: number,
  smileAmp = 0,
  samples = 24
): SyntheticLane {
  const points: PxPoint[] = [];
  for (let i = 0; i <= samples; i++) {
    const t = i / samples;
    const y = topY + (bottomY - topY) * t;
    // 微笑：中点偏移最大（正 amp 为中间向迁移方向凸出，这里做横向弧）。
    const x = topX + smileAmp * Math.sin(Math.PI * t);
    points.push({ x, y, basis: 'raw-image-px' });
  }
  return {
    laneId,
    halfWidthPx: halfWidth,
    centerline: { points, basis: 'raw-image-px' },
    bands: []
  };
}

export const ROTATIONS: Angle90[] = [0, 90, 180, 270];
