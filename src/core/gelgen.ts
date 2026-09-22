import { encodePng, type RawImage } from './png';
import { rotateCW } from './geometry';

/**
 * 领域合成凝胶：不是通用表格，而是按电泳成像物理构造的灰阶图像。
 * - 亮带（EB 荧光风格）、暗背景
 * - 泳道沿中心线“弯曲”，条带沿弧长定位（微笑弯曲：同 y ≠ 同分子量）
 * - 可构造：旋转、缺带、饱和、拖尾、重叠、非单调标称
 */

export const GEL_W = 480;
export const GEL_H = 640;
export const WELL_Y = 34;
export const FRONT_Y = 600;
export const LANE_CENTERS_X = [60, 130, 200, 270, 340, 410];
export const LANE_HALF_WIDTH = 22;

export const DEFAULT_LADDER_BP = [10000, 7000, 5000, 3000, 2000, 1500, 1000, 700, 500, 200];

/** 标准分子量-迁移关系：log10(bp) 对 t 线性 */
export function tForBp(bp: number): number {
  const logA = Math.log10(10000);
  const logB = Math.log10(200);
  const f = (logA - Math.log10(bp)) / (logA - logB);
  return WELL_Y + f * (FRONT_Y - WELL_Y);
}

export interface SpecBand {
  laneIndex: number;
  bp: number;
  amp?: number;
  /** 拖尾（向下不对称） */
  tail?: boolean;
  /** 饱和（超满量程） */
  saturate?: boolean;
  /** 水平/纵向加宽（重叠构造） */
  sigmaX?: number;
  sigmaY?: number;
}

export interface GelSpec {
  curved: boolean;
  /** 微笑弯曲幅度（px），lane 越靠边越大 */
  smileAmp?: number;
  bands: SpecBand[];
  /** 曝光增益，>1 时整体可能饱和 */
  gain?: number;
  background?: number;
}

export interface GeneratedGel {
  png: Buffer;
  image: RawImage;
  /** 真值：每 lane 中心线控制点（竖直坐标 y） */
  groundTruth: {
    laneCenters: { x: number; ys: number[] }[];
    bands: (SpecBand & { x: number; y: number })[];
  };
}

/** 弯曲 lane 中心线：x(y) = x0 + amp * sin(pi * (y-top)/span) * sideSign */
export function curvedXAt(x0: number, y: number, amp: number, sideSign: number): number {
  const f = (y - WELL_Y) / (FRONT_Y - WELL_Y);
  return x0 + sideSign * amp * Math.sin(Math.PI * f) * (0.6 + 0.4 * f);
}

export function generateGel(spec: GelSpec): GeneratedGel {
  const data = new Uint8Array(GEL_W * GEL_H);
  const bg = spec.background ?? 18;
  const gain = spec.gain ?? 1.0;
  const amp = spec.smileAmp ?? 26;
  data.fill(bg);

  // 传感器噪声（确定性，无随机）
  for (let i = 0; i < data.length; i++) {
    const n = (((i * 1103515245 + 12345) & 0x7fffffff) % 7) - 3;
    data[i] = Math.max(0, Math.min(255, bg + n));
  }

  const laneSideSign = [1, 0.6, 0.3, -0.3, -0.6, -1];
  const centerXAt = (laneIndex: number, y: number) => {
    const x0 = LANE_CENTERS_X[laneIndex];
    if (!spec.curved) return x0;
    return curvedXAt(x0, y, amp, laneSideSign[laneIndex]);
  };

  // 加样孔（顶部暗槽 + 微亮边缘）
  for (let l = 0; l < LANE_CENTERS_X.length; l++) {
    for (let dy = -6; dy <= 6; dy++) {
      for (let dx = -LANE_HALF_WIDTH + 2; dx <= LANE_HALF_WIDTH - 2; dx++) {
        const x = Math.round(centerXAt(l, WELL_Y)) + dx;
        const y = WELL_Y + dy;
        if (x >= 0 && x < GEL_W && y >= 0 && y < GEL_H) data[y * GEL_W + x] = 6;
      }
    }
  }

  const groundBands: GeneratedGel['groundTruth']['bands'] = [];
  for (const band of spec.bands) {
    const t = tForBp(band.bp);
    const cx = centerXAt(band.laneIndex, t);
    groundBands.push({ ...band, x: cx, y: t });
    const ampBand = (band.amp ?? 150) * gain;
    const sigmaY = band.sigmaY ?? 6;
    const sigmaX = band.sigmaX ?? 15;
    const reach = Math.ceil(sigmaY * 4);
    for (let dy = -reach; dy <= reach; dy++) {
      const y = Math.round(t + dy);
      if (y < 0 || y >= GEL_H) continue;
      const xCenter = centerXAt(band.laneIndex, y);
      for (let dx = -Math.ceil(sigmaX * 2.5); dx <= Math.ceil(sigmaX * 2.5); dx++) {
        const x = Math.round(xCenter + dx);
        if (x < 0 || x >= GEL_W) continue;
        const ex = Math.exp(-(dx * dx) / (2 * sigmaX * sigmaX));
        // 拖尾：向下方向加宽、指数衰减
        const effDy = band.tail && dy > 0 ? dy * 0.45 : dy;
        const ey = Math.exp(-(effDy * effDy) / (2 * sigmaY * sigmaY));
        let v = data[y * GEL_W + x] + ampBand * ex * ey;
        if (band.saturate) v = Math.max(v, 255);
        data[y * GEL_W + x] = Math.max(0, Math.min(255, Math.round(v)));
      }
    }
  }

  const image: RawImage = { width: GEL_W, height: GEL_H, channels: 1, data };
  return {
    png: encodePng(image),
    image,
    groundTruth: {
      laneCenters: LANE_CENTERS_X.map((x0, l) => ({
        x: x0,
        ys: [WELL_Y, 180, 320, 460, FRONT_Y],
      })).map((c, l) => ({
        x: c.x,
        ys: c.ys,
      })),
      bands: groundBands,
    },
  };
}

export function rotatedPng(image: RawImage, deg: 90 | 180 | 270): { png: Buffer; image: RawImage } {
  const r = rotateCW(image, deg);
  const img: RawImage = { width: r.width, height: r.height, channels: 1, data: r.data };
  return { png: encodePng(img), image: img };
}
