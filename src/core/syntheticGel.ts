/**
 * 确定性合成凝胶：案例包的“原始图像”由配方生成，
 * 配方即不可变来源。等价配方 → 等价像素 → 等价身份。
 */
export interface SynthBand {
  /** 沿泳道的期望位置（0..1，自上而下）。 */
  t: number;
  /** 峰高 0..1（>1 会被截断为 255，模拟饱和）。 */
  amp: number;
  /** 纵向半高宽（px）。 */
  sigmaY: number;
  /** 横向半高宽（px）。 */
  sigmaX: number;
  /** 拖尾强度（沿迁移方向下沿延展）。 */
  tail?: number;
}

export interface SynthLane {
  /** 中心 x（未弯曲）。 */
  cx: number;
  /** “微笑”幅度（px）：相对两端，中心向下方弯的量。 */
  bow: number;
  bands: SynthBand[];
}

export interface GelRecipe {
  width: number;
  height: number;
  background: number;
  noise: number;
  /** 井线 y（起点）。 */
  wellY: number;
  lanes: SynthLane[];
  seed: number;
}

/** mulberry32 确定性伪随机。 */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function renderGel(recipe: GelRecipe): { gray: Uint8Array; width: number; height: number } {
  const { width, height, background, noise, wellY } = recipe;
  const gray = new Uint8Array(width * height);
  const rnd = rng(recipe.seed);
  for (let i = 0; i < gray.length; i++) {
    const n = (rnd() - 0.5) * noise;
    gray[i] = clamp(background + n);
  }

  const usable = height - wellY - 20;

  for (const lane of recipe.lanes) {
    for (let y = 0; y < height; y++) {
      const cy = laneCenterXAtY(lane, y, wellY, height);
      for (let x = 0; x < width; x++) {
        let v = 0;
        for (const band of lane.bands) {
          const by = wellY + band.t * usable;
          const dx = (x - cy) / band.sigmaX;
          let dy = (y - by) / band.sigmaY;
          // 拖尾：下沿（迁移方向）非对称延展。
          if (band.tail && y > by) dy = dy / (1 + band.tail * ((y - by) / band.sigmaY));
          const g = band.amp * 255 * Math.exp(-0.5 * (dx * dx + dy * dy));
          v += g;
        }
        if (v > 0) {
          const idx = y * width + x;
          gray[idx] = clamp(gray[idx]! + v);
        }
      }
    }
  }
  return { gray, width, height };
}

/** 给定 y 的泳道中心 x：用二次弓形（以图像垂直中点为最弯处）。 */
export function laneCenterXAtY(
  lane: SynthLane,
  y: number,
  wellY: number,
  height: number,
): number {
  const u = (y - wellY) / (height - 1 - wellY); // 0..1
  const q = 4 * u * (1 - u); // 0 at ends, 1 at middle
  return lane.cx + lane.bow * q;
}

/** 给定 y 的中心线切线，用于弧长积分与投影。 */
export function centerlineSamples(lane: SynthLane, wellY: number, height: number, step = 4) {
  const pts: { x: number; y: number; s: number }[] = [];
  let prev: { x: number; y: number } | null = null;
  let s = 0;
  for (let y = wellY; y <= height - 20; y += step) {
    const x = laneCenterXAtY(lane, y, wellY, height);
    if (prev) s += Math.hypot(x - prev.x, y - prev.y);
    pts.push({ x, y, s });
    prev = { x, y };
  }
  return pts;
}

function clamp(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
}

/** 旋转灰度图（90° 的倍数），用于“旋转图像”反例。 */
export function rotateGray90(
  gray: Uint8Array,
  w: number,
  h: number,
  turns: number,
): { gray: Uint8Array; width: number; height: number } {
  let t = ((Math.round(turns) % 4) + 4) % 4;
  let cur = gray;
  let cw = w;
  let ch = h;
  while (t-- > 0) {
    const out = new Uint8Array(ch * cw);
    for (let y = 0; y < ch; y++) {
      for (let x = 0; x < cw; x++) {
        // 顺时针 90
        out[x * ch + (ch - 1 - y)] = cur[y * cw + x]!;
      }
    }
    cur = out;
    const nw = ch;
    ch = cw;
    cw = nw;
  }
  return { gray: cur, width: cw, height: ch };
}
