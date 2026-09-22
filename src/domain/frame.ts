import type { PixelPoint } from './core';

/** 拍摄方向：原图旋转角度（顺时针，使泳道竖直、加样孔在上） */
export interface Orientation {
  rotationDeg: 0 | 90 | 180 | 270;
  note?: string;
}

export interface ImageSize {
  width: number;
  height: number;
}

/** image 帧 -> analysis 帧（派生层才做归一化，原始表示保留在材料里） */
export function toAnalysis(p: PixelPoint, size: ImageSize, rot: number): PixelPoint {
  const r = ((rot % 360) + 360) % 360;
  const { width: w, height: h } = size;
  switch (r) {
    case 0:
      return { x: p.x, y: p.y, frame: 'analysis' };
    case 90:
      return { x: h - 1 - p.y, y: p.x, frame: 'analysis' };
    case 180:
      return { x: w - 1 - p.x, y: h - 1 - p.y, frame: 'analysis' };
    case 270:
      return { x: p.y, y: w - 1 - p.x, frame: 'analysis' };
    default:
      throw new Error(`unsupported rotation ${rot}`);
  }
}

export function analysisSize(size: ImageSize, rot: number): ImageSize {
  const r = ((rot % 360) + 360) % 360;
  return r === 90 || r === 270 ? { width: size.height, height: size.width } : size;
}

/** analysis 帧 -> image 帧（逆变换，用于把派生标注叠回原图） */
export function toImage(p: PixelPoint, size: ImageSize, rot: number): PixelPoint {
  const r = ((rot % 360) + 360) % 360;
  const { width: w, height: h } = size;
  switch (r) {
    case 0:
      return { x: p.x, y: p.y, frame: 'image' };
    case 90:
      return { x: p.y, y: h - 1 - p.x, frame: 'image' };
    case 180:
      return { x: w - 1 - p.x, y: h - 1 - p.y, frame: 'image' };
    case 270:
      return { x: h - 1 - p.y, y: p.x, frame: 'image' };
    default:
      throw new Error(`unsupported rotation ${rot}`);
  }
}
