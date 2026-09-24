/** 灰度图像容器与几何变换。PNG 编解码由服务端注入（pngjs），领域层只处理像素矩阵。 */

export interface GrayImage {
  width: number;
  height: number;
  /** 行优先，0..255，值越大越亮（条带为亮带） */
  data: Uint8Array;
}

export function makeImage(width: number, height: number, fill = 0): GrayImage {
  return { width, height, data: new Uint8Array(width * height).fill(fill) };
}

export function getPx(img: GrayImage, x: number, y: number): number {
  const xi = Math.round(x), yi = Math.round(y);
  if (xi < 0 || yi < 0 || xi >= img.width || yi >= img.height) return 0;
  return img.data[yi * img.width + xi];
}

/** 双线性采样 */
export function sample(img: GrayImage, x: number, y: number): number {
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const fx = x - x0, fy = y - y0;
  const a = getPx(img, x0, y0), b = getPx(img, x0 + 1, y0);
  const c = getPx(img, x0, y0 + 1), d = getPx(img, x0 + 1, y0 + 1);
  return a * (1 - fx) * (1 - fy) + b * fx * (1 - fy) + c * (1 - fx) * fy + d * fx * fy;
}

/** 绕中心旋转（度）。用于"旋转图像"情形的去旋转派生层。 */
export function rotate(img: GrayImage, deg: number): GrayImage {
  const rad = (deg * Math.PI) / 180;
  const cos = Math.cos(rad), sin = Math.sin(rad);
  const cx = (img.width - 1) / 2, cy = (img.height - 1) / 2;
  const out = makeImage(img.width, img.height, 0);
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const dx = x - cx, dy = y - cy;
      const sx = cx + dx * cos + dy * sin;
      const sy = cy - dx * sin + dy * cos;
      out.data[y * img.width + x] = Math.round(sample(img, sx, sy));
    }
  }
  return out;
}

/** 列方向投影：对给定 x 范围求每行平均强度 */
export function rowProfile(img: GrayImage, x0: number, x1: number): number[] {
  const out = new Array(img.height).fill(0);
  const xa = Math.max(0, Math.floor(x0)), xb = Math.min(img.width - 1, Math.ceil(x1));
  for (let y = 0; y < img.height; y++) {
    let s = 0;
    for (let x = xa; x <= xb; x++) s += img.data[y * img.width + x];
    out[y] = s / Math.max(1, xb - xa + 1);
  }
  return out;
}

/** 行方向投影：对给定 y 范围求每列平均强度 */
export function colProfile(img: GrayImage, y0: number, y1: number): number[] {
  const out = new Array(img.width).fill(0);
  const ya = Math.max(0, Math.floor(y0)), yb = Math.min(img.height - 1, Math.ceil(y1));
  for (let x = 0; x < img.width; x++) {
    let s = 0;
    for (let y = ya; y <= yb; y++) s += img.data[y * img.width + x];
    out[x] = s / Math.max(1, yb - ya + 1);
  }
  return out;
}
