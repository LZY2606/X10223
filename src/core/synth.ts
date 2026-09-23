/**
 * 离线领域案例材料生成器：合成凝胶原始图像（8 位灰度）。
 * 不是通用表格——所有场景（微笑弯曲/缺带/饱和/重叠/非单调…）都以像素形式真实存在。
 */

export interface SpecBand {
  /** 沿泳道弧长位置（直线 lane 时即 y，像素） */
  s: number;
  amp: number;
  sigma?: number;
  /** >1：拖尾（沿迁移方向非对称展宽） */
  tail?: number;
}

export interface SpecLane {
  x: number;
  role: 'ladder' | 'sample';
  halfWidth: number;
  bands: SpecBand[];
  /** 微笑弯曲幅度（像素）：x(y)=x+bend*sin(pi*y/H) */
  bend?: number;
}

export interface GelSpec {
  width: number;
  height: number;
  bg: number;
  noise: number;
  seed: number;
  lanes: SpecLane[];
  /** 曝光增益（不改变几何；单独来源） */
  gain?: number;
}

/** 确定性 PRNG（mulberry32）：等价输入 -> 等价像素 -> 稳定顺序 */
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

export function laneCenterAt(lane: SpecLane, y: number, height: number): number {
  const bend = lane.bend ?? 0;
  return lane.x + bend * Math.sin((Math.PI * y) / height);
}

function laneDxDy(lane: SpecLane, y: number, height: number): number {
  const bend = lane.bend ?? 0;
  return bend * (Math.PI / height) * Math.cos((Math.PI * y) / height);
}

export interface RenderedGel {
  pixels: Uint8Array;
  width: number;
  height: number;
  /** 每泳道：弧长 s -> y 映射与真实中心线（像素级真值来源） */
  truth: Array<{
    lane: SpecLane;
    cumS: Float64Array;
    polyline: Array<{ x: number; y: number }>;
  }>;
}

export function renderGel(spec: GelSpec): RenderedGel {
  const { width, height, lanes } = spec;
  const pixels = new Uint8Array(width * height);
  const rng = mulberry32(spec.seed);
  const gain = spec.gain ?? 1;

  const truth: RenderedGel['truth'] = [];
  for (const lane of lanes) {
    const cumS = new Float64Array(height);
    for (let y = 1; y < height; y++) {
      const d = laneDxDy(lane, y - 0.5, height);
      cumS[y] = cumS[y - 1] + Math.sqrt(1 + d * d);
    }
    const polyline: Array<{ x: number; y: number }> = [];
    for (let y = 0; y < height; y += 16) polyline.push({ x: laneCenterAt(lane, y, height), y });
    polyline.push({ x: laneCenterAt(lane, height - 1, height), y: height - 1 });
    truth.push({ lane, cumS, polyline });

    for (let y = 0; y < height; y++) {
      const cx = laneCenterAt(lane, y, height);
      const s = cumS[y];
      const x0 = Math.max(0, Math.round(cx - lane.halfWidth - 14));
      const x1 = Math.min(width - 1, Math.round(cx + lane.halfWidth + 14));
      for (let x = x0; x <= x1; x++) {
        let v = spec.bg + (rng() - 0.5) * spec.noise;
        for (const band of lane.bands) {
          const ds = s - band.s;
          const sigmaAlong = band.sigma ?? 7;
          const tail = band.tail ?? 1;
          const eff = ds > 0 ? sigmaAlong * tail : sigmaAlong;
          const dx = x - cx;
          const sigmaX = 8;
          v += band.amp * gain * Math.exp(-(ds * ds) / (2 * eff * eff)) *
            Math.exp(-(dx * dx) / (2 * sigmaX * sigmaX));
        }
        const idx = y * width + x;
        pixels[idx] = Math.max(0, Math.min(255, Math.round(v)));
      }
    }
  }
  return { pixels, width, height, truth };
}

/** ladder 标称（bp），ordinal 0 = 最大；原始文本表示保留在材料层 */
export const LADDER_BP = [1500, 1000, 750, 500, 300, 200, 100];
/** baseline  ladder 条带弧长位置（直线时=y） */
export const LADDER_S = [90, 150, 205, 265, 330, 390, 450];

export const GEL_WIDTH = 640;
export const GEL_HEIGHT = 560;

interface VariantOptions {
  bend?: number;
  gain?: number;
  seed?: number;
}

function baselineLanes(opts: VariantOptions = {}): SpecLane[] {
  const bend = opts.bend ?? 0;
  const mkLane = (x: number, role: 'ladder' | 'sample', bands: SpecBand[]): SpecLane =>
    ({ x, role, halfWidth: 34, bend, bands });
  return [
    mkLane(
      80,
      'ladder',
      LADDER_S.map((s, i) => ({
        s,
        amp: 200 - i * 6,
        sigma: 6.5,
      })),
    ),
    mkLane(195, 'sample', [
      { s: 122, amp: 180 },
      { s: 238, amp: 170 },
      { s: 352, amp: 160 },
      { s: 432, amp: 150 },
    ]),
    mkLane(310, 'sample', [
      { s: 165, amp: 175 },
      { s: 298, amp: 165 },
      { s: 405, amp: 155 },
    ]),
    // 饱和 lane：amp 超 255 被削顶
    mkLane(425, 'sample', [
      { s: 140, amp: 165 },
      { s: 250, amp: 295 },
      { s: 400, amp: 160 },
    ]),
    // 重叠 lane：双峰相距 9px（窄于分辨宽度）；外加拖尾带
    mkLane(540, 'sample', [
      { s: 210, amp: 185, tail: 2.6 },
      { s: 326, amp: 205, sigma: 3.2 },
      { s: 335, amp: 190, sigma: 3.2 },
      { s: 425, amp: 150 },
    ]),
  ];
}

export function baselineSpec(opts: VariantOptions = {}): GelSpec {
  return {
    width: GEL_WIDTH,
    height: GEL_HEIGHT,
    bg: 22,
    noise: 7,
    seed: opts.seed ?? 1194,
    gain: opts.gain ?? 1,
    lanes: baselineLanes(opts),
  };
}

/** 缺带变体：第 4 条 ladder rung（500bp）缺失 */
export function missingRungSpec(): GelSpec {
  const spec = baselineSpec();
  const ladder = spec.lanes[0];
  ladder.bands = ladder.bands.filter((_, i) => i !== 3);
  return spec;
}

export const NONMONO_SWAP: [number, number] = [1, 2]; // 1000 <-> 750 标称错置
