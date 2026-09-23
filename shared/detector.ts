import type { MaterialBandCenter, MaterialLaneBoundary, PixelPoint } from './types.js';

// 直接对像素工作的自动候选检测；全部结果可追溯到像素坐标。

export interface DetectorParams {
  minProminence: number;   // 灰度峰高出背景的最小增量
  minBandSpacing: number;  // px
  satLevel: number;        // 饱和灰度阈值
  tailRatio: number;       // 下半宽/上半宽 超过此值判拖尾
  overlapRatio: number;    // 峰间距 / fwhm 小于此值判重叠
}

export const DEFAULT_DETECTOR_PARAMS: DetectorParams = {
  minProminence: 18,
  minBandSpacing: 5,
  satLevel: 252,
  tailRatio: 1.6,
  overlapRatio: 1.35,
};

export interface ProfilePoint { s: number; gray: number }

function idx(x: number, y: number, w: number) { return y * w + x; }

/** 沿泳道中脊逐点做法向平均，得到灰度剖面。 */
export function laneProfile(
  gray: Uint8Array, w: number, h: number,
  spine: PixelPoint[], halfWidth: number,
): ProfilePoint[] {
  const out: ProfilePoint[] = [];
  for (let i = 0; i < spine.length; i++) {
    const a = spine[Math.max(0, i - 1)];
    const b = spine[Math.min(spine.length - 1, i + 1)];
    const dx = b.x - a.x; const dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len; const ny = dx / len;
    let sum = 0; let count = 0;
    const samples = Math.max(2, Math.floor(halfWidth) - 1);
    for (let k = -samples; k <= samples; k++) {
      const x = Math.round(spine[i].x + nx * k);
      const y = Math.round(spine[i].y + ny * k);
      if (x >= 0 && y >= 0 && x < w && y < h) { sum += gray[idx(x, y, w)]; count++; }
    }
    // 弧长
    let s: number;
    if (i === 0) s = 0;
    else {
      let acc = 0;
      for (let j = 1; j <= i; j++) acc += Math.hypot(spine[j].x - spine[j - 1].x, spine[j].y - spine[j - 1].y);
      s = acc;
    }
    out.push({ s, gray: count ? sum / count : 0 });
  }
  return out;
}

/** 从整图按纵向亮度投影找泳道中心（自动候选）。 */
export function detectLaneCenters(gray: Uint8Array, w: number, h: number, topMargin: number, bottomMargin: number): { center: number; strength: number }[] {
  const col = new Float64Array(w);
  for (let y = topMargin; y < h - bottomMargin; y++) {
    for (let x = 0; x < w; x++) col[x] += gray[y * w + x];
  }
  const lanes: { center: number; strength: number }[] = [];
  const smooth = 3;
  const val = (x: number) => {
    let s = 0; let n = 0;
    for (let k = -smooth; k <= smooth; k++) {
      const xx = x + k;
      if (xx >= 0 && xx < w) { s += col[xx]; n++; }
    }
    return s / n;
  };
  for (let x = 2; x < w - 2; x++) {
    const v = val(x);
    if (v > val(x - 1) && v >= val(x + 1) && v > val(x - 6) && v > val(x + 6)) {
      if (!lanes.length || x - lanes[lanes.length - 1].center > 18) lanes.push({ center: x, strength: v });
    }
  }
  return lanes.sort((a, b) => a.center - b.center);
}

/** 中脊追踪：在每条扫描线上于窗口内求亮度质心，允许蛇形/微笑弯曲。 */
export function traceSpine(
  gray: Uint8Array, w: number, h: number,
  startX: number, halfWidth: number,
): { spine: PixelPoint[]; left: PixelPoint[]; right: PixelPoint[] } {
  const spine: PixelPoint[] = [];
  const window = halfWidth;
  let cx = startX;
  for (let y = 14; y < h - 10; y += 4) {
    let m0 = 0; let m1 = 0;
    for (let x = Math.max(0, Math.round(cx - window)); x <= Math.min(w - 1, Math.round(cx + window)); x++) {
      const v = gray[y * w + x];
      m0 += v; m1 += v * x;
    }
    if (m0 > 0) cx = 0.6 * cx + 0.4 * (m1 / m0);
    spine.push({ x: cx, y });
  }
  const normal: PixelPoint[] = spine.map((p, i) => {
    const a = spine[Math.max(0, i - 1)];
    const b = spine[Math.min(spine.length - 1, i + 1)];
    const dx = b.x - a.x; const dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    return { x: -dy / len, y: dx / len };
  });
  const left = spine.map((p, i) => ({ x: p.x + normal[i].x * halfWidth, y: p.y + normal[i].y * halfWidth }));
  const right = spine.map((p, i) => ({ x: p.x - normal[i].x * halfWidth, y: p.y - normal[i].y * halfWidth }));
  return { spine, left, right };
}

export interface DetectedBand {
  s: number;
  center: PixelPoint;
  peakGray: number;
  fwhm: number;
  saturated: boolean;
  tailing: boolean;
  plateau: number; // 峰顶平台宽度 px（饱和指示）
  profile: ProfilePoint[];
}

function baseline(profile: ProfilePoint[]): number {
  const vals = profile.map((p) => p.gray).sort((a, b) => a - b);
  return vals[Math.floor(vals.length * 0.2)];
}

/** 在剖面中找峰，亚像素修正并分类饱和/拖尾。 */
export function detectBands(profile: ProfilePoint[], params: DetectorParams = DEFAULT_DETECTOR_PARAMS): DetectedBand[] {
  if (profile.length < 5) return [];
  const base = baseline(profile);
  const peaks: { i: number; prom: number }[] = [];
  for (let i = 2; i < profile.length - 2; i++) {
    const g = profile[i].gray;
    if (g - base < params.minProminence) continue;
    if (g >= profile[i - 1].gray && g >= profile[i + 1].gray &&
        g > profile[i - 2].gray && g > profile[i + 2].gray) {
      peaks.push({ i, prom: g - base });
    }
  }
  // 峰间距过小且无鞍部则合并，保留肩峰信息
  const bands: DetectedBand[] = [];
  for (const pk of peaks) {
    const i = pk.i;
    // 亚像素二次插值
    const y0 = profile[i - 1].gray - base;
    const y1 = profile[i].gray - base;
    const y2 = profile[i + 1].gray - base;
    const denom = (y0 - 2 * y1 + y2);
    const delta = denom !== 0 ? 0.5 * (y0 - y2) / denom : 0;
    const ds = profile[i + 1].s - profile[i - 1].s;
    const s = profile[i].s + Math.max(-0.5, Math.min(0.5, delta)) * ds * 0.5;
    const half = y1 / 2;
    let lo = i; let hi = i;
    while (lo > 0 && profile[lo].gray - base > half) lo--;
    while (hi < profile.length - 1 && profile[hi].gray - base > half) hi++;
    const fwhm = Math.max(1.5, profile[hi].s - profile[lo].s);
    const upper = profile[i].s - profile[lo].s;
    const lower = profile[hi].s - profile[i].s;
    const tailing = lower / Math.max(1e-6, upper) > params.tailRatio;
    // 饱和平台
    let plateau = 0;
    for (let k = i; k < profile.length && profile[k].gray >= params.satLevel; k++) plateau++;
    for (let k = i - 1; k >= 0 && profile[k].gray >= params.satLevel; k--) plateau++;
    const saturated = profile[i].gray >= params.satLevel || plateau * (profile[1].s - profile[0].s) > fwhm * 0.45;
    bands.push({
      s, center: { x: 0, y: 0 }, peakGray: Math.round(profile[i].gray),
      fwhm, saturated, tailing, plateau,
      profile,
    });
  }
  // 重叠标注在 toBandCenters 时做
  return bands.sort((a, b) => a.s - b.s);
}

/** 把检测峰转为带像素来源的条带材料；重叠条带互配。 */
export function toBandCenters(
  lane: MaterialLaneBoundary,
  detected: DetectedBand[],
  params: DetectorParams,
  makeId: (s: number) => string,
): MaterialBandCenter[] {
  const pointAt = (s: number): PixelPoint => {
    const cum: number[] = [0];
    for (let i = 1; i < lane.spine.length; i++) {
      cum.push(cum[i - 1] + Math.hypot(lane.spine[i].x - lane.spine[i - 1].x, lane.spine[i].y - lane.spine[i - 1].y));
    }
    let i = 0;
    while (i < cum.length - 1 && cum[i + 1] < s) i++;
    const i1 = Math.min(i + 1, cum.length - 1);
    const f = (cum[i1] - cum[i]) > 0 ? (s - cum[i]) / (cum[i1] - cum[i]) : 0;
    return {
      x: lane.spine[i].x + (lane.spine[i1].x - lane.spine[i].x) * f,
      y: lane.spine[i].y + (lane.spine[i1].y - lane.spine[i].y) * f,
    };
  };
  const pairs = new Map<number, number[]>();
  for (let i = 0; i < detected.length; i++) {
    for (let j = i + 1; j < detected.length; j++) {
      const gap = detected[j].s - detected[i].s;
      const meanFwhm = (detected[i].fwhm + detected[j].fwhm) / 2;
      if (gap < params.overlapRatio * meanFwhm) {
        pairs.set(i, [...(pairs.get(i) ?? []), j]);
        pairs.set(j, [...(pairs.get(j) ?? []), i]);
      }
    }
  }
  return detected.map((d, i) => {
    const id = makeId(d.s);
    const overlaps = (pairs.get(i) ?? []).map((j) => makeId(detected[j].s));
    return {
      kind: 'bandCenter' as const,
      id,
      imageId: lane.imageId,
      laneId: lane.id,
      center: pointAt(d.s),
      profile: d.profile.map((p) => ({ s: Number(p.s.toFixed(3)), gray: Math.round(p.gray) })),
      arcLength: { value: Number(d.s.toFixed(3)), unit: 'px' as const },
      peakGray: d.peakGray,
      saturated: d.saturated,
      tailing: d.tailing,
      source: 'auto-candidate' as const,
      overlapsWith: overlaps.length ? overlaps : undefined,
      fwhm: { value: Number(d.fwhm.toFixed(2)), unit: 'px' as const },
    };
  });
}
