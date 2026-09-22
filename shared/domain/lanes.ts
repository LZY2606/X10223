import type { Id, PixelPoint } from './types';

/**
 * 泳道曲线：y 方向偏移是 x 的二次函数（“微笑”弯曲）。
 * offset(x) = a*(x - xc)^2 + b*(x - xc)，单位 px。
 * 校正后的迁移坐标 t = y - offset(x)：同一像素高度在不同 x 处对应不同 t，
 * 因此同一高度 ≠ 同一分子量，标尺必须按泳道局部有效区域使用。
 */
export interface LaneCurve {
  a: number;
  b: number;
  xc: number;
}

export interface Lane {
  id: Id;
  index: number;
  /** 泳道中心 x（px，分析坐标系） */
  centerX: number;
  /** 泳道边界（px，分析坐标系），保留像素级来源 */
  top: PixelPoint;
  bottom: PixelPoint;
  curve: LaneCurve;
}

export function curveOffset(curve: LaneCurve, x: number): number {
  const dx = x - curve.xc;
  return curve.a * dx * dx + curve.b * dx;
}

/** 把像素点校正为沿泳道的迁移坐标 t（px，从泳道顶端起）。 */
export function correctedT(lane: Lane, p: PixelPoint): number {
  return p.y - lane.top.y - curveOffset(lane.curve, p.x);
}

/** 泳道迁移坐标的有效长度（px）。 */
export function laneSpan(lane: Lane): number {
  return lane.bottom.y - lane.top.y;
}
