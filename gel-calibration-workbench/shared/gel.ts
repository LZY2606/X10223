import type { Point } from './types.js';
import { blank, paintBand, type GrayImage } from './image.js';
import { frameDims, rotate90CW } from './geometry.js';

/** 合成凝胶场景描述——案例包领域材料（不是通用表格） */
export interface GelSpec {
  width: number;
  height: number;
  /** 每条泳道中心线 x(y)：直线或 smile 弯曲 */
  lanes: Array<{
    x0: number;
    /** 弯曲系数：c * (y-mid)^2，smile 为负（中间向上凸） */
    curvatureC?: number;
    halfWidth: number;
  }>;
  bands: Array<{
    lane: number;
    y: number;
    rx?: number;
    ry?: number;
    intensity?: number;
    saturate?: boolean;
    skew?: number;
    tailDown?: number;
  }>;
  noise?: number;
}

export function laneCenterX(spec: GelSpec['lanes'][number], y: number, h: number): number {
  const c = spec.curvatureC ?? 0;
  return spec.x0 + c * (y - h / 2) ** 2;
}

export function synthesizeGel(spec: GelSpec): { image: GrayImage; centers: Point[][] } {
  const image = blank(spec.width, spec.height, 22);
  // 轻微背景纹理与边缘暗角
  for (let y = 0; y < spec.height; y++) {
    for (let x = 0; x < spec.width; x++) {
      const vig = 1 - 0.12 * (Math.abs(x - spec.width / 2) / (spec.width / 2));
      image.data[y * spec.width + x] = Math.round(22 * vig + (spec.noise ?? 4) * (Math.random() - 0.5));
    }
  }
  const centers: Point[][] = spec.lanes.map((lane) => {
    const pts: Point[] = [];
    for (let y = 8; y < spec.height - 8; y += 12) {
      pts.push({ x: Math.round(laneCenterX(lane, y, spec.height)), y });
    }
    return pts;
  });

  for (const b of spec.bands) {
    const lane = spec.lanes[b.lane]!;
    const center = { x: Math.round(laneCenterX(lane, b.y, spec.height)), y: b.y };
    paintBand(image, center, b.rx ?? 13, b.ry ?? 4.5, b.intensity ?? 120, {
      saturate: b.saturate,
      skew: b.skew,
      tailDown: b.tailDown,
    });
  }
  return { image, centers };
}

/** 两条重叠带：在同一泳道近距离绘制两个峰 */
export function paintOverlapPair(
  image: GrayImage,
  c: Point,
  sep: number,
): { a: Point; b: Point } {
  paintBand(image, { x: c.x, y: c.y - sep / 2 }, 12, 4.5, 95);
  paintBand(image, { x: c.x, y: c.y + sep / 2 }, 12, 4.5, 95);
  return { a: { x: c.x, y: c.y - sep / 2 }, b: { x: c.x, y: c.y + sep / 2 } };
}

export function rotateImage(img: GrayImage, deg: 0 | 90 | 180 | 270): GrayImage {
  let out = img;
  const steps = ((deg % 360) / 90) as 0 | 1 | 2 | 3;
  for (let i = 0; i < steps; i++) out = rotate90CW(out);
  return out;
}

export function rotatedDims(w: number, h: number, deg: 0 | 90 | 180 | 270) {
  return frameDims(w, h, deg);
}
