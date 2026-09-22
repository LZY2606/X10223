// 合成电泳凝胶渲染器：产出带像素级“真值”的离线领域样例图。
// 支持“微笑”弯曲泳道、饱和平台、拖尾、重叠带、缺带与拍摄方向旋转。
export interface TruthBand {
  laneIndex: number; // 1-based
  rank?: number;     // ladder rank（加样口最近为 1）
  centerX: number;   // image_px（弯曲后的几何中心）
  centerY: number;
  nominal?: number;  // bp（ladder）
  intensity: number; // 0..1 期望相对强度
  saturated?: boolean;
  tailing?: number;  // 不对称度
}

export interface GelRenderResult {
  width: number;
  height: number;
  gray: Uint8Array;
  rgba: Uint8ClampedArray;
  truthLaneXs: number[];
  truthBands: TruthBand[];
  smileAmpPx: number;
  laneHalfWidthPx: number;
}

export interface GelRenderOptions {
  width?: number;
  height?: number;
  laneCount?: number;
  laneHalfWidthPx?: number;
  smileAmpPx?: number;
  /** 泳道整体侧向弯曲（弯曲泳道场景） */
  laneMeanderPx?: number;
  saturation?: boolean;
  /** 在指定 lane（1-based）制造两条重叠带；给基础 y 分数与间距 */
  overlap?: { laneIndex: number; atFraction: number; gapPx: number };
  tailingLane?: number;
  /** 缺失 ladder rank（图中不画该带） */
  missingLadderRank?: number;
  /** 背景亮度（曝光：曝光过度使整体变暗、暗部裁切） */
  backgroundGray?: number;
  intensityScale?: number;
  /** 阶梯：ladder 带强度逐带变化的种子 */
  seed?: number;
}

// 常见 1kb 风格 ladder（bp），rank 1 最大、距加样口最近
export const LADDER_NOMINALS_BP = [10000, 6000, 4000, 3000, 2000, 1500, 1000, 700, 500, 300];
export const LADDER_FRACTIONS = [0.1, 0.18, 0.27, 0.35, 0.45, 0.53, 0.63, 0.71, 0.8, 0.89];

export function renderGel(opts: GelRenderOptions = {}): GelRenderResult {
  const width = opts.width ?? 480;
  const height = opts.height ?? 380;
  const laneCount = opts.laneCount ?? 8;
  const laneHalfWidthPx = opts.laneHalfWidthPx ?? 17;
  const smileAmpPx = opts.smileAmpPx ?? 0;
  const laneMeanderPx = opts.laneMeanderPx ?? 0;
  const bg = opts.backgroundGray ?? 226;
  const intensityScale = opts.intensityScale ?? 1;

  const gray = new Uint8Array(width * height).fill(bg);
  const laneSpan = width / (laneCount + 1);
  const truthLaneXs: number[] = [];
  for (let i = 1; i <= laneCount; i++) truthLaneXs.push(Math.round(laneSpan * i));
  const gelCenterX = width / 2;

  const truthBands: TruthBand[] = [];
  const ladderLane = 1;

  // 泳道在给定迁移像素高度处的弯曲中线
  const lanePathX = (laneIndex1: number, y: number): number => {
    const base = truthLaneXs[laneIndex1 - 1]!;
    if (!laneMeanderPx) return base;
    const phase = (laneIndex1 % 2) * 0.9 + 0.2;
    return base + Math.round(laneMeanderPx * Math.sin((y / height) * Math.PI * 1.25 + phase));
  };

  // 沿弯曲泳道铺一层很淡的连续轨迹，使整条曲线可被追踪
  for (let li = 1; li <= laneCount; li++) {
    for (let y = 0; y < height; y += 2) {
      const cx = lanePathX(li, y);
      for (let dx = -laneHalfWidthPx; dx <= laneHalfWidthPx; dx++) {
        const x = cx + dx;
        if (x < 0 || x >= width) continue;
        const idx = y * width + x;
        const fall = 1 - Math.abs(dx) / laneHalfWidthPx;
        gray[idx] = Math.max(0, gray[idx]! - Math.round(7 * fall));
      }
    }
  }

  const stampBand = (
    laneIndex: number,
    centerX: number,
    centerY: number,
    intensity: number,
    extra: Partial<TruthBand> = {},
  ) => {
    const tail = extra.tailing ?? 1;
    const sigmaX = 12.5;
    const sigmaY = 4.6;
    const x0 = Math.max(0, Math.floor(centerX - laneHalfWidthPx - 2));
    const x1 = Math.min(width - 1, Math.ceil(centerX + laneHalfWidthPx + 2));
    const reach = Math.ceil(sigmaY * (tail > 1 ? 3.2 * tail : 3.2));
    const y0 = Math.max(0, Math.floor(centerY - reach));
    const y1 = Math.min(height - 1, Math.ceil(centerY + reach));
    for (let y = y0; y <= y1; y++) {
      const dy = y - centerY;
      const sy = dy >= 0 ? sigmaY * tail : sigmaY;
      for (let x = x0; x <= x1; x++) {
        const dx = x - centerX;
        const sx = sigmaX;
        const g = Math.exp(-(dx * dx) / (2 * sx * sx) - (dy * dy) / (2 * sy * sy));
        let darkness = Math.min(1, intensity * intensityScale * g);
        const idx = y * width + x;
        let value = gray[idx]!;
        value = Math.round(value * (1 - darkness) + 6 * darkness);
        if (darkness > 0.985) value = 0; // 饱和平台
        gray[idx] = Math.max(0, Math.min(255, value));
      }
    }
    truthBands.push({
      laneIndex,
      centerX: Math.round(centerX),
      centerY: Math.round(centerY),
      intensity,
      ...extra,
    });
  };

  // ladder 位于第 1 道
  for (let r = 0; r < LADDER_NOMINALS_BP.length; r++) {
    if (opts.missingLadderRank === r + 1) continue;
    const baseX = truthLaneXs[ladderLane - 1]!;
    const baseY = LADDER_FRACTIONS[r]! * height;
    const y = baseY + smileYOffset(baseX, gelCenterX, smileAmpPx, width);
    const x = lanePathX(ladderLane, y);
    const intensity = 0.62 + 0.22 * Math.sin((r + 1) * 1.7 + (opts.seed ?? 0));
    stampBand(ladderLane, x, y, intensity, {
      rank: r + 1,
      nominal: LADDER_NOMINALS_BP[r],
      saturated: opts.saturation && r % 3 === 1,
      tailing: opts.tailingLane === ladderLane ? 1.9 : 1,
    });
  }

  // 样品带
  const samplePattern: Array<[number, number[]]> = [
    [2, [0.16, 0.42, 0.66, 0.84]],
    [3, [0.22, 0.5, 0.75]],
    [4, [0.3, 0.58]],
    [5, [0.14, 0.36, 0.62, 0.88]],
    [6, [0.26, 0.48, 0.7]],
    [7, [0.33, 0.6, 0.82]],
    [8, [0.19, 0.44, 0.72]],
  ];
  for (const [laneIndex, fracs] of samplePattern) {
    const baseX = truthLaneXs[laneIndex! - 1]!;
    for (const f of fracs!) {
      let ff = f;
      let saturated = false;
      if (opts.overlap && opts.overlap.laneIndex === laneIndex) {
        // 重叠两条带在该 lane 处理（见下）
      }
      const y = ff * height + smileYOffset(baseX, gelCenterX, smileAmpPx, width);
      const x = lanePathX(laneIndex!, y);
      if (opts.saturation && laneIndex === 3 && f === 0.5) saturated = true;
      stampBand(laneIndex!, x, y, 0.72, {
        saturated,
        tailing: opts.tailingLane === laneIndex ? 1.9 : 1,
      });
    }
  }

  if (opts.overlap) {
    const { laneIndex, atFraction, gapPx } = opts.overlap;
    const baseX = truthLaneXs[laneIndex - 1]!;
    const y0v = atFraction * height + smileYOffset(baseX, gelCenterX, smileAmpPx, width);
    const x = lanePathX(laneIndex, y0v);
    const y = y0v;
    stampBand(laneIndex, x, y - gapPx / 2, 0.66);
    stampBand(laneIndex, x, y + gapPx / 2, 0.66);
  }

  // 轻噪声（确定性）
  let n = (opts.seed ?? 7) * 2654435761;
  const rand = () => {
    n = (n * 1664525 + 1013904223) >>> 0;
    return (n / 0xffffffff - 0.5) * 6;
  };
  for (let i = 0; i < gray.length; i++) {
    gray[i] = Math.max(0, Math.min(255, gray[i]! + rand()));
  }

  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < gray.length; i++) {
    const g = gray[i]!;
    rgba[i * 4] = g;
    rgba[i * 4 + 1] = g;
    rgba[i * 4 + 2] = g;
    rgba[i * 4 + 3] = 255;
  }

  return { width, height, gray, rgba, truthLaneXs, truthBands, smileAmpPx, laneHalfWidthPx };
}

export function smileYOffset(x: number, centerX: number, ampPx: number, width: number): number {
  if (!ampPx) return 0;
  const d = (x - centerX) / (width / 2);
  return Math.round(ampPx * d * d); // 边缘下垂（“微笑”）
}

// 拍摄方向：顺时针旋转像素（最近邻），返回新灰度图
export function rotateGray(
  gray: Uint8Array,
  w: number,
  h: number,
  deg: number,
): { gray: Uint8Array; width: number; height: number } {
  const r = ((deg % 360) + 360) % 360;
  if (r === 0) return { gray, width: w, height: h };
  const swap = r === 90 || r === 270;
  const w2 = swap ? h : w;
  const h2 = swap ? w : h;
  const out = new Uint8Array(w2 * h2).fill(255);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let nx: number;
      let ny: number;
      if (r === 90) {
        nx = h - 1 - y;
        ny = x;
      } else if (r === 180) {
        nx = w - 1 - x;
        ny = h - 1 - y;
      } else {
        nx = y;
        ny = w - 1 - x;
      }
      out[ny * w2 + nx] = gray[y * w + x]!;
    }
  }
  return { gray: out, width: w2, height: h2 };
}
