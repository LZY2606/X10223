import type { Diagnostic, LaneBoundary, LaneCurveResult, PixelPoint } from '../shared/types';

// 由泳道中心线折线计算弧长参数化。
// “微笑”弯曲时，同一像素高度在不同泳道对应不同弧长，因此分子量推断必须
// 在 lane-arc-px 坐标下进行，而不是直接用像素 y。
export function fitLaneCurve(lane: LaneBoundary): { result: LaneCurveResult; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = [];
  const pts = lane.centerline;
  if (pts.length < 2) {
    diagnostics.push({
      code: 'LANE_CENTERLINE_TOO_SHORT',
      severity: 'error',
      location: { entity: 'lane', id: lane.id, field: 'centerline' },
      message: `泳道 ${lane.label} 中心线点数不足（${pts.length}），无法建立弧长坐标`,
    });
    return {
      result: { laneId: lane.id, well: pts[0] ?? { x: 0, y: 0, basis: 'image-pixel' }, samples: [], lengthPx: 0 },
      diagnostics,
    };
  }
  const samples: { s: number; x: number; y: number }[] = [];
  let s = 0;
  samples.push({ s: 0, x: pts[0].x, y: pts[0].y });
  for (let i = 1; i < pts.length; i++) {
    const dx = pts[i].x - pts[i - 1].x;
    const dy = pts[i].y - pts[i - 1].y;
    s += Math.hypot(dx, dy);
    samples.push({ s, x: pts[i].x, y: pts[i].y });
  }
  const well = pts[0];
  return {
    result: { laneId: lane.id, well, samples, lengthPx: s },
    diagnostics,
  };
}

// 像素点 → 最近弧长坐标。返回 null 表示点离泳道太远（附诊断由调用方决定）。
export function pixelToArc(
  curve: LaneCurveResult,
  p: PixelPoint,
): { s: number; distancePx: number } | null {
  const samples = curve.samples;
  if (samples.length < 2) return null;
  let bestS = 0;
  let bestDist = Number.POSITIVE_INFINITY;
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1];
    const b = samples[i];
    const abx = b.x - a.x;
    const aby = b.y - a.y;
    const len2 = abx * abx + aby * aby;
    let t = len2 === 0 ? 0 : ((p.x - a.x) * abx + (p.y - a.y) * aby) / len2;
    t = Math.max(0, Math.min(1, t));
    const qx = a.x + t * abx;
    const qy = a.y + t * aby;
    const d = Math.hypot(p.x - qx, p.y - qy);
    if (d < bestDist) {
      bestDist = d;
      bestS = a.s + t * (b.s - a.s);
    }
  }
  return { s: bestS, distancePx: bestDist };
}
