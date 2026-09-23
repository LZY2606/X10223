import type { Band, CalibrationParams, Diagnostic, Lane, PxPoint } from '../types.ts';
import { laneProfile, sampleCurve } from './geometry.ts';

export interface DetectResult {
  bands: Band[];
  diagnostics: Diagnostic[];
  budgetExhausted: boolean;
}

interface Peak {
  i: number;
  t: number;
  v: number;
  half: number; // 沿泳道半长 px
}

function findPeaks(t: number[], v: number[], floor: number, resolution: number): Peak[] {
  const peaks: Peak[] = [];
  for (let i = 2; i < v.length - 2; i++) {
    if (v[i] > floor && v[i] >= v[i - 1] && v[i] >= v[i + 1] && v[i] > v[i - 2] * 0.7 && v[i] > v[i + 2] * 0.7) {
      peaks.push({ i, t: t[i], v: v[i], half: 0 });
    }
  }
  const merged: Peak[] = [];
  for (const pk of peaks) {
    const prev = merged[merged.length - 1];
    if (prev && pk.t - prev.t < resolution) {
      if (pk.v > prev.v) merged[merged.length - 1] = pk;
    } else merged.push(pk);
  }
  for (const pk of merged) {
    const level = pk.v * 0.5;
    let lo = pk.i;
    let hi = pk.i;
    while (lo > 0 && v[lo] > level) lo--;
    while (hi < v.length - 1 && v[hi] > level) hi++;
    pk.half = Math.max(3, (t[hi] - t[lo]) / 2);
  }
  return merged;
}

function buildContour(centerline: Band['contour'] extends never ? never : any, t0: number, halfLen: number, halfWidth: number): { contour: any; center: PxPoint } {
  void centerline;
  void t0;
  void halfLen;
  void halfWidth;
  return { contour: { points: [] }, center: { x: 0, y: 0 } };
}

/** 在像素栅格上检测条带；饱和/拖尾/重叠只标记，供校准层降级为候选/区间 */
export function detectBands(
  pixels: Uint8Array,
  width: number,
  height: number,
  lanes: Lane[],
  params: CalibrationParams
): DetectResult {
  const diagnostics: Diagnostic[] = [];
  const bands: Band[] = [];
  let budgetExhausted = false;
  let totalPeaks = 0;

  for (const lane of lanes) {
    const halfWidth = Math.max(3, Math.round(params.laneWidthPx / 2));
    const { t, v } = laneProfile(pixels, width, height, lane.centerline, halfWidth);
    const floor = params.intensityFloor * 255;
    const peaks = findPeaks(t, v, floor, params.bandResolutionPx);
    totalPeaks += peaks.length;

    if (totalPeaks > params.maxBands) {
      budgetExhausted = true;
      diagnostics.push({
        code: 'BUDGET_EXHAUSTED',
        severity: 'error',
        message: `检测候选 ${totalPeaks} 条超过预算 maxBands=${params.maxBands}（lane ${lane.index}）`,
        path: `lanes[${lane.index}]`
      });
    }

    const curve = sampleCurve(lane.centerline, 1.5);
    peaks.forEach((pk, k) => {
      const idx = Math.round((pk.t / curve.total) * (curve.pts.length - 1));
      const ci = Math.min(curve.pts.length - 1, Math.max(0, idx));
      const center = curve.pts[ci];
      // 法线
      const a = curve.pts[Math.max(0, ci - 3)];
      const b = curve.pts[Math.min(curve.pts.length - 1, ci + 3)];
      let nx = -(b.y - a.y);
      let ny = b.x - a.x;
      const nl = Math.hypot(nx, ny) || 1;
      nx /= nl;
      ny /= nl;
      // 条带框统计
      let sat = 0;
      let box = 0;
      for (let dt = -pk.half; dt <= pk.half; dt += 2) {
        for (let off = -halfWidth; off <= halfWidth; off += 2) {
          const x = Math.round(center.x + nx * off);
          const y = Math.round(center.y + ny * off + dt);
          if (x >= 0 && y >= 0 && x < width && y < height) {
            box++;
            if (255 - pixels[y * width + x] >= 251) sat++;
          }
        }
      }
      const saturatedFraction = box ? sat / box : 0;
      const saturated = saturatedFraction >= params.saturationFractionThreshold;
      const smeared = pk.half * 2 >= params.smearWidthPx;
      const contourPoints: PxPoint[] = [];
      for (let s = -1; s <= 1; s += 2) {
        for (let off = -halfWidth; off <= halfWidth; off += 2) {
          contourPoints.push({
            x: Math.round(center.x + nx * off + b.x - a.x === 0 ? center.x + nx * off : center.x + nx * off),
            y: Math.round(center.y + ny * off + s * pk.half)
          });
        }
      }
      // 简化为沿法线两端点 + 沿泳道两端点的矩形轮廓
      const contour = {
        points: [
          { x: Math.round(center.x + nx * halfWidth - (b.x - a.x) * 0 + pk.half * 0), y: 0 },
        ]
      };
      contour.points = [
        { x: Math.round(center.x + nx * halfWidth - ((b.x - a.x) / (Math.hypot(b.x - a.x, b.y - a.y) || 1)) * pk.half), y: Math.round(center.y + ny * halfWidth - ((b.y - a.y) / (Math.hypot(b.x - a.x, b.y - a.y) || 1)) * pk.half) },
        { x: Math.round(center.x + nx * halfWidth + ((b.x - a.x) / (Math.hypot(b.x - a.x, b.y - a.y) || 1)) * pk.half), y: Math.round(center.y + ny * halfWidth + ((b.y - a.y) / (Math.hypot(b.x - a.x, b.y - a.y) || 1)) * pk.half) },
        { x: Math.round(center.x - nx * halfWidth + ((b.x - a.x) / (Math.hypot(b.x - a.x, b.y - a.y) || 1)) * pk.half), y: Math.round(center.y - ny * halfWidth + ((b.y - a.y) / (Math.hypot(b.x - a.x, b.y - a.y) || 1)) * pk.half) },
        { x: Math.round(center.x - nx * halfWidth - ((b.x - a.x) / (Math.hypot(b.x - a.x, b.y - a.y) || 1)) * pk.half), y: Math.round(center.y - ny * halfWidth - ((b.y - a.y) / (Math.hypot(b.x - a.x, b.y - a.y) || 1)) * pk.half) }
      ];

      const band: Band = {
        id: `band_l${lane.index}_${k}`,
        laneId: lane.id,
        center,
        widthPx: Math.round(pk.half * 2),
        peakIntensity: Math.min(1, pk.v / 255),
        saturated,
        saturatedFraction,
        smeared,
        overlapWith: [],
        source: 'auto',
        contour
      };
      bands.push(band);
    });
  }

  // 重叠：同泳道相邻峰间距小于分辨率
  for (const lane of lanes) {
    const lb = bands.filter((b) => b.laneId === lane.id).sort((p, q) => p.center.y - q.center.y);
    for (let i = 1; i < lb.length; i++) {
      const gap = Math.hypot(lb[i].center.x - lb[i - 1].center.x, lb[i].center.y - lb[i - 1].center.y);
      if (gap < params.bandResolutionPx + (lb[i].widthPx + lb[i - 1].widthPx) / 4) {
        if (!lb[i].overlapWith.includes(lb[i - 1].id)) lb[i].overlapWith.push(lb[i - 1].id);
        if (!lb[i - 1].overlapWith.includes(lb[i].id)) lb[i - 1].overlapWith.push(lb[i].id);
        diagnostics.push({
          code: 'OVERLAPPING_BANDS',
          severity: 'warning',
          message: `条带 ${lb[i - 1].id} 与 ${lb[i].id} 重叠，只能作为区间/候选`,
          path: `lanes[${lane.index}]`
        });
      }
    }
    for (const b of lb) {
      if (b.saturated)
        diagnostics.push({ code: 'SATURATED_BAND', severity: 'warning', message: `条带 ${b.id} 饱和（${(b.saturatedFraction * 100).toFixed(0)}%），中心位置不可唯一确定`, path: `bands.${b.id}` });
      if (b.smeared)
        diagnostics.push({ code: 'SMEARED_BAND', severity: 'warning', message: `条带 ${b.id} 拖尾，仅可给候选`, path: `bands.${b.id}` });
    }
  }

  if (budgetExhausted) bands.length = Math.min(bands.length, params.maxBands);
  return { bands, diagnostics, budgetExhausted };
}
