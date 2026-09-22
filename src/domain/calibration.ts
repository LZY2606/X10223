import type {
  BandCenterMaterial, CalibrationData, ComputeResult, Diagnostic, FrontCurveMaterial,
  LadderMaterial, MwEstimateData, PixelPoint, RulerSegment,
} from '../shared/types.js';
import { digestOf } from './util.js';

export interface RulerParams {
  version: string;
  max_segments: number;      // 资源预算：允许的最大插值段数
  overlap_px: number;        // 条带重叠判定阈值（校正后 px）
  saturation_level: number;  // 饱和灰度阈值
  band_half_height_px: number;
}

export const RULER_V1: RulerParams = { version: 'ruler-v1', max_segments: 64, overlap_px: 10, saturation_level: 250, band_half_height_px: 4 };
export const RULER_V2: RulerParams = { ...RULER_V1, version: 'ruler-v2', overlap_px: 14 };

export function fail<T>(status: 'resource_exhausted' | 'corrupt_format' | 'semantic_unsolvable', diagnostics: Diagnostic[]): ComputeResult<T> {
  return { status, diagnostics };
}
export function ok<T>(value: T, diagnostics: Diagnostic[] = []): ComputeResult<T> {
  return { status: 'ok', value, diagnostics };
}

/** 前沿曲线在 x 处的 y（分段线性插值，端点外取端点值）。 */
export function frontYAt(curve: FrontCurveMaterial, x: number): number {
  const pts = [...curve.points].sort((p, q) => p.point.x - q.point.x).map((p) => p.point);
  if (pts.length === 0) return 0;
  if (x <= pts[0].x) return pts[0].y;
  if (x >= pts[pts.length - 1].x) return pts[pts.length - 1].y;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    if (x >= a.x && x <= b.x) {
      const t = (x - a.x) / (b.x - a.x || 1);
      return a.y + t * (b.y - a.y);
    }
  }
  return pts[pts.length - 1].y;
}

/** 微笑校正：把图像 y 换算为相对参考泳道的迁移坐标（单位 px）。 */
export function correctedY(curve: FrontCurveMaterial, p: PixelPoint): number {
  const refX = curve.points[curve.reference_lane]?.point.x ?? p.x;
  return p.y - (frontYAt(curve, p.x) - frontYAt(curve, refX));
}

/**
 * 由 ladder 标称值建立局部标尺。
 * - 非单调（y 增大而 bp 不严格减小）→ semantic_unsolvable，带位置诊断；
 * - 缺带 → 跨缺带的插值段标记 gap，并给出诊断；
 * - 段数超出预算 → resource_exhausted（与格式损坏、语义无解是三种不同结果）。
 */
export function fitRuler(
  ladder: LadderMaterial,
  curve: FrontCurveMaterial,
  params: RulerParams,
): ComputeResult<CalibrationData> {
  const diagnostics: Diagnostic[] = [];
  const present = ladder.bands.filter((b) => b.present);
  const missing = ladder.bands.filter((b) => !b.present);
  for (const m of missing) {
    diagnostics.push({
      code: 'ladder-missing-band',
      message: `ladder 缺带 ${m.nominal_bp} bp：跨缺带的插值段可信度降低`,
      position: { lane_index: ladder.lane_index, pixel: m.pixel, band_id: m.id, material_id: ladder.id },
    });
  }
  const sorted = [...present].sort((a, b) => correctedY(curve, a.pixel) - correctedY(curve, b.pixel));
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].nominal_bp >= sorted[i - 1].nominal_bp) {
      return fail('semantic_unsolvable', [{
        code: 'non-monotonic-ruler',
        message: `非单调标尺：y=${sorted[i].pixel.y} 处标称 ${sorted[i].nominal_bp} bp 不小于上一点 ${sorted[i - 1].nominal_bp} bp`,
        position: { lane_index: ladder.lane_index, pixel: sorted[i].pixel, band_id: sorted[i].id, material_id: ladder.id },
      }]);
    }
  }
  if (sorted.length < 2) {
    return fail('semantic_unsolvable', [{
      code: 'insufficient-ladder',
      message: 'ladder 有效带少于 2 条，无法建立标尺',
      position: { lane_index: ladder.lane_index, material_id: ladder.id },
    }]);
  }
  if (sorted.length - 1 > params.max_segments) {
    return fail('resource_exhausted', [{
      code: 'segment-budget',
      message: `需要 ${sorted.length - 1} 个插值段，超出预算 ${params.max_segments}`,
      position: { material_id: ladder.id },
    }]);
  }

  const ys = sorted.map((b) => correctedY(curve, b.pixel));
  const segments: RulerSegment[] = [];
  for (let i = 0; i < sorted.length - 1; i++) {
    const top = sorted[i], bottom = sorted[i + 1];
    const gap = missing.some((m) => m.nominal_bp < top.nominal_bp && m.nominal_bp > bottom.nominal_bp);
    segments.push({
      id: `seg_${ladder.id}_${i}`,
      lane_index: ladder.lane_index,
      y_top: ys[i], y_bottom: ys[i + 1],
      bp_top: top.nominal_bp, bp_bottom: bottom.nominal_bp,
      gap,
    });
  }

  // 全局 log 线性最小二乘，用于残差展示（局部插值才是取值依据）。
  const logs = sorted.map((b) => Math.log10(b.nominal_bp));
  const n = sorted.length;
  const meanY = ys.reduce((s, v) => s + v, 0) / n;
  const meanL = logs.reduce((s, v) => s + v, 0) / n;
  let syy = 0, syl = 0;
  for (let i = 0; i < n; i++) { syy += (ys[i] - meanY) ** 2; syl += (ys[i] - meanY) * (logs[i] - meanL); }
  const slope = syl / (syy || 1);
  const intercept = meanL - slope * meanY;
  const residuals = sorted.map((b, i) => ({
    band_id: b.id, y: ys[i], log10_bp_resid: logs[i] - (intercept + slope * ys[i]),
  }));

  const validity = { y_min: Math.min(...ys), y_max: Math.max(...ys) };
  const data: CalibrationData = {
    subject_id: `cal:${ladder.image_id}`,
    lane_index: ladder.lane_index,
    param_version: params.version,
    segments,
    validity,
    residuals,
    parents: [ladder.id, curve.id, ladder.image_id],
    input_digest: digestOf({ ladder, curve, params }),
  };
  return ok(data, diagnostics);
}

export function bpAtY(cal: CalibrationData, y: number, seg: RulerSegment): number {
  const lt = Math.log10(seg.bp_top), lb = Math.log10(seg.bp_bottom);
  const t = (y - seg.y_top) / (seg.y_bottom - seg.y_top || 1);
  return Math.pow(10, lt + t * (lb - lt));
}

export function findSegment(cal: CalibrationData, y: number): RulerSegment | undefined {
  return cal.segments.find((s) => y >= s.y_top && y <= s.y_bottom);
}

/**
 * 单条带分子量推断。
 * - 饱和/拖尾 → 只能给区间；重叠 → 只能给候选集合（保留全部合法候选）；
 * - 超出局部标尺有效区域 → semantic_unsolvable，不伪造数值。
 */
export function inferMw(
  band: BandCenterMaterial,
  laneBands: BandCenterMaterial[],
  cal: CalibrationData,
  curve: FrontCurveMaterial,
  params: RulerParams,
): MwEstimateData {
  const y = correctedY(curve, band.pixel);
  const diagnostics: Diagnostic[] = [];
  const base: Omit<MwEstimateData, 'status' | 'value' | 'diagnostics'> = {
    subject_id: `est:${band.id}`,
    band_id: band.id,
    image_id: band.image_id,
    lane_index: band.lane_index,
    param_version: params.version,
    corrected_y: y,
    validity: cal.validity,
    parents: [band.id, cal.subject_id, curve.id, band.image_id],
    input_digest: digestOf({ band, cal: cal.input_digest, params }),
  };

  if (y < cal.validity.y_min || y > cal.validity.y_max) {
    return {
      ...base, status: 'semantic_unsolvable', diagnostics: [{
        code: 'outside-validity-region',
        message: `校正后 y=${y.toFixed(1)}px 超出局部标尺有效区域 [${cal.validity.y_min.toFixed(1)}, ${cal.validity.y_max.toFixed(1)}]px`,
        position: { lane_index: band.lane_index, pixel: band.pixel, band_id: band.id },
      }],
    };
  }

  const seg = findSegment(cal, y)!;
  if (seg.gap) {
    diagnostics.push({
      code: 'ladder-gap-region',
      message: `估计落在跨缺带插值段（${seg.bp_top}–${seg.bp_bottom} bp），建议人工复核`,
      position: { lane_index: band.lane_index, pixel: band.pixel, band_id: band.id },
    });
  }

  // 重叠：同一泳道内校正后距离小于阈值的其它条带 → 候选集合
  const neighbors = laneBands.filter((o) => o.id !== band.id &&
    Math.abs(correctedY(curve, o.pixel) - y) <= params.overlap_px);
  if (neighbors.length > 0) {
    const options = [band, ...neighbors].map((b) => {
      const oy = correctedY(curve, b.pixel);
      const oseg = findSegment(cal, Math.min(Math.max(oy, cal.validity.y_min), cal.validity.y_max))!;
      return { bp: Math.round(bpAtY(cal, oy, oseg)), band_id: b.id };
    }).sort((a, b2) => b2.bp - a.bp);
    return {
      ...base, status: 'ok',
      value: { type: 'candidates', options, reason: 'overlap' },
      diagnostics: [...diagnostics, {
        code: 'overlapping-bands',
        message: `与 ${neighbors.length} 条条带重叠，保留全部合法候选，不能唯一决定`,
        position: { lane_index: band.lane_index, pixel: band.pixel, band_id: band.id },
      }],
    };
  }

  // 饱和：中心不可信 → 用半高宽给区间
  if (band.saturated || band.intensity >= params.saturation_level) {
    const hh = Math.max(band.half_height_px, params.band_half_height_px);
    const yTop = Math.max(y - hh, cal.validity.y_min);
    const yBot = Math.min(y + hh, cal.validity.y_max);
    const bpMax = bpAtY(cal, yTop, findSegment(cal, yTop)!);
    const bpMin = bpAtY(cal, yBot, findSegment(cal, yBot)!);
    return {
      ...base, status: 'ok',
      value: { type: 'interval', bp_min: Math.round(bpMin), bp_max: Math.round(bpMax), reason: 'saturated' },
      diagnostics: [...diagnostics, {
        code: 'saturated-band',
        message: '饱和条带：峰顶截断，只能给区间，不能给点估计',
        position: { lane_index: band.lane_index, pixel: band.pixel, band_id: band.id },
      }],
    };
  }

  return { ...base, status: 'ok', value: { type: 'point', bp: Math.round(bpAtY(cal, y, seg)) }, diagnostics };
}
