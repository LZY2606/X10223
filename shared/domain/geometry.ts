import type { PixelBasis, PixelPoint, SourcedPoint } from './types';

export interface ImageDims {
  widthPx: number;
  heightPx: number;
}

/**
 * 把携带来源基准的点换算到分析坐标系（as-shot, top-left）。
 * 旋转图像只改基准不改原图；基准与图像声明方向不一致时返回 null（调用方出诊断）。
 */
export function toCanonical(
  p: SourcedPoint,
  imageOrientation: PixelBasis['orientation'],
  dims: ImageDims,
): PixelPoint | null {
  if (p.basis.orientation !== imageOrientation) return null;
  const { x, y } = p;
  switch (p.basis.orientation) {
    case 'as-shot':
      return { x, y };
    case 'rotated-90': // 图像顺时针转了 90°：分析坐标 = 逆变换
      return { x: y, y: dims.widthPx - 1 - x };
    case 'rotated-180':
      return { x: dims.widthPx - 1 - x, y: dims.heightPx - 1 - y };
    case 'rotated-270':
      return { x: dims.heightPx - 1 - y, y: x };
  }
}

export function fromCanonical(
  p: PixelPoint,
  orientation: PixelBasis['orientation'],
  dims: ImageDims,
): PixelPoint {
  const { x, y } = p;
  switch (orientation) {
    case 'as-shot':
      return { x, y };
    case 'rotated-90':
      return { x: dims.widthPx - 1 - y, y: x };
    case 'rotated-180':
      return { x: dims.widthPx - 1 - x, y: dims.heightPx - 1 - y };
    case 'rotated-270':
      return { x: y, y: dims.heightPx - 1 - x };
  }
}
