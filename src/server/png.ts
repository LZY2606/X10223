/** PNG 编解码（pngjs）与内容哈希（sha256，服务端）。 */
import { PNG } from "pngjs";
import { createHash } from "node:crypto";
import type { GrayImage } from "../domain/image";

export function sha256(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

export function decodePng(buf: Buffer): GrayImage {
  const png = PNG.sync.read(buf);
  const out = new Uint8Array(png.width * png.height);
  for (let i = 0; i < png.width * png.height; i++) {
    const r = png.data[i * 4], g = png.data[i * 4 + 1], b = png.data[i * 4 + 2];
    out[i] = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
  }
  return { width: png.width, height: png.height, data: out };
}

export function encodePng(img: GrayImage): Buffer {
  const png = new PNG({ width: img.width, height: img.height });
  for (let i = 0; i < img.width * img.height; i++) {
    const v = img.data[i];
    png.data[i * 4] = v; png.data[i * 4 + 1] = v; png.data[i * 4 + 2] = v; png.data[i * 4 + 3] = 255;
  }
  return PNG.sync.write(png);
}

export function isPng(buf: Buffer): boolean {
  return buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
}
