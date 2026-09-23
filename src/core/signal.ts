import type {
  BandFlag,
  BandObservation,
  LaneMaterial,
  PixelPoint,
  Provenance,
} from '../shared/types.ts';
import { projectToPolyline } from '../shared/util.ts';

export interface Profile {
  /** 沿弧长 1px 步进的强度剖面（gray8） */
  s: number[];
  intensity: number[];
  /** 每个弧长采样对应的中心线像素 */
  xy: Array<[number, number]>;
}

function centerlineAt(points: PixelPoint[], s: number): [number, number] {
  let run = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    const seg = Math.hypot(b.x - a.x, b.y - a.y);
    if (s <= run + seg || i === points.length - 2) {
      const u = Math.min(1, Math.max(0, (s - run) / (seg || 1e-9)));
      return [a.x + u * (b.x - a.x), a.y + u * (b.y - a.y)];
    }
    run += seg;
  }
  return [points[points.length - 1].x, points[points.length - 1].y];
}

/**
 * 沿泳道中心线提取灰度剖面。
 * 每个弧长位置在法向截面 [-halfWidth,+halfWidth] 取均值（条带沿泳道走形）。
 */
export function extractLaneProfile(
  pixels: Uint8Array,
  width: number,
  height: number,
  centerline: PixelPoint[],
  halfWidth: number,
): Profile {
  const total = (() => {
    let t = 0;
    for (let i = 0; i < centerline.length - 1; i++) {
      t += Math.hypot(centerline[i + 1].x - centerline[i].x, centerline[i + 1].y - centerline[i].y);
    }
    return t;
  })();
  const s: number[] = [];
  const intensity: number[] = [];
  const xy: Array<[number, number]> = [];
  const hw = Math.max(1, Math.round(halfWidth * 0.35));
  for (let si = 0; si <= Math.floor(total); si++) {
    const [cx, cy] = centerlineAt(centerline, si);
    let nx = 0;
    let ny = 1;
    for (let i = 0; i < centerline.length - 1; i++) {
      const a = centerline[i];
      const b = centerline[i + 1];
      const seg = Math.hypot(b.x - a.x, b.y - a.y);
      const run = cumulative(centerline, i);
      if (si >= run && si <= run + seg) {
        nx = -(b.y - a.y) / (seg || 1e-9);
        ny = (b.x - a.x) / (seg || 1e-9);
        break;
      }
    }
    let sum = 0;
    let n = 0;
    for (let off = -hw; off <= hw; off++) {
      const x = Math.round(cx + nx * off);
      const y = Math.round(cy + ny * off);
      if (x >= 0 && x < width && y >= 0 && y < height) {
        sum += pixels[y * width + x];
        n++;
      }
    }
    s.push(si);
    intensity.push(n ? sum / n : 0);
    xy.push([cx, cy]);
  }
  return { s, intensity, xy };
}

function cumulative(points: PixelPoint[], upto: number): number {
  let t = 0;
  for (let i = 0; i < upto; i++) {
    t += Math.hypot(points[i + 1].x - points[i].x, points[i + 1].y - points[i].y);
  }
  return t;
}

export interface RawPeak {
  s: number;          // 亚像素弧长
  height: number;     // 扣除局部背景后的高度
  rawTop: number;     // 原始峰顶灰度
  fwhm: number;
  halfLeft: number;
  halfRight: number;
  cluster: number[];  // 同一重叠簇内的峰 s
}

/**
 * 峰值检测：
 *  - 形态学开背景（长窗最小值）扣除缓慢基线
 *  - 连续高于阈值的区域为一个“峰区”，取区内最高像素，饱和平顶不被劈裂
 *  - 相邻 3 点抛物线做亚像素修正；半高宽在背景扣除剖面上测
 *  - 峰距 < resolutionWidth 的峰结成重叠簇（保留簇内全部候选）
 */
export function findPeaks(profile: Profile, opts: {
  minHeight: number;
  resolutionWidth: number;
  baselineWindow?: number;
}): RawPeak[] {
  const { intensity } = profile;
  const w = opts.baselineWindow ?? 61;
  const half = Math.floor(w / 2);
  const bg = intensity.map((_, i) => {
    const lo = Math.max(0, i - half);
    const hi = Math.min(intensity.length - 1, i + half);
    let mn = Infinity;
    for (let k = lo; k <= hi; k++) mn = Math.min(mn, intensity[k]);
    return mn;
  });
  const corrected = intensity.map((v, i) => Math.max(0, v - bg[i]));

  // 峰区分割：连续超阈值段
  const regions: Array<[number, number]> = [];
  let start = -1;
  for (let i = 0; i < corrected.length; i++) {
    if (corrected[i] >= opts.minHeight) {
      if (start < 0) start = i;
    } else if (start >= 0) {
      regions.push([start, i - 1]);
      start = -1;
    }
  }
  if (start >= 0) regions.push([start, corrected.length - 1]);

  // 把宽峰区按“显著谷”拆成子峰（谷深 >= 25% 且仍高于阈值的 0.55 倍），
  // 但真平顶（饱和，谷极浅）不会被拆
  function splitRegion(lo: number, hi: number): Array<[number, number]> {
    let regionMax = 0;
    for (let i = lo; i <= hi; i++) regionMax = Math.max(regionMax, corrected[i]);
    const cuts: number[] = [];
    for (let i = lo + 1; i < hi; i++) {
      if (corrected[i] <= corrected[i - 1] && corrected[i] <= corrected[i + 1]) {
        if (corrected[i] < regionMax * 0.75 && corrected[i] > opts.minHeight * 0.55) {
          cuts.push(i);
        }
      }
    }
    if (cuts.length === 0) return [[lo, hi]];
    const sub: Array<[number, number]> = [];
    let cur = lo;
    for (const c of cuts) {
      sub.push([cur, Math.max(cur, c - 1)]);
      cur = c;
    }
    sub.push([cur, hi]);
    return sub.filter(([a, b]) => b >= a);
  }

  const subRegions = regions.flatMap(([lo, hi]) => splitRegion(lo, hi));

  const peaks: RawPeak[] = [];
  for (const [lo, hi] of subRegions) {
    let top = lo;
    for (let i = lo; i <= hi; i++) if (corrected[i] > corrected[top]) top = i;
    let rawTop = 0;
    for (let i = lo; i <= hi; i++) rawTop = Math.max(rawTop, intensity[i]);
    // 平顶（饱和）：取平台几何中心，亚像素修正归零
    const plateau: number[] = [];
    for (let i = lo; i <= hi; i++) if (corrected[i] >= corrected[top] - 0.5) plateau.push(i);
    let s: number;
    if (plateau.length >= 2) {
      s = (plateau[0] + plateau[plateau.length - 1]) / 2;
    } else {
      const y0 = corrected[top - 1] ?? 0;
      const y1 = corrected[top];
      const y2 = corrected[top + 1] ?? 0;
      const denom = y0 - 2 * y1 + y2;
      const delta = denom !== 0 ? (y0 - y2) / (2 * denom) : 0;
      s = top + Math.max(-1, Math.min(1, delta));
    }
    const level = corrected[top] / 2;
    let left = top;
    while (left > 0 && corrected[left] > level) left--;
    let right = top;
    while (right < corrected.length - 1 && corrected[right] > level) right++;
    peaks.push({
      s,
      height: corrected[top],
      rawTop,
      fwhm: Math.max(1, top - left + right - top),
      halfLeft: top - left,
      halfRight: right - top,
      cluster: [],
    });
  }

  // 重叠簇：峰距 < resolutionWidth
  const used = new Array(peaks.length).fill(false);
  for (let i = 0; i < peaks.length; i++) {
    if (used[i]) continue;
    const group = [i];
    used[i] = true;
    for (let j = i + 1; j < peaks.length; j++) {
      if (!used[j] && Math.abs(peaks[j].s - peaks[group[group.length - 1]].s) < opts.resolutionWidth) {
        group.push(j);
        used[j] = true;
      }
    }
    if (group.length > 1) {
      const ss = group.map((g) => peaks[g].s);
      for (const g of group) peaks[g].cluster = ss;
    }
  }
  return peaks.sort((a, b) => a.s - b.s);
}

/** 剖面高斯和拟合残差（gray RMSE）：把残差作为证据露出 */
export function profileResidual(profile: Profile, peaks: RawPeak[]): number {
  let se = 0;
  let n = 0;
  for (let i = 0; i < profile.intensity.length; i++) {
    const s = profile.s[i];
    let model = 0;
    for (const p of peaks) {
      const sigma = Math.max(1.2, p.fwhm / 2.355);
      model += p.height * Math.exp(-((s - p.s) ** 2) / (2 * sigma * sigma));
    }
    se += (profile.intensity[i] - model - localBg(profile.intensity, i)) ** 2;
    n++;
  }
  return Math.sqrt(se / Math.max(1, n));
}

function localBg(v: number[], i: number): number {
  const half = 15;
  let mn = Infinity;
  for (let k = Math.max(0, i - half); k <= Math.min(v.length - 1, i + half); k++) {
    mn = Math.min(mn, v[k]);
  }
  return mn === Infinity ? 0 : mn;
}

export function classifyFlags(
  peaks: RawPeak[],
  params: { saturationGray: number | null; tailingRatio: number },
): Map<number, BandFlag> {
  const fwhms = peaks.map((p) => p.fwhm).sort((a, b) => a - b);
  const median = fwhms.length ? fwhms[Math.floor(fwhms.length / 2)] : 8;
  const out = new Map<number, BandFlag>();
  for (let i = 0; i < peaks.length; i++) {
    const p = peaks[i];
    let flag: BandFlag = 'normal';
    // 重叠优先：簇成员即使更宽/饱和也先暴露“未分辨”这一事实
    if (p.cluster.length > 0) flag = 'overlap';
    else if (params.saturationGray !== null && p.rawTop >= params.saturationGray) flag = 'saturated';
    else {
      const skew = Math.max(p.halfLeft, p.halfRight) / Math.max(1, Math.min(p.halfLeft, p.halfRight));
      if (skew >= params.tailingRatio || p.fwhm >= median * params.tailingRatio) flag = 'tailing';
    }
    out.set(i, flag);
  }
  return out;
}

/** 由检测峰值构造带像素级来源的 band 材料（auto-detect provenance） */
export function peaksToBands(
  lane: LaneMaterial,
  profile: Profile,
  peaks: RawPeak[],
  flags: Map<number, BandFlag>,
  eventId: string,
  projectId: string,
): BandObservation[] {
  return peaks.map((p, i) => {
    const idx = Math.max(0, Math.min(profile.xy.length - 1, Math.round(p.s)));
    const [x, y] = profile.xy[idx];
    const frame = lane.centerline[0]?.frame ?? 'image';
    const bandSeq = `${lane.index}-${String(i).padStart(2, '0')}`;
    const provenance: Provenance = {
      source: 'auto-detect',
      eventId,
      anchors: [{ x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10, frame }],
      note: `沿弧长亚像素定位 s=${p.s.toFixed(2)}`,
    };
    const cluster = p.cluster.length
      ? p.cluster.map((cs) => {
          const ci = Math.max(0, Math.min(profile.xy.length - 1, Math.round(cs)));
          const [cx2, cy2] = profile.xy[ci];
          return { x: Math.round(cx2 * 10) / 10, y: Math.round(cy2 * 10) / 10, frame };
        })
      : undefined;
    return {
      id: `band:${projectId}:L${lane.index}B${bandSeq}`,
      laneId: lane.id,
      center: { x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10, frame },
      peak: { value: Math.round(p.rawTop), unit: 'gray8' },
      fwhm: { value: Math.round(p.fwhm * 10) / 10, unit: 'px' },
      arcS: { value: Math.round(p.s * 100) / 100, unit: 'lane-arc-px' },
      flag: flags.get(i) ?? 'normal',
      cluster,
      provenance,
    } satisfies BandObservation;
  });
}

/** 弯曲泳道检测：逐行亮质心 + 连续跟踪，输出折线（每 stepPx 一点） */
export function detectCurvedCenterline(
  pixels: Uint8Array,
  width: number,
  height: number,
  startX: number,
  halfWidth: number,
  opts: { stepPx?: number; minGray?: number } = {},
): PixelPoint[] {
  const step = opts.stepPx ?? 16;
  const minGray = opts.minGray ?? 45;
  const rows: Array<{ y: number; x: number } | null> = [];
  for (let y = 0; y < height; y++) {
    let sum = 0;
    let wsum = 0;
    for (let x = Math.max(0, Math.round(startX - halfWidth * 2)); x < Math.min(width, Math.round(startX + halfWidth * 2)); x++) {
      const v = pixels[y * width + x];
      if (v >= minGray) {
        sum += x * v;
        wsum += v;
      }
    }
    rows.push(wsum > 0 ? { y, x: sum / wsum } : null);
  }
  // 缺行线性插值，保证折线连续（曲线残差在派生层对锚点计算）
  const filled: Array<{ y: number; x: number }> = [];
  for (let y = 0; y < height; y++) {
    if (rows[y]) filled.push(rows[y]!);
    else {
      let prev = y - 1;
      while (prev >= 0 && !rows[prev]) prev--;
      let next = y + 1;
      while (next < height && !rows[next]) next++;
      if (prev >= 0 && next < height) {
        const a = rows[prev]!;
        const b = rows[next]!;
        filled.push({ y, x: a.x + ((b.x - a.x) * (y - prev)) / (next - prev) });
      } else if (prev >= 0) filled.push({ y, x: rows[prev]!.x });
      else if (next < height) filled.push({ y, x: rows[next]!.x });
    }
  }
  const poly: PixelPoint[] = [];
  for (let y = 0; y < height; y += step) {
    poly.push({ x: Math.round(filled[y].x * 10) / 10, y, frame: 'image' });
  }
  const last = filled[filled.length - 1];
  if (poly[poly.length - 1].y !== last.y) {
    poly.push({ x: Math.round(last.x * 10) / 10, y: last.y, frame: 'image' });
  }
  return poly;
}

export function bandProfileAt(
  pixels: Uint8Array,
  width: number,
  height: number,
  lane: LaneMaterial,
  center: PixelPoint,
  windowPx = 60,
): { s: number[]; intensity: number[] } {
  const prof = extractLaneProfile(pixels, width, height, lane.centerline, lane.halfWidth.value);
  const proj = projectToPolyline(center.x, center.y, lane.centerline);
  const s0 = Math.max(0, Math.round(proj.s - windowPx));
  const s1 = Math.min(prof.s.length - 1, Math.round(proj.s + windowPx));
  return {
    s: prof.s.slice(s0, s1 + 1).map((v) => v - proj.s + windowPx),
    intensity: prof.intensity.slice(s0, s1 + 1),
  };
}
