// 规范化 JSON：键排序、Uint8Array 作为稳定十六进制串，保证等价输入得到稳定摘要与顺序。
import type { RasterContent } from "./types";

function sortValue(value: unknown): unknown {
  if (value instanceof Uint8Array) return { __bytes__: toHex(value) };
  if (ArrayBuffer.isView(value)) {
    const u = new Uint8Array((value as { buffer: ArrayBuffer }).buffer);
    return { __bytes__: toHex(u) };
  }
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    const out: Record<string, unknown> = {};
    for (const k of keys) out[k] = sortValue((value as Record<string, unknown>)[k]);
    return out;
  }
  if (typeof value === "number" && !Number.isFinite(value)) return { __number__: String(value) };
  return value;
}

function toHex(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, "0");
  return s;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

export function stableSort<T>(items: T[], key: (item: T) => string): T[] {
  return [...items]
    .map((item, originalIndex) => ({ item, originalIndex, k: key(item) }))
    .sort((a, b) => (a.k < b.k ? -1 : a.k > b.k ? 1 : a.originalIndex - b.originalIndex))
    .map((x) => x.item);
}

// 大栅格只摘要形状+采样，避免把整幅像素塞进身份摘要
export function rasterDigest(raster: RasterContent): { width: number; height: number; digest: string; saturated: boolean } {
  const step = Math.max(1, Math.floor(raster.grayscale.length / 4096));
  let acc = "";
  for (let i = 0; i < raster.grayscale.length; i += step) acc += raster.grayscale[i].toString(16).padStart(2, "0");
  return { width: raster.width, height: raster.height, digest: acc, saturated: raster.saturated };
}
