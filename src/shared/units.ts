/** 单位与坐标基准：所有领域量必须携带单位；像素量必须声明坐标系。 */

export type Unit = 'px' | 'bp' | 'log10bp' | 'deg' | 'ms' | 'count' | 'rf';

export interface Quantity<U extends Unit = Unit> {
  value: number;
  unit: U;
}

export function qty<U extends Unit>(value: number, unit: U): Quantity<U> {
  return { value, unit };
}

/** 像素坐标必须声明所在坐标系：image=原始图像像素；display=施加拍摄方向后的显示像素 */
export type PixelFrame = 'image' | 'display';

export interface PixelPoint {
  x: number;
  y: number;
  unit: 'px';
  frame: PixelFrame;
}

export function px(x: number, y: number, frame: PixelFrame = 'image'): PixelPoint {
  return { x, y, unit: 'px', frame };
}

export interface PixelWindow {
  x0: number; y0: number; x1: number; y1: number;
  unit: 'px';
  frame: PixelFrame;
}

/** 显示变换：只描述观察方向，不改写原始像素 */
export interface DisplayTransform {
  rotationDeg: 0 | 90 | 180 | 270;
  mirrored: boolean;
}

export function applyDisplayTransform(
  p: { x: number; y: number },
  t: DisplayTransform,
  width: number,
  height: number,
): { x: number; y: number } {
  let { x, y } = p;
  if (t.mirrored) x = width - 1 - x;
  switch (t.rotationDeg) {
    case 0: return { x, y };
    case 90: return { x: height - 1 - y, y: x };
    case 180: return { x: width - 1 - x, y: height - 1 - y };
    case 270: return { x: y, y: width - 1 - x };
  }
}

export function displaySize(t: DisplayTransform, width: number, height: number): { width: number; height: number } {
  return t.rotationDeg === 90 || t.rotationDeg === 270
    ? { width: height, height: width }
    : { width, height };
}
