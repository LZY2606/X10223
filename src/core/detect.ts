import type {
  BandObservation, Diagnostic, LaneBoundary, ParameterSet, PixelProvenance, Vec,
} from '../shared/types.js';
import { clamp, polyLength } from './geometry.js';
import { stableId } from './ids.js';

export interface DetectInput {
  imageId: string;
  width: number;
  height: number;
  gray: Uint8Array;
  frame: PixelProvenance['frame'];
  params: ParameterSet;
}

export interface DetectOutput {
  lanes: LaneBoundary[];
  bands: BandObservation[];
  diagnostics: Diagnostic[];
  budgetExhausted: boolean;
}

function smooth1d(a: Float64Array, radius: number): Float64Array {
  const out = new Float64Array(a.length);
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    sum += a[i];
    if (i > radius * 2) sum -= a[i - radius * 2 - 1];
    const n = Math.min(i + 1, radius * 2 + 1);
    out[i - radius] = sum / n;
  }
  // 边界补齐
  for (let i = Math.max(0, a.length - radius); i < a.length; i++) out[i] = a[i];
  return out;
}

export function detectLanesAndBands(input: DetectInput): DetectOutput {
  const diagnostics: Diagnostic[] = [];
  const { width: w, height: h, gray, params } = input;
  if (w * h > params.budget.maxPixels || gray.length !== w * h) {
    return {
      lanes: [], bands: [], budgetExhausted: true,
      diagnostics: [{
        code: 'BUDGET_EXHAUSTED', severity: 'error',
        message: `像素预算耗尽：需要 ${w * h}，上限 ${params.budget.maxPixels}`,
        affectedObjectIds: [input.imageId],
      }],
    };
  }

  // 1) 列亮度剖面 -> 泳道中心线
  const col = new Float64Array(w);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) col[x] += gray[y * w + x];
  const colS = smooth1d(col, 6);
  const maxCol = Math.max(...colS, 1);
  const thresh = 24 + maxCol * 0.18;
  const segments: [number, number][] = [];
  let runStart = -1;
  for (let x = 0; x < w; x++) {
    if (colS[x] > thresh) { if (runStart < 0) runStart = x; }
    else if (runStart >= 0) { if (x - runStart >= 14) segments.push([runStart, x]); runStart = -1; }
  }
  if (runStart >= 0 && w - runStart >= 14) segments.push([runStart, w]);

  const rows = 24;
  const rawPolylines: Vec[][] = segments.map(([x0, x1]) => {
    const poly: Vec[] = [];
    for (let r = 0; r <= rows; r++) {
      const y = Math.round(4 + ((h - 8) * r) / rows);
      let num = 0, den = 0;
      for (let x = x0; x < x1; x++) { const v = gray[y * w + x]; num += x * v; den += v; }
      const cx = den === 0 ? (x0 + x1) / 2 : num / den;
      poly.push({ x: clamp(cx, x0, x1 - 1), y });
    }
    return poly;
  });

  const lanes: LaneBoundary[] = rawPolylines.map((poly, i) => ({
    id: stableId('lane', { imageId: input.imageId, poly }),
    kind: 'material',
    laneIndex: i,
    centerline: poly.map((p) => ({ x: round1(p.x), y: p.y })),
    frame: input.frame,
    originImageId: input.imageId,
    origin: 'auto_candidate',
  }));

  // 2) 每条泳道沿弧长采样亮度 -> 峰
  const bands: BandObservation[] = [];
  for (const lane of lanes) {
    const poly = lane.centerline;
    const L = polyLength(poly);
    const step = 2;
    const samples: { s: number; point: Vec; v: number }[] = [];
    for (let s = 0; s <= L; s += step) {
      const { point } = sampleAlong(poly, s, w, h, gray);
      samples.push({ s, point, v: sampleAcross(poly, s, w, h, gray) });
    }
    const values = new Float64Array(samples.map((q) => q.v));
    const sm = smooth1d(values, 2);
    const baseline = Math.min(...sm) + 6;
    const peakThresh = baseline + params.detection.intensityThreshold;
    const peaks: number[] = [];
    for (let i = 2; i < sm.length - 2; i++) {
      if (sm[i] >= peakThresh && sm[i] > sm[i - 1] && sm[i] >= sm[i + 1]) peaks.push(i);
    }
    const merged = mergeClosePeaks(peaks, sm, params.detection.minBandSpacingPx / step);

    for (const group of merged) {
      const centerIdx = group[Math.floor(group.length / 2)];
      const sample = samples[centerIdx];
      const peakV = sm[centerIdx];
      const saturated = peakV >= params.detection.saturationLevel || sample.v >= 250;
      const smear = isSmear(sm, centerIdx, params);
      const overlap = group.length > 1;
      if (saturated) diagnostics.push(diag('SATURATED_BAND', 'warning', `泳道 ${lane.laneIndex} 中 s≈${Math.round(sample.s)}px 的条带饱和，只能给出候选/区间`, lane, sample.point, input));
      if (smear) diagnostics.push(diag('SMEAR_BAND', 'warning', `泳道 ${lane.laneIndex} 中 s≈${Math.round(sample.s)}px 的条带拖尾，只能给出候选/区间`, lane, sample.point, input));
      if (overlap) diagnostics.push(diag('BAND_OVERLAP', 'warning', `泳道 ${lane.laneIndex} 中 s≈${Math.round(sample.s)}px 附近 ${group.length} 个峰重叠，保留全部合法候选`, lane, sample.point, input));
      const id = stableId('band', { laneId: lane.id, s: Math.round(sample.s * 10) });
      bands.push({
        id,
        laneId: lane.id,
        s: Math.round(sample.s * 10) / 10,
        anchorPoint: { x: round1(sample.point.x), y: round1(sample.point.y) },
        provenance: {
          frame: input.frame, point: { x: round1(sample.point.x), y: round1(sample.point.y) },
          sourceMaterialId: input.imageId, sourceKind: 'gel_image', uncertaintyPx: overlap ? 4 : 2,
        },
        intensity: { value: Math.round(peakV), unit: 'a.u.', raw: String(Math.round(peakV)) },
        saturated, smear, origin: 'auto_candidate',
      });
      if (bands.length > params.budget.maxBands) {
        diagnostics.push({
          code: 'BUDGET_EXHAUSTED', severity: 'error',
          message: `条带数超过预算上限 ${params.budget.maxBands}`, affectedObjectIds: [input.imageId],
        });
        return { lanes, bands: [], diagnostics, budgetExhausted: true };
      }
    }
  }

  if (lanes.some((l) => bentness(l.centerline) > 6)) {
    diagnostics.push({
      code: 'BENT_LANE', severity: 'info',
      message: '检测到弯曲泳道：同一像素高度不等于同一分子量，迁移量以沿中心线弧长度量',
      affectedObjectIds: lanes.filter((l) => bentness(l.centerline) > 6).map((l) => l.id),
    });
  }
  return { lanes, bands, diagnostics, budgetExhausted: false };
}

function diag(code: Diagnostic['code'], severity: Diagnostic['severity'], message: string, lane: LaneBoundary, point: Vec, input: DetectInput): Diagnostic {
  return {
    code, severity, message,
    position: { frame: input.frame, point, sourceMaterialId: lane.id, sourceKind: 'lane_boundary', uncertaintyPx: 3 },
    affectedObjectIds: [lane.id],
  };
}

function bentness(curve: Vec[]): number {
  const a = curve[0], b = curve[curve.length - 1];
  let m = 0;
  for (const p of curve) {
    const t = b.y === a.y ? 0 : (p.y - a.y) / (b.y - a.y);
    m = Math.max(m, Math.abs(p.x - (a.x + (b.x - a.x) * t)));
  }
  return m;
}

function isSmear(sm: Float64Array, idx: number, params: ParameterSet): boolean {
  const window = 14;
  let left = 0, right = 0;
  for (let k = 1; k <= window; k++) {
    if (idx - k >= 0) left += sm[idx] - sm[idx - k];
    if (idx + k < sm.length) right += sm[idx] - sm[idx + k];
  }
  // 明显不对称的长尾
  return Math.abs(left - right) / window > params.detection.intensityThreshold * 0.9;
}

function mergeClosePeaks(peaks: number[], sm: Float64Array, minDist: number): number[][] {
  const groups: number[][] = [];
  for (const p of peaks) {
    const last = groups[groups.length - 1];
    if (last && p - last[last.length - 1] < minDist) last.push(p);
    else groups.push([p]);
  }
  // 重叠群只在两峰之间有显著谷值时才算重叠
  return groups.map((g) => {
    if (g.length < 2) return g;
    for (let i = 1; i < g.length; i++) {
      let valley = Infinity;
      for (let k = g[i - 1]; k <= g[i]; k++) valley = Math.min(valley, sm[k]);
      if (valley > Math.min(sm[g[i - 1]], sm[g[i]]) * 0.82) return [g[Math.floor(g.length / 2)]];
    }
    return g;
  });
}

function sampleAlong(poly: Vec[], s: number, w: number, h: number, gray: Uint8Array): { point: Vec } {
  let remaining = s;
  for (let i = 1; i < poly.length; i++) {
    const a = poly[i - 1], b = poly[i];
    const seg = Math.hypot(b.x - a.x, b.y - a.y);
    if (remaining <= seg) {
      const t = seg === 0 ? 0 : remaining / seg;
      return { point: { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t } };
    }
    remaining -= seg;
  }
  return { point: { ...poly[poly.length - 1] } };
}

function sampleAcross(poly: Vec[], s: number, w: number, h: number, gray: Uint8Array): number {
  const { point } = sampleAlong(poly, s, w, h, gray);
  // 找到所在段方向，取横向法线窗口平均亮度
  let remaining = s, a = poly[0], b = poly[1];
  for (let i = 1; i < poly.length; i++) {
    const seg = Math.hypot(poly[i].x - poly[i - 1].x, poly[i].y - poly[i - 1].y);
    if (remaining <= seg) { a = poly[i - 1]; b = poly[i]; break; }
    remaining -= seg;
  }
  const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len, ny = dx / len;
  let sum = 0, n = 0;
  for (let off = -7; off <= 7; off++) {
    const x = Math.round(point.x + nx * off), y = Math.round(point.y + ny * off);
    if (x >= 0 && y >= 0 && x < w && y < h) { sum += gray[y * w + x]; n++; }
  }
  return n ? sum / n : 0;
}

function round1(v: number): number { return Math.round(v * 10) / 10; }
