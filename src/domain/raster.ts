import { PNG } from "pngjs";
import { createHash } from "node:crypto";

export interface RasterImage {
  width: number;
  height: number;
  data: Uint8Array;
}

export function decodePng(bytes: Uint8Array): RasterImage {
  const png = PNG.sync.read(Buffer.from(bytes));
  return { width: png.width, height: png.height, data: new Uint8Array(png.data) };
}

export function encodePng(img: RasterImage): Uint8Array {
  const png = new PNG({ width: img.width, height: img.height });
  png.data = Buffer.from(img.data);
  return new Uint8Array(PNG.sync.write(png));
}

export function sha256OfBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(Buffer.from(bytes)).digest("hex");
}

export function makeRaster(width: number, height: number, fill = 255): RasterImage {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = fill;
      data[i + 3] = 255;
    }
  }
  return { width, height, data };
}

export function intensityAt(img: RasterImage, x: number, y: number): number {
  if (x < 0 || y < 0 || x >= img.width || y >= img.height) return 255;
  const i = (Math.round(y) * img.width + Math.round(x)) * 4;
  return 0.299 * img.data[i] + 0.587 * img.data[i + 1] + 0.114 * img.data[i + 2];
}

export function paintGaussianBand(
  img: RasterImage,
  cx: number,
  cy: number,
  sigmaX: number,
  sigmaY: number,
  darkness: number,
  tailLength = 0
): void {
  const radius = Math.ceil(Math.max(sigmaX, sigmaY) * 4 + tailLength);
  for (let y = Math.max(0, cy - radius); y < Math.min(img.height, cy + radius + tailLength); y++) {
    for (let x = Math.max(0, cx - radius); x < Math.min(img.width, cx + radius); x++) {
      const gx = Math.exp(-((x - cx) ** 2) / (2 * sigmaX ** 2));
      let gy = Math.exp(-((y - cy) ** 2) / (2 * sigmaY ** 2));
      if (tailLength > 0 && y > cy) {
        gy = Math.max(gy, Math.exp(-(y - cy) / tailLength) * Math.exp(-((x - cx) ** 2) / (2 * sigmaX ** 2)));
      }
      const absorb = Math.min(1, darkness * gx * gy);
      const i = (y * img.width + x) * 4;
      img.data[i] = Math.round(img.data[i] * (1 - absorb));
      img.data[i + 1] = Math.round(img.data[i + 1] * (1 - absorb));
      img.data[i + 2] = Math.round(img.data[i + 2] * (1 - absorb));
    }
  }
}

export function rotateRaster(img: RasterImage, deg: number): RasterImage {
  const norm = ((deg % 360) + 360) % 360;
  if (norm === 0) return img;
  if (norm === 180) {
    const out = makeRaster(img.width, img.height);
    for (let y = 0; y < img.height; y++) {
      for (let x = 0; x < img.width; x++) {
        const si = (y * img.width + x) * 4;
        const di = ((img.height - 1 - y) * img.width + (img.width - 1 - x)) * 4;
        out.data.set(img.data.slice(si, si + 4), di);
      }
    }
    return out;
  }
  if (norm === 90 || norm === 270) {
    const newW = img.height;
    const newH = img.width;
    const out = makeRaster(newW, newH);
    for (let y = 0; y < img.height; y++) {
      for (let x = 0; x < img.width; x++) {
        const si = (y * img.width + x) * 4;
        let nx: number, ny: number;
        if (norm === 90) {
          nx = img.height - 1 - y;
          ny = x;
        } else {
          nx = y;
          ny = img.width - 1 - x;
        }
        const di = (ny * newW + nx) * 4;
        out.data.set(img.data.slice(si, si + 4), di);
      }
    }
    return out;
  }
  throw new Error("rotateRaster 仅支持 0/90/180/270 度");
}

export function measureSaturation(img: RasterImage, level: number): { maxIntensity: number; saturatedPixelCount: number } {
  let min = 255;
  let count = 0;
  for (let i = 0; i < img.data.length; i += 4) {
    const v = 0.299 * img.data[i] + 0.587 * img.data[i + 1] + 0.114 * img.data[i + 2];
    if (v < min) min = v;
    if (v <= 255 - level) count++;
  }
  return { maxIntensity: Math.round(min), saturatedPixelCount: count };
}

export function laneProfile(
  img: RasterImage,
  centerline: { x: number; y: number }[],
  halfWidth: number
): { arc: number; intensity: number }[] {
  const out: { arc: number; intensity: number }[] = [];
  let acc = 0;
  for (let k = 0; k < centerline.length; k++) {
    const p = centerline[k];
    if (k > 0) acc += Math.hypot(p.x - centerline[k - 1].x, p.y - centerline[k - 1].y);
    let sum = 0;
    let n = 0;
    for (let dx = -halfWidth; dx <= halfWidth; dx += 2) {
      const v = intensityAt(img, p.x + dx, p.y);
      sum += v;
      n++;
    }
    out.push({ arc: acc, intensity: n === 0 ? 255 : sum / n });
  }
  return out;
}
