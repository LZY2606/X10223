import type { BandClass, LanePath } from '../shared/types.js';

/** 沿泳道路径按弧长采样灰度（双线性最近邻即可，保持确定性） */
export function sampleProfile(
  pixels: Uint8Array, width: number, height: number, path: LanePath, step = 1,
): { s: number[]; v: number[] } {
  const s: number[] = [];
  const v: number[] = [];
  for (let i = 0; i < path.points.length - 1; i++) {
    const a = path.points[i];
    const b = path.points[i + 1];
    const segLen = path.arc[i + 1] - path.arc[i];
    const n = Math.max(1, Math.round(segLen / step));
    for (let k = 0; k < n; k++) {
      const t = k / n;
      const x = Math.round(a.x + t * (b.x - a.x));
      const y = Math.round(a.y + t * (b.y - a.y));
      if (x < 0 || y < 0 || x >= width || y >= height) continue;
      s.push(path.arc[i] + t * segLen);
      v.push(pixels[y * width + x]);
    }
  }
  return { s, v };
}

export interface PeakInfo {
  sPeak: number;
  maxV: number;
  plateauWidth: number;
  leftHalfS: number;
  rightHalfS: number;
  asymmetry: number; // 右半宽/左半宽，>1.8 视为拖尾
}

export function findPeaks(s: number[], v: number[], minHeight: number, minDistance: number): PeakInfo[] {
  const peaks: PeakInfo[] = [];
  for (let i = 1; i < v.length - 1; i++) {
    if (v[i] < minHeight) continue;
    if (v[i] >= v[i - 1] && v[i] >= v[i + 1] && (v[i] > v[i - 1] || v[i] > v[i + 1])) {
      const last = peaks[peaks.length - 1];
      if (last && s[i] - last.sPeak < minDistance) {
        if (v[i] > last.maxV) peaks[peaks.length - 1] = makePeak(s, v, i);
        continue;
      }
      peaks.push(makePeak(s, v, i));
    }
  }
  return peaks;
}

function makePeak(s: number[], v: number[], i: number): PeakInfo {
  const maxV = v[i];
  // 饱和平台宽度
  let plateauWidth = 1;
  while (i - plateauWidth >= 0 && v[i - plateauWidth] === maxV) plateauWidth++;
  let j = i + 1;
  while (j < v.length && v[j] === maxV) { plateauWidth++; j++; }
  const half = maxV / 2;
  let l = i;
  while (l > 0 && v[l] > half) l--;
  let r = i;
  while (r < v.length - 1 && v[r] > half) r++;
  const leftW = s[i] - s[l];
  const rightW = s[r] - s[i];
  return {
    sPeak: s[i],
    maxV,
    plateauWidth,
    leftHalfS: s[l],
    rightHalfS: s[r],
    asymmetry: leftW > 0 ? rightW / leftW : 1,
  };
}

export interface ClassifyOptions {
  grayMax: number;          // 饱和灰度（如 255）
  saturationPlateau: number; // 平台宽度阈值（px）
  tailingAsymmetry: number;  // 拖尾不对称阈值
  overlapGap: number;        // 两峰间距小于该值视为重叠
}

/**
 * 条带分类：饱和 / 拖尾 / 重叠只能标为候选或区间，绝不给唯一点估计。
 */
export function classifyPeaks(peaks: PeakInfo[], opts: ClassifyOptions): { peak: PeakInfo; cls: BandClass }[] {
  const out: { peak: PeakInfo; cls: BandClass }[] = [];
  for (let i = 0; i < peaks.length; i++) {
    const p = peaks[i];
    const saturated = p.maxV >= opts.grayMax && p.plateauWidth >= opts.saturationPlateau;
    const tailing = p.asymmetry >= opts.tailingAsymmetry;
    const prev = peaks[i - 1];
    const next = peaks[i + 1];
    const overlapPrev = prev && p.sPeak - prev.sPeak < opts.overlapGap;
    const overlapNext = next && next.sPeak - p.sPeak < opts.overlapGap;
    if (overlapPrev || overlapNext) {
      // 重叠组：保留全部合法候选
      const group: PeakInfo[] = [p];
      if (overlapPrev && !out.some((o) => o.peak === prev)) group.push(prev);
      if (overlapNext) group.push(next);
      out.push({
        peak: p,
        cls: { kind: 'candidate-group', candidates: group.map((g) => ({ s: g.sPeak })), cause: 'overlap' },
      });
    } else if (saturated) {
      out.push({ peak: p, cls: { kind: 'interval', sLo: p.leftHalfS, sHi: p.rightHalfS, cause: 'saturated' } });
    } else if (tailing) {
      out.push({ peak: p, cls: { kind: 'interval', sLo: p.leftHalfS, sHi: p.rightHalfS, cause: 'tailing' } });
    } else {
      out.push({ peak: p, cls: { kind: 'point', s: p.sPeak } });
    }
  }
  return out;
}
