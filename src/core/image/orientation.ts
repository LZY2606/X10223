import type { Angle90, PxPoint } from '../types';

export interface OrientedImage {
  width: number;
  height: number;
  gray: Uint8Array;
  rotationCw: Angle90;
  flipH: boolean;
}

/** 顺时针旋转：返回旋转后的灰度（中间视图）。 */
function rotateCw(width: number, height: number, gray: Uint8Array, deg: Angle90): OrientedImage {
  if (deg === 0) return { width, height, gray: gray.slice(), rotationCw: 0, flipH: false };
  const w = deg === 180 ? width : height;
  const h = deg === 180 ? height : width;
  const out = new Uint8Array(w * h);
  for (let vy = 0; vy < h; vy++) {
    for (let vx = 0; vx < w; vx++) {
      let sx = vx;
      let sy = vy;
      if (deg === 90) {
        sx = height - 1 - vy;
        sy = vx;
      } else if (deg === 180) {
        sx = width - 1 - vx;
        sy = height - 1 - vy;
      } else {
        sx = vy;
        sy = width - 1 - vx;
      }
      out[vy * w + vx] = gray[sy * width + sx];
    }
  }
  return { width: w, height: h, gray: out, rotationCw: deg, flipH: false };
}

/** 依据拍摄方向变换到审阅坐标系：先旋转，再水平翻转。原图像素永不修改。 */
export function applyOrientation(
  width: number,
  height: number,
  gray: Uint8Array,
  rotationCw: Angle90,
  flipH: boolean
): OrientedImage {
  const rot = rotateCw(width, height, gray, rotationCw);
  if (!flipH) return rot;
  const out = new Uint8Array(rot.width * rot.height);
  for (let y = 0; y < rot.height; y++) {
    for (let x = 0; x < rot.width; x++) {
      out[y * rot.width + x] = rot.gray[y * rot.width + (rot.width - 1 - x)];
    }
  }
  return { ...rot, gray: out, flipH: true };
}

/** 审阅视图坐标 → 原始像素坐标（翻转的逆仍是翻转）。 */
export function viewToRaw(
  p: PxPoint,
  rawW: number,
  rawH: number,
  rotationCw: Angle90,
  flipH: boolean
): PxPoint {
  // 逆翻转
  const viewW = rotationCw === 90 || rotationCw === 270 ? rawH : rawW;
  let vx = flipH ? viewW - 1 - p.x : p.x;
  const vy = p.y;
  // 逆旋转
  let x = vx;
  let y = vy;
  if (rotationCw === 90) {
    x = vy;
    y = rawH - 1 - vx;
  } else if (rotationCw === 180) {
    x = rawW - 1 - vx;
    y = rawH - 1 - vy;
  } else if (rotationCw === 270) {
    x = rawW - 1 - vy;
    y = vx;
  }
  return { x, y, basis: 'raw-image-px' };
}
