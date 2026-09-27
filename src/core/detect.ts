import type {
  BandMaterial,
  Diagnostic,
  FrameMaterial,
  ImageMaterial,
  LaneMaterial,
  OutcomeKind,
  ParamVersion,
} from '../shared/events.js';
import type { SourcedPoint } from '../shared/units.js';
import { buildArcCurve, curvatureOffset, laneProfile, pointAtArc } from './geometry.js';

export const DETECT_PARAMS: ParamVersion = { profile: 'detect/band-peak', version: '1.4.0' };

export interface DetectionInput {
  image: ImageMaterial;
  frame: FrameMaterial;
  raster: Uint8Array;
  saturationLevel: number;
  /** 资源预算（最大处理像素数），耗尽返回 BUDGET_EXHAUSTED */
  pixelBudget?: number;
}

export interface DetectionResult {
  outcome: OutcomeKind;
  lanes: LaneMaterial[];
  bands: BandMaterial[];
  diagnostics: Diagnostic[];
}

/** 列投影（暗度），用于自动找泳道 */
function columnDarkness(raster: Uint8Array, w: number, h: number): number[] {
  const cols = new Array<number>(w).fill(0);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) cols[x] += 255 - raster[y * w + x];
  }
  return cols.map((v) => v / h);
}

function findRuns(values: number[], threshold: number): Array<[number, number]> {
  const runs: Array<[number, number]> = [];
  let start = -1;
  for (let i = 0; i < values.length; i++) {
    if (values[i] >= threshold && start < 0) start = i;
    if ((values[i] < threshold || i === values.length - 1) && start >= 0) {
      const end = values[i] < threshold ? i - 1 : i;
      runs.push([start, end]);
      start = -1;
    }
  }
  return runs;
}

/**
 * 自动泳道候选。smilePx>0 时生成向下弯曲的中心线（微笑）。
 */
export function detectLanes(
  input: DetectionInput,
  opts: { minLaneWidth?: number; darknessThreshold?: number; smilePx?: number; manualCurves?: Map<number, SourcedPoint[]> } = {},
): LaneMaterial[] {
  const { frame, raster } = input;
  const w = frame.width, h = frame.height;
  const threshold = opts.darknessThreshold ?? 18;
  const cols = columnDarkness(raster, w, h);
  const runs = findRuns(cols, threshold).filter(([a, b]) => b - a + 1 >= (opts.minLaneWidth ?? 8));
  return runs.map(([a, b], laneIndex) => {
    const cx = (a + b) / 2;
    const halfW = Math.max(2, Math.round((b - a) / 2));
    const smile = opts.smilePx ?? 0;
    const ctrl: SourcedPoint[] = [0, 1, 2, 3, 4].map((k) => {
      const t = k / 4;
      const x = cx + Math.sin(t * Math.PI) * 0; // 对称弯曲：x 不动，中段下沉
      const y = t * (h - 1) + smile * 4 * t * (1 - t);
      return { x, y, basis: frame.basis };
    });
    const manual = opts.manualCurves?.get(laneIndex);
    const centerline = manual ?? ctrl;
    return {
      id: `lane_${frame.id}_${laneIndex}`,
      kind: 'lane',
      imageId: input.image.id,
      frameId: frame.id,
      laneIndex,
      source: manual ? 'manual' : 'auto',
      centerline,
      halfWidth: centerline.map(() => halfW),
      curvaturePx: curvatureOffset(centerline),
    } satisfies LaneMaterial;
  });
}

interface Peak {
  arc: number;
  prominence: number;
  sigma: number;
  saturated: boolean;
  tailing: number; // 右侧尾部相对左侧的不对称比
  overlapping: boolean;
  maxDarkness: number;
}

/**
 * 在一条泳道轮廓上找峰。信号取暗度 = 255-intensity。
 * 预算耗尽、轮廓为空等由调用方区分。
 */
export function findPeaks(
  arc: number[],
  intensity: number[],
  saturationLevel: number,
): { peaks: Peak[]; outcome: OutcomeKind } {
  if (arc.length < 6) {
    return { peaks: [], outcome: 'SEMANTIC_UNSOLVABLE' };
  }
  const sig = intensity.map((v) => 255 - v);
  const baseline = Math.min(...sig);
  const noise = stdev(sig.slice(0, Math.min(20, sig.length)));
  const minProm = Math.max(10, 3 * noise);
  const peaks: Peak[] = [];
  for (let i = 2; i < sig.length - 2; i++) {
    if (sig[i] > sig[i - 1] && sig[i] >= sig[i + 1] && sig[i] - baseline >= minProm) {
      const prom = sig[i] - baseline;
      const sigma = gaussianSigma(sig, i, baseline);
      const sat = intensity[i] <= 255 - saturationLevel;
      const tailing = asymmetry(sig, i, baseline);
      peaks.push({
        arc: arc[i],
        prominence: prom,
        sigma,
        saturated: sat,
        tailing,
        overlapping: false,
        maxDarkness: sig[i],
      });
    }
  }
  // 合并过近的峰：中心距 < 0.7*(sigmaA+sigmaB) 记为重叠
  for (let i = 0; i < peaks.length; i++) {
    for (let j = i + 1; j < peaks.length; j++) {
      const dist = Math.abs(peaks[j].arc - peaks[i].arc);
      if (dist < 0.7 * (peaks[i].sigma + peaks[j].sigma)) {
        peaks[i].overlapping = true;
        peaks[j].overlapping = true;
      }
    }
  }
  return { peaks, outcome: 'OK' };
}

function gaussianSigma(sig: number[], center: number, baseline: number): number {
  const half = (sig[center] - baseline) * 0.6065 + baseline; // 1 sigma
  let left = center, right = center;
  while (left > 0 && sig[left] > half) left--;
  while (right < sig.length - 1 && sig[right] > half) right++;
  return Math.max(0.6, (right - left) / 2);
}

function asymmetry(sig: number[], center: number, baseline: number): number {
  const half = (sig[center] - baseline) * 0.5 + baseline;
  let left = center, right = center;
  while (left > 0 && sig[left] > half) left--;
  while (right < sig.length - 1 && sig[right] > half) right++;
  const leftTail = center - left || 1;
  const rightTail = right - center || 1;
  return rightTail / leftTail;
}

function stdev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
}

/** 对每条泳道检测条带，输出自动候选与诊断 */
export function detectBands(input: DetectionInput, lanes: LaneMaterial[]): DetectionResult {
  const diagnostics: Diagnostic[] = [];
  const { frame, raster } = input;
  const budget = input.pixelBudget ?? Number.MAX_SAFE_INTEGER;
  if (frame.width * frame.height > budget) {
    return {
      outcome: 'BUDGET_EXHAUSTED',
      lanes,
      bands: [],
      diagnostics: [{
        code: 'BUDGET_EXHAUSTED',
        severity: 'error',
        message: `像素 ${frame.width * frame.height} 超出预算 ${budget}，拒绝截断式伪装成功`,
      }],
    };
  }
  if (raster.length !== frame.width * frame.height) {
    return {
      outcome: 'FORMAT_CORRUPT',
      lanes,
      bands: [],
      diagnostics: [{
        code: 'FORMAT_CORRUPT',
        severity: 'error',
        at: { point: { x: frame.width, y: frame.height } },
        message: `光栅长度 ${raster.length} 与声明尺寸 ${frame.width}x${frame.height} 不符`,
      }],
    };
  }

  const bands: BandMaterial[] = [];
  let anyUnsolvable = false;
  for (const lane of lanes) {
    const halfW = Math.round(lane.halfWidth[0] ?? 4);
    const { arc, intensity } = laneProfile({ width: frame.width, height: frame.height, raster }, lane.centerline, halfW);
    const { peaks, outcome } = findPeaks(arc, intensity, input.saturationLevel);
    if (outcome === 'SEMANTIC_UNSOLVABLE') {
      anyUnsolvable = true;
      diagnostics.push({ code: 'SEMANTIC_UNSOLVABLE', severity: 'error', at: { laneId: lane.id }, message: `泳道 ${lane.laneIndex} 轮廓过短，无法定位条带` });
      continue;
    }
    if (lane.curvaturePx >= 3) {
      diagnostics.push({ code: 'SMILE_CURVATURE', severity: 'warning', at: { laneId: lane.id }, message: `泳道弯曲 ${lane.curvaturePx.toFixed(1)}px：同一像素高度不等于同一分子量，需局部标尺` });
    }
    const curve = buildArcCurve(lane.centerline);
    peaks.forEach((pk, k) => {
      const { point } = pointAtArc(curve, pk.arc);
      const band: BandMaterial = {
        id: `band_${lane.id}_${k}`,
        kind: 'band',
        imageId: input.image.id,
        frameId: frame.id,
        laneId: lane.id,
        source: 'auto',
        arcPx: pk.arc,
        center: { x: point.x, y: point.y, basis: frame.basis },
        spreadPx: pk.sigma,
        saturated: pk.saturated,
        tailing: pk.tailing >= 1.6,
        peakIntensity: Math.round(255 - pk.maxDarkness),
      };
      bands.push(band);
      if (pk.saturated) diagnostics.push({ code: 'SATURATED_BAND', severity: 'warning', at: { laneId: lane.id, bandId: band.id, point: band.center }, message: '饱和条带：峰高不可信，只能标为候选或区间' });
      if (band.tailing) diagnostics.push({ code: 'TAILING_BAND', severity: 'warning', at: { laneId: band:0 } as Diagnostic['at'], message: `拖尾不对称比 ${pk.tailing.toFixed(2)}` });
      if (pk.overlapping) diagnostics.push({ code: 'OVERLAPPING_BANDS', severity: 'warning', at: { laneId: lane.id, bandId: band.id }, message: '与相邻带重叠：保留区间与全部合法候选' });
    });
  }
  const outcome: OutcomeKind = anyUnsolvable
    ? 'SEMANTIC_UNSOLVABLE'
    : diagnostics.some((d) => d.code === 'OVERLAPPING_BANDS' || d.code === 'SATURATED_BAND')
      ? 'CANDIDATE'
      : 'OK';
  return { outcome, lanes, bands, diagnostics };
}
