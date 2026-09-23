/**
 * 确定性合成原始凝胶图像。
 * 不依赖外部图片文件；所有条带位置/强度/几何均可像素级复现，
 * 以便“只改动一个直接来源”地检验旋转、弯曲、缺带、饱和、重叠、非单调等。
 */
import { pt } from './geometry.js';
import type { PixelPoint } from '../shared/types.js';

export interface GelBandSpec {
  /** 沿泳道自 well 起的弧长位置（像素，未弯曲基准）。 */
  s: number;
  /** 峰强度 0..255 增量。 */
  amp: number;
  /** 纵向 sigma（像素）。 */
  sigmaY: number;
  /** 横向 sigma（像素）。 */
  sigmaX: number;
  saturated?: boolean;
  tail?: boolean;
  /** 重叠组：同组两条带被刻意靠近，检测只能给区间/候选。 */
  overlapGroup?: string;
  label?: string;
}

export interface GelLaneSpec {
  laneId: string;
  label: string;
  role: 'ladder' | 'sample';
  xCenter: number;
  /** 微笑曲率（中部 y 偏移量，像素）。0 为直泳道。 */
  smile: number;
  bands: GelBandSpec[];
}

export interface GelImageSpec {
  width: number;
  height: number;
  lanes: GelLaneSpec[];
  background: number;
  noise: number;
  seed: number;
}

export interface GeneratedGel {
  width: number;
  height: number;
  gray: Uint8Array;
  grayBase64: string;
  lanes: GelLaneSpec[];
  /** 每条带在最终像素缓冲中的真实中心（含弯曲）。 */
  truth: Array<{ laneId: string; label?: string; center: PixelPoint; arcLength: number; peakGray: number }>;
}

/** 可复现 PRNG（mulberry32）。 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function encodeGray(gray: Uint8Array): string {
  return Buffer.from(gray).toString('base64');
}

export function decodeGray(b64: string): Uint8Array {
  return new Uint8Array(Buffer.from(b64, 'base64'));
}

/** 标准泳道标称（DNA, bp），自 well 起：大->小。 */
export const DNA_LADDER_BP = [1500, 1000, 750, 500, 250, 100];

export function laneCurvePoints(xCenter: number, smile: number, yWell: number, yEnd: number, coordinateSystem: string, steps = 64): PixelPoint[] {
  const pts: PixelPoint[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const y = yWell + (yEnd - yWell) * t;
    const bend = smile * 4 * t * (1 - t);
    pts.push(pt(xCenter, y + bend, coordinateSystem));
  }
  return pts;
}

function polylineAt(points: PixelPoint[], s: number): PixelPoint {
  let acc = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const seg = Math.hypot(b.x - a.x, b.y - a.y);
    if (acc + seg >= s) {
      const t = (s - acc) / (seg || 1);
      return pt(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, a.coordinateSystem);
    }
    acc += seg;
  }
  return { ...points[points.length - 1] };
}

export function polylineLengthOf(points: PixelPoint[]): number {
  let len = 0;
  for (let i = 1; i < points.length; i++) len += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
  return len;
}

export function generateGel(spec: GelImageSpec): GeneratedGel {
  const { width, height } = spec;
  const gray = new Uint8Array(width * height);
  const rnd = mulberry32(spec.seed);
  const yWell = 24;
  const yEnd = height - 16;
  const truth: GeneratedGel['truth'] = [];

  // 背景 + 弱纵向梯度 + 噪声
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const grad = 6 * (y / height);
      const n = (rnd() - 0.5) * spec.noise;
      gray[y * width + x] = Math.max(0, Math.min(255, spec.background + grad + n));
    }
  }

  for (const lane of spec.lanes) {
    const points = laneCurvePoints(lane.xCenter, lane.smile, yWell, yEnd, 'synthetic');
    for (const band of lane.bands) {
      const c = polylineAt(points, band.s);
      let amp = band.amp;
      if (band.saturated) amp = 320; // 击穿 255
      // 画高斯（x 方向高斯，y 方向高斯，拖尾向下延展）
      const rx = Math.ceil(band.sigmaX * 3 + 2);
      const ry = Math.ceil(band.sigmaY * (band.tail ? 7 : 3) + 2);
      for (let y = Math.max(0, Math.floor(c.y - ry)); y <= Math.min(height - 1, Math.ceil(c.y + ry)); y++) {
        for (let x = Math.max(0, Math.floor(c.x - rx)); x <= Math.min(width - 1, Math.ceil(c.x + rx)); x++) {
          const gx = Math.exp(-((x - c.x) ** 2) / (2 * band.sigmaX ** 2));
          let gy = Math.exp(-((y - c.y) ** 2) / (2 * band.sigmaY ** 2));
          if (band.tail && y > c.y) {
            gy = Math.max(gy, Math.exp(-(y - c.y) / (band.sigmaY * 3)) * 0.6);
          }
          const idx = y * width + x;
          gray[idx] = Math.max(0, Math.min(255, gray[idx] + amp * gx * gy));
        }
      }
      truth.push({
        laneId: lane.laneId,
        label: band.label,
        center: pt(c.x, c.y, 'synthetic'),
        arcLength: band.s,
        peakGray: Math.min(255, spec.background + amp),
      });
    }
  }

  return { width, height, gray, grayBase64: encodeGray(gray), lanes: spec.lanes, truth };
}

/** 旋转灰度图（90/180/270），用于“旋转图像”反例：只改拍摄方向这一直接来源。 */
export function rotateGray(gray: Uint8Array, w: number, h: number, deg: 90 | 180 | 270): { gray: Uint8Array; width: number; height: number } {
  if (deg === 180) {
    const out = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out[(h - 1 - y) * w + (w - 1 - x)] = gray[y * w + x];
    return { gray: out, width: w, height: h };
  }
  const out = new Uint8Array(w * h);
  const nw = h;
  const nh = w;
  const out2 = new Uint8Array(nw * nh);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = gray[y * w + x];
      if (deg === 90) out2[(w - 1 - x) * nw + y] = v; // 顺时针 90
      else out2[x * nw + (h - 1 - y)] = v; // 顺时针 270
    }
  }
  return { gray: out2, width: nw, height: nh };
}

/**
 * 基线凝胶：1 条 ladder 泳道 + 3 条样品泳道（其中样品 2 轻度微笑，
 * 用来检验“同一高度不等于同一分子量”，局部标尺带有效区域）。
 */
export function baselineGelSpec(): GelImageSpec {
  const W = 320;
  const H = 300;
  const laneX = [48, 120, 192, 264];
  const sPositions = [40, 80, 120, 160, 200, 240]; // 对应 6 个 ladder 标称
  const ladderBands = DNA_LADDER_BP.map((bp, i) => ({
    s: sPositions[i],
    amp: 150 - i * 8,
    sigmaY: 4.2,
    sigmaX: 10,
    label: `${bp}bp`,
  }));

  // 样品泳道：取若干分子量（bp），通过与 ladder 相同的 s(MW) 关系放置
  const sByMw = (bp: number) => {
    const logs = DNA_LADDER_BP.map((v) => Math.log10(v));
    const target = Math.log10(bp);
    // s 随 logMW 线性下降；用两端点拟合（这里用 1500@40 -> 100@240）
    // 用分段：找到相邻标称线性插值 s
    for (let i = 0; i < DNA_LADDER_BP.length - 1; i++) {
      const hi = DNA_LADDER_BP[i];
      const lo = DNA_LADDER_BP[i + 1];
      if (bp <= hi && bp >= lo) {
        const lh = Math.log10(hi);
        const ll = Math.log10(lo);
        const t = (lh - target) / (lh - ll);
        return sPositions[i] + t * (sPositions[i + 1] - sPositions[i]);
      }
    }
    return bp > DNA_LADDER_BP[0] ? sPositions[0] : sPositions[sPositions.length - 1];
  };

  const sampleBands = (bps: number[]) =>
    bps.map((bp) => ({ s: sByMw(bp), amp: 140, sigmaY: 4.2, sigmaX: 10, label: `${bp}bp` }));

  return {
    width: W,
    height: H,
    background: 28,
    noise: 5,
    seed: 1194,
    lanes: [
      { laneId: 'L0', label: 'Ladder', role: 'ladder', xCenter: laneX[0], smile: 0, bands: ladderBands },
      { laneId: 'L1', label: 'Sample A', role: 'sample', xCenter: laneX[1], smile: 0, bands: sampleBands([1200, 600, 300]) },
      // 微笑泳道：几何弯曲，但其带仍按自身弧长放置，凸显弧长标尺 vs 高度标尺
      { laneId: 'L2', label: 'Sample B (smile)', role: 'sample', xCenter: laneX[2], smile: 22, bands: sampleBands([900, 500, 180]) },
      { laneId: 'L3', label: 'Sample C', role: 'sample', xCenter: laneX[3], smile: 0, bands: sampleBands([1300, 400]) },
    ],
  };
}
