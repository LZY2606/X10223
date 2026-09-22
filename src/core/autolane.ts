import type { ImageMaterial, LaneAnnotation, Orientation } from './types';
import { stableId } from '../shared/ids';

export const AUTOLANE_PARAM_VERSION = 'autolane.v2';

/**
 * 自动泳道候选：列方向亮度投影 → 峰聚类 → 沿 y 逐段质心得到弯曲中心线。
 * 结果全部标记 auto-candidate，等待人工修订。
 */
export function detectLanes(
  image: ImageMaterial,
  producerEventId: string,
  opts: { wellY?: number; bottomY?: number; minLaneGap?: number } = {},
): LaneAnnotation[] {
  const wellY = opts.wellY ?? Math.round(image.height * 0.12);
  const bottomY = opts.bottomY ?? Math.round(image.height * 0.92);
  const minLaneGap = opts.minLaneGap ?? 18;
  const column = new Float64Array(image.width);
  for (let y = wellY; y < bottomY; y++) {
    for (let x = 0; x < image.width; x++) column[x]! += image.grayscale[y * image.width + x]!;
  }
  const baseline = Math.min(...column);
  const clusters: { x0: number; x1: number; cx: number }[] = [];
  let inBand = false;
  let x0 = 0;
  let sum = 0;
  let wsum = 0;
  const threshold = baseline + (Math.max(...column) - baseline) * 0.08;
  for (let x = 0; x < image.width; x++) {
    const active = column[x]! > threshold;
    if (active && !inBand) {
      inBand = true;
      x0 = x;
      sum = 0;
      wsum = 0;
    }
    if (active) {
      sum += x * column[x]!;
      wsum += column[x]!;
    }
    if ((!active || x === image.width - 1) && inBand) {
      const x1 = active ? x : x - 1;
      clusters.push({ x0, x1, cx: wsum ? sum / wsum : (x0 + x1) / 2 });
      inBand = false;
    }
  }
  // 合并过近簇。
  const merged: typeof clusters = [];
  for (const c of clusters) {
    const last = merged[merged.length - 1];
    if (last && c.x0 - last.x1 < minLaneGap) {
      last.x1 = c.x1;
      last.cx = (last.cx + c.cx) / 2;
    } else merged.push({ ...c });
  }
  merged.sort((a, b) => a.cx - b.cx);

  return merged.map((cluster, idx) => {
    const points = centerlineForCluster(image, cluster, wellY, bottomY);
    const halfWidthPx = Math.max(6, Math.round((cluster.x1 - cluster.x0) / 2) + 2);
    const isLadder = idx === 0;
    const label = isLadder ? 'L0' : `L${idx}`;
    const orientation: Orientation = image.orientation.declared;
    void orientation;
    return {
      laneId: stableId('lane', image.origin.sha256.slice(0, 12), Math.round(cluster.cx), AUTOLANE_PARAM_VERSION),
      label,
      centerline: { points },
      halfWidthPx,
      role: isLadder ? ('ladder' as const) : ('sample' as const),
      ladderMaterialId: isLadder ? undefined : undefined,
      provenance: {
        role: 'auto-candidate' as const,
        frame: 'original-pixel' as const,
        producerEventId,
        confidence: 0.8,
        note: `列投影自动候选，半宽 ${halfWidthPx}px`,
      },
    };
  });
}

/** 在给定列簇内按 y 分段求亮度质心 x，得到中心线（可弯曲）。 */
function centerlineForCluster(
  image: ImageMaterial,
  cluster: { x0: number; x1: number },
  wellY: number,
  bottomY: number,
) {
  const pts = [];
  const step = 8;
  const x0 = Math.max(0, cluster.x0 - 2);
  const x1 = Math.min(image.width - 1, cluster.x1 + 2);
  for (let y = wellY; y <= bottomY; y += step) {
    let sum = 0;
    let wsum = 0;
    for (let x = x0; x <= x1; x++) {
      const v = image.grayscale[y * image.width + x]!;
      sum += x * v;
      wsum += v;
    }
    pts.push({
      x: Math.round((wsum ? sum / wsum : (x0 + x1) / 2) * 100) / 100,
      y,
      frame: 'original-pixel' as const,
    });
  }
  return pts;
}
