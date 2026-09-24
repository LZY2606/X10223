import type { PixelPoint } from '../shared/units';
import { fail, ok, type Outcome } from '../shared/diagnostic';

/**
 * 泳道中心曲线：x(y) = x0 + curvature * t^2，t = (y - yTop)/(yBottom - yTop)。
 * "微笑"弯曲下，同一图像高度 y 在不同泳道对应不同弧长位置，
 * 因此分子量比较必须沿各泳道自身弧长（rf），不能直接用图像行号。
 */
export interface LaneCurve {
  x0: number;
  curvature: number;
  yTop: number;
  yBottom: number;
}

export function normalizedT(c: LaneCurve, y: number): number {
  return (y - c.yTop) / (c.yBottom - c.yTop);
}

export function curveX(c: LaneCurve, y: number): number {
  const t = normalizedT(c, y);
  return c.x0 + c.curvature * t * t;
}

/** 沿曲线的弧长（固定步长数值积分，确定性） */
export function arcLength(c: LaneCurve, y0: number, y1: number, steps = 256): number {
  if (y1 <= y0) return 0;
  const h = (y1 - y0) / steps;
  let sum = 0;
  let prevX = curveX(c, y0);
  for (let i = 1; i <= steps; i++) {
    const y = y0 + h * i;
    const x = curveX(c, y);
    sum += Math.hypot(x - prevX, h);
    prevX = x;
  }
  return sum;
}

/** 归一化迁移率：沿本泳道弧长，胶顶=0，胶底=1 */
export function rfAt(c: LaneCurve, y: number): number {
  const total = arcLength(c, c.yTop, c.yBottom);
  if (total <= 0) return 0;
  return arcLength(c, c.yTop, y) / total;
}

/** 由中心线折线拟合二次曲线（最小二乘，2 参数闭式解） */
export function fitLaneCurve(centerline: PixelPoint[]): Outcome<LaneCurve> {
  if (centerline.length < 3) {
    return fail('invalid-input', [{
      severity: 'error', code: 'lane/too-few-points',
      message: `泳道中心线至少需要 3 个像素点，当前 ${centerline.length} 个`,
      path: 'centerline',
      position: centerline[0] ? { pixel: { x: centerline[0].x, y: centerline[0].y } } : undefined,
    }]);
  }
  const ys = centerline.map((p) => p.y);
  const yTop = Math.min(...ys);
  const yBottom = Math.max(...ys);
  if (yBottom - yTop < 2) {
    return fail('invalid-input', [{
      severity: 'error', code: 'lane/degenerate-span',
      message: '泳道纵向跨度不足，无法拟合曲线',
      path: 'centerline',
      position: { pixel: { x: centerline[0].x, y: yTop } },
    }]);
  }
  // x = a + c * t^2 的最小二乘
  let sTT = 0, sT = 0, sX = 0, sTX = 0;
  const n = centerline.length;
  for (const p of centerline) {
    const t = (p.y - yTop) / (yBottom - yTop);
    const u = t * t;
    sTT += u * u; sT += u; sX += p.x; sTX += u * p.x;
  }
  const det = sTT * n - sT * sT;
  if (Math.abs(det) < 1e-9) {
    return fail('semantic-unresolvable', [{
      severity: 'error', code: 'lane/fit-singular',
      message: '中心线采样退化，曲线拟合矩阵奇异',
      path: 'centerline',
    }]);
  }
  const curvature = (sTX * n - sT * sX) / det;
  const x0 = (sX - curvature * sT) / n;
  return ok({ x0, curvature, yTop, yBottom });
}
