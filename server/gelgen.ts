// 合成凝胶图像生成器：为离线案例包生成带“微笑”弯曲、饱和区、重叠条带的灰度图。
// 生成器同时返回像素与条带中心真值，保证材料的像素级来源与图像一致。

export interface LaneSpec {
  laneId: string;
  x: number; // 泳道中心 x（px）
  width: number;
  role: 'ladder' | 'sample';
}

export interface BandSpec {
  laneId: string;
  key: string;
  y: number; // 未加弯曲的迁移位置（px）
  intensity: number; // 峰值强度 0..255
  saturated?: boolean;
  trailing?: boolean;
  overlapsWith?: string[];
  halfWidth?: number;
  thickness?: number;
}

export interface GelSpec {
  width: number;
  height: number;
  lanes: LaneSpec[];
  smile: number; // 二次弯曲幅度（px）
  tilt: number; // 线性倾斜（px，满幅）
  bands: BandSpec[];
}

export interface RenderedBand {
  key: string;
  x: number;
  y: number; // 实际绘制（=测量）中心
  intensity: number;
  saturated: boolean;
  trailing: boolean;
  overlapsWith: string[];
}

export interface RenderedGel {
  width: number;
  height: number;
  pixels: Uint8Array;
  centers: Record<string, RenderedBand[]>;
}

export function smileOffset(x: number, width: number, smile: number, tilt: number): number {
  const u = (x - width / 2) / (width / 2);
  return smile * u * u + (tilt / 2) * u;
}

export function renderGel(spec: GelSpec): RenderedGel {
  const { width, height } = spec;
  const pixels = new Uint8Array(width * height).fill(16);
  for (const lane of spec.lanes) {
    const x0 = Math.round(lane.x - lane.width / 2);
    const x1 = Math.round(lane.x + lane.width / 2);
    for (let y = 0; y < height; y++) {
      for (let x = Math.max(0, x0); x < Math.min(width, x1); x++) {
        pixels[y * width + x] = 30;
      }
    }
  }
  const centers: Record<string, RenderedBand[]> = {};
  for (const lane of spec.lanes) centers[lane.laneId] = [];
  for (const band of spec.bands) {
    const lane = spec.lanes.find((l) => l.laneId === band.laneId);
    if (!lane) continue;
    const cx = lane.x;
    const cy = band.y + smileOffset(cx, width, spec.smile, spec.tilt);
    const hw = band.halfWidth ?? lane.width * 0.38;
    const th = band.thickness ?? 3.2;
    const x0 = Math.max(0, Math.round(cx - hw * 2));
    const x1 = Math.min(width - 1, Math.round(cx + hw * 2));
    const y0 = Math.max(0, Math.round(cy - th * 3));
    const y1 = Math.min(height - 1, Math.round(cy + th * (band.trailing ? 8 : 3)));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const dx = (x - cx) / hw;
        const dy = (y - cy) / th;
        let v = band.intensity * Math.exp(-(dx * dx + dy * dy));
        if (band.trailing && y > cy) v += band.intensity * 0.25 * Math.exp(-dx * dx) * Math.exp(-(y - cy) / (th * 4));
        const idx = y * width + x;
        pixels[idx] = Math.min(255, Math.max(pixels[idx], Math.round(v)));
        if (band.saturated && Math.abs(dx) < 0.5 && Math.abs(dy) < 0.8) pixels[idx] = 255;
      }
    }
    centers[band.laneId].push({
      key: band.key,
      x: cx,
      y: cy,
      intensity: band.saturated ? 255 : band.intensity,
      saturated: band.saturated ?? false,
      trailing: band.trailing ?? false,
      overlapsWith: band.overlapsWith ?? [],
    });
  }
  return { width, height, pixels, centers };
}

export function rotate90CW(src: { width: number; height: number; pixels: Uint8Array }): {
  width: number;
  height: number;
  pixels: Uint8Array;
} {
  const { width, height, pixels } = src;
  const out = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      out[x * height + (height - 1 - y)] = pixels[y * width + x];
    }
  }
  return { width: height, height: width, pixels: out };
}

export function rotatePoint90CW(x: number, y: number, srcHeight: number): { x: number; y: number } {
  return { x: srcHeight - 1 - y, y: x };
}
