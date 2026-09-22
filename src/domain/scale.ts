import type { Diagnostic, MwEstimate, Result } from './core';
import { fail, ok } from './core';

/** ladder 标定点：analysis 帧 y（像素）+ log10(分子量/bp)，带稳定身份 */
export interface LadderPoint {
  pointId: string;
  nominalId: string;
  y: number;
  logMw: number;
}

/** 局部标尺：只在有效区域内插值，区域外必须报诊断 */
export interface LocalScale {
  laneId: string;
  points: LadderPoint[];
  validity: { yMin: number; yMax: number };
  inputDigest: string;
}

export interface ScaleOptions {
  /** 资源预算：允许处理的最大标定点数 */
  budget?: number;
}

/**
 * 由 ladder 标定点构建局部标尺。
 * - 点数 < 2：语义无解
 * - logMw 随 y 非单调下降：语义无解（非单调标尺）
 * - 点数超预算：资源耗尽
 */
export function buildLocalScale(laneId: string, points: LadderPoint[], inputDigest: string, opts: ScaleOptions = {}): Result<LocalScale> {
  const budget = opts.budget ?? 1000;
  if (points.length > budget) {
    return fail('budget_exhausted', [
      { code: 'SCALE_BUDGET_EXHAUSTED', message: `ladder 点数 ${points.length} 超过预算 ${budget}`, location: { objectType: 'lane', objectId: laneId } },
    ]);
  }
  if (points.length < 2) {
    return fail('semantic_unsolvable', [
      { code: 'SCALE_TOO_FEW_POINTS', message: `有效 ladder 点不足（${points.length} < 2），无法建立局部标尺`, location: { objectType: 'lane', objectId: laneId } },
    ]);
  }
  const sorted = [...points].sort((a, b) => a.y - b.y || a.pointId.localeCompare(b.pointId));
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const cur = sorted[i];
    if (!(cur.y > prev.y)) {
      return fail('semantic_unsolvable', [
        { code: 'SCALE_DUPLICATE_Y', message: `ladder 点 y 坐标重复（y=${cur.y}）`, location: { objectType: 'ladder_point', objectId: cur.pointId, frame: 'analysis', y: cur.y } },
      ]);
    }
    if (!(cur.logMw < prev.logMw)) {
      return fail('semantic_unsolvable', [
        {
          code: 'SCALE_NON_MONOTONIC',
          message: `非单调标尺：y=${prev.y} 处 logMw=${prev.logMw}，y=${cur.y} 处 logMw=${cur.logMw}`,
          location: { objectType: 'ladder_point', objectId: cur.pointId, frame: 'analysis', y: cur.y },
        },
      ]);
    }
  }
  return ok({ laneId, points: sorted, validity: { yMin: sorted[0].y, yMax: sorted[sorted.length - 1].y }, inputDigest });
}

/** 在局部标尺上插值 y -> 分子量；超出有效区域返回 invalid + 诊断，不伪装成功 */
export function inferMw(scale: LocalScale, y: number): MwEstimate {
  const { points, validity } = scale;
  if (y < validity.yMin || y > validity.yMax) {
    return {
      kind: 'invalid',
      diagnostic: {
        code: 'OUT_OF_VALIDITY_REGION',
        message: `y=${y.toFixed(1)} 超出局部标尺有效区域 [${validity.yMin.toFixed(1)}, ${validity.yMax.toFixed(1)}]`,
        location: { objectType: 'lane', objectId: scale.laneId, frame: 'analysis', y },
      },
    };
  }
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    if (y >= a.y && y <= b.y) {
      const t = (y - a.y) / (b.y - a.y);
      const logMw = a.logMw + t * (b.logMw - a.logMw);
      return { kind: 'point', logMw, mw: { value: Math.pow(10, logMw), unit: 'bp' }, segment: [i, i + 1] };
    }
  }
  return {
    kind: 'invalid',
    diagnostic: { code: 'OUT_OF_VALIDITY_REGION', message: `y=${y} 未落入任何插值段`, location: { objectType: 'lane', objectId: scale.laneId, frame: 'analysis', y } },
  };
}

/**
 * “微笑”弯曲校正：泳道在 x 处的纵向偏移 s(x)。
 * 同一图像高度 y 在不同泳道对应不同参考系高度 y' = y - s(x)，
 * 因此同一高度不等于同一分子量。
 */
export interface LaneCurve {
  laneId: string;
  /** 采样点（analysis 帧）：x -> 纵向偏移 */
  samples: { x: number; offset: number }[];
}

export function curveOffsetAt(curve: LaneCurve, x: number): number {
  const s = [...curve.samples].sort((a, b) => a.x - b.x);
  if (s.length === 0) return 0;
  if (x <= s[0].x) return s[0].offset;
  if (x >= s[s.length - 1].x) return s[s.length - 1].offset;
  for (let i = 0; i < s.length - 1; i++) {
    const a = s[i];
    const b = s[i + 1];
    if (x >= a.x && x <= b.x) {
      const t = (x - a.x) / (b.x - a.x);
      return a.offset + t * (b.offset - a.offset);
    }
  }
  return 0;
}

/** 把某泳道 x 处的图像高度换算到 ladder 参考系高度 */
export function toReferenceY(curve: LaneCurve, x: number, y: number): number {
  return y - curveOffsetAt(curve, x);
}

/** 全局 log-线性回归残差（用于复核界面的拟合残差叠加层） */
export function fitResiduals(points: LadderPoint[]): { pointId: string; residual: number }[] {
  const n = points.length;
  if (n < 2) return points.map((p) => ({ pointId: p.pointId, residual: 0 }));
  const sx = points.reduce((a, p) => a + p.y, 0);
  const sy = points.reduce((a, p) => a + p.logMw, 0);
  const sxx = points.reduce((a, p) => a + p.y * p.y, 0);
  const sxy = points.reduce((a, p) => a + p.y * p.logMw, 0);
  const denom = n * sxx - sx * sx;
  if (denom === 0) return points.map((p) => ({ pointId: p.pointId, residual: 0 }));
  const slope = (n * sxy - sx * sy) / denom;
  const intercept = (sy - slope * sx) / n;
  return points.map((p) => ({ pointId: p.pointId, residual: p.logMw - (slope * p.y + intercept) }));
}

export function scaleDiagnostics(scale: LocalScale): Diagnostic[] {
  return [
    {
      code: 'SCALE_VALIDITY',
      message: `局部标尺有效区域 y ∈ [${scale.validity.yMin.toFixed(1)}, ${scale.validity.yMax.toFixed(1)}]（analysis 帧，单位 px）`,
      location: { objectType: 'lane', objectId: scale.laneId },
    },
  ];
}
