import type { FrameMaterial, ImageMaterial, OrientationMode } from '../shared/events.js';
import type { Point, SourcedPoint } from '../shared/units.js';

/** 帧变换：给出帧内坐标 -> 原图坐标 */
export function frameToImage(frame: FrameMaterial): (p: Point) => Point {
  const w = frame.width;
  const h = frame.height;
  switch (frame.orientation) {
    case 'canonical':
      return (p) => ({ x: p.x, y: p.y });
    case 'rotate-90':
      // 帧是原图顺时针 90°：帧宽 = 原图高
      return (p) => ({ x: p.y, y: w - 1 - p.x });
    case 'rotate-180':
      return (p) => ({ x: w - 1 - p.x, y: h - 1 - p.y });
    case 'rotate-270':
      return (p) => ({ x: w - 1 - p.y, y: p.x });
  }
}

export function orientationSize(
  mode: OrientationMode,
  imgW: number,
  imgH: number,
): { width: number; height: number } {
  return mode === 'canonical' || mode === 'rotate-180'
    ? { width: imgW, height: imgH }
    : { width: imgH, height: imgW };
}

/** 采样旋转后的帧图像（用于检测与显示） */
export function rasterInFrame(image: ImageMaterial, mode: OrientationMode): Uint8Array {
  const { width, height } = orientationSize(mode, image.width, image.height);
  const out = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let ix: number, iy: number;
      switch (mode) {
        case 'canonical': ix = x; iy = y; break;
        case 'rotate-90': ix = y; iy = image.width - 1 - x; break;
        case 'rotate-180': ix = image.width - 1 - x; iy = image.height - 1 - y; break;
        case 'rotate-270': ix = image.height - 1 - y; iy = x; break;
      }
      out[y * width + x] = image.raster[iy * image.width + ix];
    }
  }
  return out;
}

/** Catmull-Rom 样条加密为折线 */
export function sampleSpline(controls: Point[], samplesPerSeg = 24): Point[] {
  if (controls.length < 2) return controls.slice();
  const pts: Point[] = [];
  const cps = [controls[0], ...controls, controls[controls.length - 1]];
  for (let i = 0; i < cps.length - 3; i++) {
    const p0 = cps[i], p1 = cps[i + 1], p2 = cps[i + 2], p3 = cps[i + 3];
    for (let j = 0; j < samplesPerSeg; j++) {
      const t = j / samplesPerSeg;
      const t2 = t * t, t3 = t2 * t;
      pts.push({
        x: 0.5 * (2 * p1.x + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
        y: 0.5 * (2 * p1.y + (-p0.y + p2.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3),
      });
    }
  }
  pts.push(controls[controls.length - 1]);
  return pts;
}

export interface ArcCurve {
  points: Point[];
  /** 每个点的累计弧长（像素） */
  arc: number[];
  totalArc: number;
}

export function buildArcCurve(controls: SourcedPoint[]): ArcCurve {
  const points = sampleSpline(controls);
  const arc = [0];
  for (let i = 1; i < points.length; i++) {
    arc.push(arc[i - 1] + Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y));
  }
  return { points, arc, totalArc: arc[arc.length - 1] };
}

/** 弧长 -> 曲线上点与切线（迁移方向） */
export function pointAtArc(curve: ArcCurve, s: number): { point: Point; tangent: Point } {
  const { points, arc } = curve;
  const sClamped = Math.max(0, Math.min(curve.totalArc, s));
  let i = 1;
  while (i < arc.length - 1 && arc[i] < sClamped) i++;
  const a = points[i - 1], b = points[i];
  const span = arc[i] - arc[i - 1] || 1;
  const t = (sClamped - arc[i - 1]) / span;
  return {
    point: { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t },
    tangent: { x: (b.x - a.x) / span, y: (b.y - a.y) / span },
  };
}

/** 中心线相对首尾直线的最大法向偏离（微笑量） */
export function curvatureOffset(controls: SourcedPoint[]): number {
  if (controls.length < 2) return 0;
  const a = controls[0], b = controls[controls.length - 1];
  const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  let max = 0;
  for (const p of controls) {
    const cross = Math.abs((b.x - a.x) * (a.y - p.y) - (b.y - a.y) * (a.x - p.x));
    max = Math.max(max, cross / len);
  }
  return max;
}

/**
 * 沿弯曲泳道提取强度轮廓：在每个弧长处，沿曲线法向、半宽内采样取均值。
 * 关键：弯曲泳道上“同一像素高度 y”不等于同一分子量，必须用弧长坐标。
 */
export function laneProfile(
  frame: { width: number; height: number; raster: Uint8Array },
  controls: SourcedPoint[],
  halfWidth: number,
): { arc: number[]; intensity: number[] } {
  const curve = buildArcCurve(controls);
  const step = 1;
  const arc: number[] = [];
  const intensity: number[] = [];
  for (let s = 0; s <= curve.totalArc; s += step) {
    const { point, tangent } = pointAtArc(curve, s);
    const nx = -tangent.y, ny = tangent.x;
    let sum = 0, count = 0;
    for (let w = -halfWidth; w <= halfWidth; w++) {
      const x = Math.round(point.x + nx * w);
      const y = Math.round(point.y + ny * w);
      if (x >= 0 && y >= 0 && x < frame.width && y < frame.height) {
        sum += frame.raster[y * frame.width + x];
        count++;
      }
    }
    arc.push(s);
    intensity.push(count ? sum / count : 0);
  }
  return { arc, intensity };
}
