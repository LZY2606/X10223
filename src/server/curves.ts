import type { PixelPoint } from '../shared/types.js';

// 微笑曲线折线点（自井口 s=0 起）
export function smilingLanePoints(x0: number, y0: number, length: number, amp: number): PixelPoint[] {
  const pts: PixelPoint[] = [];
  const N = 24;
  for (let k = 0; k <= N; k++) {
    const s = (length * k) / N;
    pts.push({ x: Math.round(x0 + amp * Math.sin((s / length) * Math.PI)), y: y0 + Math.round(s) });
  }
  return pts;
}
