import type { PxPoint } from "./types.js";

/** 凝胶图像元数据：拍摄方向、曝光、坐标基准、采集时间基准。 */
export interface GelImageMeta {
  orientationDeg: number; // 拍摄方向（0/90/180/270）
  exposureMs: number; // 曝光
  capturedAt: string; // ISO8601 UTC 时间基准
  basis: { origin: "top-left"; yAxis: "down"; unit: "px" };
}

export interface GelImage {
  width: number;
  height: number;
  pixels: Uint8Array; // 行优先灰度
  meta: GelImageMeta;
}

export function getPx(img: GelImage, x: number, y: number): number {
  if (x < 0 || y < 0 || x >= img.width || y >= img.height) return 0;
  return img.pixels[y * img.width + x];
}

export function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

export interface BandSpec {
  trueY: number; // 未受微笑弯曲影响的迁移坐标（px）
  intensity: number; // 峰值强度 0..255（可能被饱和截断）
  width?: number; // 垂直半宽 px，默认 3
  smear?: number; // 拖尾长度 px
}

export interface LaneSpec {
  x: number; // 泳道中心 x（px）
  bands: BandSpec[];
}

export interface SyntheticGelOpts {
  width: number;
  height: number;
  seed: number;
  smile: number; // 微笑弯曲系数：边缘泳道迁移更远
  lanes: LaneSpec[];
  exposureMs: number;
  capturedAt: string;
}

/** 微笑弯曲位移：yShift(x) = smile * 40 * ((x-cx)/cx)^2 */
export function smileShift(x: number, width: number, smile: number): number {
  const cx = width / 2;
  const t = (x - cx) / cx;
  return smile * 40 * t * t;
}

/** 确定性合成凝胶图像（离线案例包材料）。 */
export function makeSyntheticGel(opts: SyntheticGelOpts): GelImage {
  const { width, height } = opts;
  const acc = new Float64Array(width * height);
  const rng = makeRng(opts.seed);
  for (const lane of opts.lanes) {
    const yShift = smileShift(lane.x, width, opts.smile);
    for (const band of lane.bands) {
      const yc = band.trueY + yShift;
      const sy = band.width ?? 3;
      const sx = 6;
      const x0 = Math.max(0, Math.floor(lane.x - 3 * sx));
      const x1 = Math.min(width - 1, Math.ceil(lane.x + 3 * sx));
      const y0 = Math.max(0, Math.floor(yc - 4 * sy - (band.smear ?? 0)));
      const y1 = Math.min(height - 1, Math.ceil(yc + 4 * sy + (band.smear ?? 0) * 2));
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const dx = (x - lane.x) / sx;
          const dy = (y - yc) / sy;
          let v = band.intensity * Math.exp(-(dx * dx + dy * dy) / 2);
          if (band.smear && y > yc) {
            v += band.intensity * 0.35 * Math.exp(-(y - yc) / band.smear) * Math.exp(-(dx * dx) / 2);
          }
          acc[y * width + x] += v;
        }
      }
    }
  }
  const pixels = new Uint8Array(width * height);
  for (let i = 0; i < pixels.length; i++) {
    const noise = rng() * 4;
    const v = 8 + acc[i] + noise;
    pixels[i] = v >= 255 ? 255 : Math.round(v);
  }
  return {
    width,
    height,
    pixels,
    meta: {
      orientationDeg: 0,
      exposureMs: opts.exposureMs,
      capturedAt: opts.capturedAt,
      basis: { origin: "top-left", yAxis: "down", unit: "px" },
    },
  };
}

/** 顺时针旋转 90°。 */
export function rotate90cw(img: GelImage): GelImage {
  const { width: w, height: h } = img;
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      // out(x', y')，x' = h-1-y, y' = x，新图宽为 h
      out[x * h + (h - 1 - y)] = img.pixels[y * w + x];
    }
  }
  return {
    width: h,
    height: w,
    pixels: out,
    meta: { ...img.meta, orientationDeg: (img.meta.orientationDeg + 90) % 360 },
  };
}

export interface NormalizedImage {
  image: GelImage;
  transform: { fromOrientationDeg: number; toOrientationDeg: number; appliedRotationDeg: number };
  /** 原图坐标 -> 规范化坐标 */
  toNormalized: (p: PxPoint) => PxPoint;
}

/** 按拍摄方向元数据把图像规范化到 0°，并给出坐标变换。 */
export function normalizeOrientation(img: GelImage): NormalizedImage {
  const deg = ((img.meta.orientationDeg % 360) + 360) % 360;
  if (deg === 0) {
    return {
      image: img,
      transform: { fromOrientationDeg: 0, toOrientationDeg: 0, appliedRotationDeg: 0 },
      toNormalized: (p) => ({ ...p }),
    };
  }
  if (deg === 90) {
    // 存储图 = rotCW(原图)，规范化 = rotCCW(存储图)
    const w = img.width; // = 原图 height
    const h = img.height; // = 原图 width
    const out = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        // 原图坐标 (X, Y)：X = y, Y = w-1-x （w = 原图高度）
        out[(w - 1 - x) * h + y] = img.pixels[y * w + x];
      }
    }
    const nImg: GelImage = {
      width: h,
      height: w,
      pixels: out,
      meta: { ...img.meta, orientationDeg: 0 },
    };
    return {
      image: nImg,
      transform: { fromOrientationDeg: 90, toOrientationDeg: 0, appliedRotationDeg: -90 },
      toNormalized: (p) => ({ x: p.y, y: w - 1 - p.x }),
    };
  }
  if (deg === 180) {
    const { width: w, height: h } = img;
    const out = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        out[(h - 1 - y) * w + (w - 1 - x)] = img.pixels[y * w + x];
      }
    }
    return {
      image: { width: w, height: h, pixels: out, meta: { ...img.meta, orientationDeg: 0 } },
      transform: { fromOrientationDeg: 180, toOrientationDeg: 0, appliedRotationDeg: -180 },
      toNormalized: (p) => ({ x: w - 1 - p.x, y: h - 1 - p.y }),
    };
  }
  // 270
  const w = img.width;
  const h = img.height;
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      out[x * h + (h - 1 - y)] = img.pixels[y * w + x];
    }
  }
  return {
    image: { width: h, height: w, pixels: out, meta: { ...img.meta, orientationDeg: 0 } },
    transform: { fromOrientationDeg: 270, toOrientationDeg: 0, appliedRotationDeg: -270 },
    toNormalized: (p) => ({ x: h - 1 - p.y, y: p.x }),
  };
}

/** 沿泳道曲线 x(y) 取 1D 灰度剖面（水平 ±halfWidth 平均）。 */
export function sampleProfile(
  img: GelImage,
  xAtY: (y: number) => number,
  halfWidth: number,
): Float64Array {
  const prof = new Float64Array(img.height);
  for (let y = 0; y < img.height; y++) {
    const xc = xAtY(y);
    let sum = 0;
    let n = 0;
    for (let dx = -halfWidth; dx <= halfWidth; dx++) {
      const x = Math.round(xc + dx);
      if (x >= 0 && x < img.width) {
        sum += img.pixels[y * img.width + x];
        n++;
      }
    }
    prof[y] = n > 0 ? sum / n : 0;
  }
  return prof;
}

export function imageToBase64(img: GelImage): string {
  return Buffer.from(img.pixels).toString("base64");
}

export function imageFromPayload(payload: {
  width: number;
  height: number;
  pixelsB64: string;
  meta: GelImageMeta;
}): GelImage {
  return {
    width: payload.width,
    height: payload.height,
    pixels: new Uint8Array(Buffer.from(payload.pixelsB64, "base64")),
    meta: payload.meta,
  };
}
