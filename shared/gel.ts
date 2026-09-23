import { encodeGrayPNG } from './png.js';
import type { PixelPoint } from './types.js';

// 确定性的合成凝胶：所有几何都输出像素级来源，供测试与离线案例包使用。

export interface GelBandSpec {
  s: number;                 // 自加样端（顶部）的弧长 px
  intensity: number;         // 峰值灰度增量
  fwhm: number;              // 半高宽 px
  saturated?: boolean;       // 过饱和：峰顶裁切到 255
  tail?: boolean;            // 拖尾：朝下方拉长的不对称峰
  label?: string;
}

export interface GelLaneSpec {
  index: number;
  baseX: number;
  halfWidth: number;
  /** 弯曲：x(y) 位移幅度 px（蛇形泳道）。 */
  bendX: number;
  /** “微笑”：中部向下弯曲幅度 px，各泳道不同 -> 同高度不同分子量。 */
  smile: number;
  bands: GelBandSpec[];
}

export interface GelSpec {
  width: number;
  height: number;
  topMargin: number;
  lanes: GelLaneSpec[];
  noise?: number;
  seed?: number;
}

export interface RenderedBand {
  laneIndex: number;
  label?: string;
  s: number;
  center: PixelPoint;
  saturated: boolean;
  fwhm: number;
  tail: boolean;
}

export interface RenderedLane {
  index: number;
  baseX: number;
  halfWidth: number;
  spine: PixelPoint[];
  left: PixelPoint[];
  right: PixelPoint[];
  cumulative: number[]; // 各 spine 点累积弧长
  length: number;
}

export interface RenderedGel {
  width: number;
  height: number;
  gray: Uint8Array;
  png: Buffer;
  lanes: RenderedLane[];
  bands: RenderedBand[];
}

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const STEP = 4;

function bow(t: number): number {
  // 0 在两端，1 在中部
  return Math.sin(Math.PI * t);
}

function buildLane(spec: GelLaneSpec, height: number, topMargin: number): RenderedLane {
  const spine: PixelPoint[] = [];
  const usable = height - topMargin - 12;
  for (let y = topMargin; y <= height - 12; y += STEP) {
    const t = (y - topMargin) / usable;
    const x = spec.baseX + spec.bendX * bow(t) * Math.sin(2 * Math.PI * t);
    const yy = y + spec.smile * bow(t);
    spine.push({ x, y: yy });
  }
  const cumulative: number[] = [0];
  for (let i = 1; i < spine.length; i++) {
    const dx = spine[i].x - spine[i - 1].x;
    const dy = spine[i].y - spine[i - 1].y;
    cumulative.push(cumulative[i - 1] + Math.hypot(dx, dy));
  }
  const normal: PixelPoint[] = spine.map((p, i) => {
    const a = spine[Math.min(i + 1, spine.length - 1)];
    const b = spine[Math.max(i - 1, 0)];
    const dx = a.x - b.x; const dy = a.y - b.y;
    const len = Math.hypot(dx, dy) || 1;
    return { x: -dy / len, y: dx / len };
  });
  const left = spine.map((p, i) => ({ x: p.x + normal[i].x * spec.halfWidth, y: p.y + normal[i].y * spec.halfWidth }));
  const right = spine.map((p, i) => ({ x: p.x - normal[i].x * spec.halfWidth, y: p.y - normal[i].y * spec.halfWidth }));
  return { index: spec.index, baseX: spec.baseX, halfWidth: spec.halfWidth, spine, left, right, cumulative, length: cumulative[cumulative.length - 1] };
}

function pointAtArc(lane: RenderedLane, s: number): { point: PixelPoint; normal: PixelPoint } {
  const cum = lane.cumulative;
  let i = 0;
  while (i < cum.length - 1 && cum[i + 1] < s) i++;
  const i1 = Math.min(i + 1, cum.length - 1);
  const span = cum[i1] - cum[i] || 1;
  const f = Math.min(1, Math.max(0, (s - cum[i]) / span));
  const p0 = lane.spine[i]; const p1 = lane.spine[i1];
  const point = { x: p0.x + (p1.x - p0.x) * f, y: p0.y + (p1.y - p0.y) * f };
  const dx = p1.x - p0.x; const dy = p1.y - p0.y;
  const len = Math.hypot(dx, dy) || 1;
  return { point, normal: { x: -dy / len, y: dx / len } };
}

export function renderGel(spec: GelSpec): RenderedGel {
  const { width, height } = spec;
  const gray = new Float32Array(width * height);
  const bg = 28;
  const rng = mulberry32(spec.seed ?? 1234);
  for (let i = 0; i < gray.length; i++) gray[i] = bg + (rng() - 0.5) * 2 * (spec.noise ?? 6);
  const lanes = spec.lanes.map((l) => buildLane(l, height, spec.topMargin));

  for (const lane of lanes) {
    for (const band of spec.lanes[lane.index].bands) {
      const center = pointAtArc(lane, band.s).point;
      const sigma = band.fwhm / 2.3548;
      const reach = Math.ceil(band.fwhm * 2.2) + 2;
      for (let y = Math.floor(center.y - reach); y <= center.y + reach; y++) {
        for (let x = Math.floor(center.x - reach); x <= center.x + reach; x++) {
          if (x < 0 || y < 0 || x >= width || y >= height) continue;
          // 沿中脊的弧长差与法向偏移
          const ds = arcDistance(lane, x, y);
          const dn = normalDistance(lane, x, y);
          if (Math.abs(dn) > lane.halfWidth) continue;
          const gN = Math.exp(-(dn * dn) / (2 * (lane.halfWidth * 0.55) ** 2));
          // 拖尾：下方（s 增大方向）展宽
          const sDiff = ds - band.s;
          const sigmaS = band.tail && sDiff > 0 ? sigma * 2.4 : sigma;
          const gS = Math.exp(-(sDiff * sDiff) / (2 * sigmaS * sigmaS));
          gray[y * width + x] += band.intensity * gN * gS;
        }
      }
    }
  }

  const out = new Uint8Array(width * height);
  const saturatedFlags: boolean[] = [];
  for (const lane of spec.lanes) for (const b of lane.bands) saturatedFlags.push(!!b.saturated);
  void saturatedFlags;
  for (let i = 0; i < gray.length; i++) out[i] = Math.min(255, Math.max(0, Math.round(gray[i])));

  const renderedBands: RenderedBand[] = [];
  spec.lanes.forEach((ls) => {
    for (const b of ls.bands) {
      const { point } = pointAtArc(lanes[ls.index], b.s);
      renderedBands.push({
        laneIndex: ls.index, label: b.label, s: b.s, center: point,
        saturated: !!b.saturated, fwhm: b.fwhm, tail: !!b.tail,
      });
    }
  });

  return { width, height, gray: out, png: encodeGrayPNG(width, height, out), lanes, bands: renderedBands };
}

function locateOnLane(lane: RenderedLane, x: number, y: number): { s: number; d: number; index: number } {
  let best = { dist: Infinity, s: 0, d: 0, index: 0 };
  for (let i = 0; i < lane.spine.length - 1; i++) {
    const a = lane.spine[i]; const b = lane.spine[i + 1];
    const vx = b.x - a.x; const vy = b.y - a.y;
    const len2 = vx * vx + vy * vy || 1;
    let t = ((x - a.x) * vx + (y - a.y) * vy) / len2;
    t = Math.min(1, Math.max(0, t));
    const px = a.x + vx * t; const py = a.y + vy * t;
    const dist = Math.hypot(x - px, y - py);
    if (dist < best.dist) {
      const s = lane.cumulative[i] + t * (lane.cumulative[i + 1] - lane.cumulative[i]);
      best = { dist, s, d: signedNormal(lane, i, x, y), index: i };
    }
  }
  return best;
}

function signedNormal(lane: RenderedLane, i: number, x: number, y: number): number {
  const a = lane.spine[i]; const b = lane.spine[Math.min(i + 1, lane.spine.length - 1)];
  const vx = b.x - a.x; const vy = b.y - a.y;
  const len = Math.hypot(vx, vy) || 1;
  const nx = -vy / len; const ny = vx / len;
  return (x - a.x) * nx + (y - a.y) * ny;
}

function arcDistance(lane: RenderedLane, x: number, y: number): number {
  return locateOnLane(lane, x, y).s;
}
function normalDistance(lane: RenderedLane, x: number, y: number): number {
  return locateOnLane(lane, x, y).d;
}

export function lanePointAtArc(lane: RenderedLane, s: number) {
  return pointAtArc(lane, s);
}

// 图像旋转（双线性），输出新图像与 2x3 仿射（旧坐标 -> 新坐标）。
export interface RotatedImage {
  width: number;
  height: number;
  gray: Uint8Array;
  png: Buffer;
  transform: { a: number; b: number; tx: number; c: number; d: number; ty: number };
}

export function rotateImage(src: { width: number; height: number; gray: Uint8Array }, deg: number): RotatedImage {
  const theta = (deg * Math.PI) / 180;
  const cos = Math.cos(theta); const sin = Math.sin(theta);
  const w = src.width; const h = src.height;
  // 新画布包围盒（旋转后再平移到全正）
  const corners = [
    { x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y },
  ].map((p) => ({ x: cos * p.x - sin * p.y, y: sin * p.x + cos * p.y }));
  const minX = Math.min(...corners.map((p) => p.x));
  const maxX = Math.max(...corners.map((p) => p.x));
  const minY = Math.min(...corners.map((p) => p.y));
  const maxY = Math.max(...corners.map((p) => p.y));
  const nw = Math.ceil(maxX - minX); const nh = Math.ceil(maxY - minY);
  const tx = -minX; const ty = -minY;
  const out = new Uint8Array(nw * nh);
  const sample = (x: number, y: number): number => {
    if (x < 0 || y < 0 || x > w - 1 || y > h - 1) return 28;
    const x0 = Math.floor(x); const y0 = Math.floor(y);
    const fx = x - x0; const fy = y - y0;
    const x1 = Math.min(w - 1, x0 + 1); const y1 = Math.min(h - 1, y0 + 1);
    const v00 = src.gray[y0 * w + x0]; const v10 = src.gray[y0 * w + x1];
    const v01 = src.gray[y1 * w + x0]; const v11 = src.gray[y1 * w + x1];
    return v00 * (1 - fx) * (1 - fy) + v10 * fx * (1 - fy) + v01 * (1 - fx) * fy + v11 * fx * fy;
  };
  for (let ny = 0; ny < nh; ny++) {
    for (let nx = 0; nx < nw; nx++) {
      // 逆变换：旧 = R^-1 (新 - t)
      const dx = nx - tx; const dy = ny - ty;
      const ox = cos * dx + sin * dy;
      const oy = -sin * dx + cos * dy;
      out[ny * nw + nx] = Math.round(sample(ox, oy));
    }
  }
  return {
    width: nw, height: nh, gray: out, png: encodeGrayPNG(nw, nh, out),
    transform: { a: cos, b: -sin, tx, c: sin, d: cos, ty },
  };
}
