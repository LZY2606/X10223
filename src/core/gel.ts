// 离线合成凝胶图像：生成领域专用素材（不是通用表格）。
// 亮胶暗带，8-bit 灰度。lane 中心线可用“微笑”弯曲函数，直接驱动后续检测与标定。
import { encodeGrayPng } from './png';
import { pointOnPolyline, polylineArcLength, type Vec2 } from './geometry';

export interface GelBandSpec {
  /** 迁移位置：距 lane 顶部的纵向比例 0..1（沿弯曲中心线弧长）。 */
  frac: number;
  /** 峰高（暗度 0..255，反色后强度）。 */
  amplitude: number;
  /** 横向半宽 px；纵向半高 px（沿中心线垂直方向）。 */
  sigmaX: number;
  sigmaY: number;
  /** 饱和：超过 255 的部分削顶，形成平顶。 */
  saturate?: boolean;
  id?: string;
}

export interface GelLaneSpec {
  laneIndex: number;
  isLadder?: boolean;
  bands: GelBandSpec[];
}

export interface GelSynthesisOptions {
  width?: number;
  height?: number;
  laneXs?: number[];
  laneHalfWidth?: number;
  topMargin?: number;
  bottomMargin?: number;
  /** “微笑”弯曲幅度 px：lane 中部相对两端的横向位移。 */
  smileAmp?: number;
  background?: number; // 灰度（亮）
  noise?: number;
  /** 纵向拖尾：在带下方叠加指数尾。 */
  tail?: boolean;
}

export interface SynthesizedGel {
  png: Uint8Array;
  width: number;
  height: number;
  /** 每条 lane 的中心线折线（分析帧像素，等弧长采样）。 */
  centerlines: { laneIndex: number; points: Vec2[]; length: number }[];
  /** 生成的带中心真值（像素，分析帧）。 */
  bandTruth: { laneIndex: number; bandIndex: number; point: Vec2; frac: number }[];
}

/** lane 中心线：x(m) = x0 + amp * sin(pi * m/L)，弧长沿曲线。 */
export function laneCenterX(x0: number, smileAmp: number, frac: number): number {
  return x0 + smileAmp * Math.sin(Math.PI * frac);
}

export function buildCenterline(
  x0: number,
  width: number,
  height: number,
  topMargin: number,
  bottomMargin: number,
  smileAmp: number
): { points: Vec2[]; length: number } {
  const startY = topMargin;
  const endY = height - bottomMargin;
  const points: Vec2[] = [];
  const N = 200;
  for (let i = 0; i <= N; i++) {
    const frac = i / N;
    points.push({ x: laneCenterX(x0, smileAmp, frac), y: startY + frac * (endY - startY) });
  }
  return { points, length: polylineArcLength(points) };
}

export function synthesizeGel(lanes: GelLaneSpec[], opts: GelSynthesisOptions = {}): SynthesizedGel {
  const width = opts.width ?? 480;
  const height = opts.height ?? 360;
  const laneHalfWidth = opts.laneHalfWidth ?? 26;
  const topMargin = opts.topMargin ?? 24;
  const bottomMargin = opts.bottomMargin ?? 24;
  const smileAmp = opts.smileAmp ?? 0;
  const bg = opts.background ?? 228;
  const noise = opts.noise ?? 3;
  const laneXs =
    opts.laneXs ?? lanes.map((_, i) => 40 + i * ((width - 80) / Math.max(1, lanes.length - 1)));

  const gray = new Uint8Array(width * height).fill(bg);
  const centerlines = laneXs.map((x0, laneIndex) => {
    const cl = buildCenterline(x0, width, height, topMargin, bottomMargin, smileAmp);
    return { laneIndex, ...cl };
  });

  const bandTruth: SynthesizedGel['bandTruth'] = [];

  // 先画 lane 底色（略暗于背景），再画带。
  for (const cl of centerlines) {
    for (let m = 0; m <= cl.length; m += 1) {
      const p = pointOnPolyline(cl.points, m);
      for (let dx = -laneHalfWidth; dx <= laneHalfWidth; dx++) {
        const xi = Math.round(p.x + dx);
        const yi = Math.round(p.y);
        if (xi >= 0 && xi < width && yi >= 0 && yi < height) gray[yi * width + xi] = bg - 10;
      }
    }
  }

  for (const lane of lanes) {
    const cl = centerlines.find((c) => c.laneIndex === lane.laneIndex)!;
    lane.bands.forEach((band, bandIndex) => {
      const m = band.frac * cl.length;
      const center = pointOnPolyline(cl.points, m);
      bandTruth.push({ laneIndex: lane.laneIndex, bandIndex, point: center, frac: band.frac });
      // 对每个像素计算高斯暗度（沿 lane 法向近似：横向 sigmaX、纵向 sigmaY）。
      const range = Math.ceil(Math.max(band.sigmaX, band.sigmaY) * 3) + 2;
      for (let yi = Math.max(0, Math.floor(center.y - range)); yi < Math.min(height, Math.ceil(center.y + range)); yi++) {
        for (let xi = Math.max(0, Math.floor(center.x - range)); xi < Math.min(width, Math.ceil(center.x + range)); xi++) {
          const gx = (xi - center.x) / band.sigmaX;
          const gy = (yi - center.y) / band.sigmaY;
          let dark = band.amplitude * Math.exp(-0.5 * (gx * gx + gy * gy));
          if (band.saturate && dark > 255 - bg + 20) dark = 255 - bg; // 平顶
          if (opts.tail && yi > center.y) dark *= Math.exp(-(yi - center.y) / 14); // 向下拖尾
          const idx = yi * width + xi;
          gray[idx] = Math.max(0, Math.min(255, gray[idx] - dark));
        }
      }
    });
  }

  if (noise > 0) {
    let seed = 1337;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    for (let i = 0; i < gray.length; i++) {
      const n = (rnd() - 0.5) * 2 * noise;
      gray[i] = Math.max(0, Math.min(255, gray[i] + n));
    }
  }

  return { png: encodeGrayPng(width, height, gray), width, height, centerlines, bandTruth };
}

/** 顺时针旋转灰度像素（用于“旋转图像”反例）。 */
export function rotateGrayPixels(
  gray: Uint8Array,
  w: number,
  h: number,
  deg: number
): { data: Uint8Array; width: number; height: number } {
  const norm = ((deg % 360) + 360) % 360;
  if (norm === 0) return { data: gray, width: w, height: h };
  const cw = norm === 90;
  const ccw = norm === 270;
  const flip = norm === 180;
  const nw = cw || ccw ? h : w;
  const nh = cw || ccw ? w : h;
  const out = new Uint8Array(nw * nh).fill(228);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = gray[y * w + x];
      let nx = x;
      let ny = y;
      if (cw) { nx = h - 1 - y; ny = x; }
      else if (ccw) { nx = y; ny = w - 1 - x; }
      else if (flip) { nx = w - 1 - x; ny = h - 1 - y; }
      out[ny * nw + nx] = v;
    }
  }
  return { data: out, width: nw, height: nh };
}
