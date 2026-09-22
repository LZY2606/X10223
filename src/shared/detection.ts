import type {
  BandCandidate,
  CalibrationParams,
  Finding,
  ProfilePoint
} from './types';
import { contentId } from './ids';
import { rollingBaseline } from './geometry';

export interface RawPeak {
  centerS: number;
  x: number;
  y: number;
  peak: number;
  halfLowS: number;
  halfHighS: number;
  widthHalf: number;
  saturated: boolean;
  tailing: boolean;
  tailAsymmetry: number;
}

/**
 * 剖面峰检测（确定性、可直接单测，不依赖浏览器）。
 * 规则：
 *  - 背景滚动基线校正后，按 prominence 找局部极大；
 *  - 峰顶达到饱和阈值 -> saturated，强度不能再当作线性证据；
 *  - 半高宽两侧不对称比 > 1.6 -> 拖尾；
 *  - 相邻峰中心距 < overlapDistancePx -> 同 overlapGroup，保留组内全部候选。
 */
export function detectPeaks(
  profile: ProfilePoint[],
  params: CalibrationParams,
  saturationLevel: number,
  maxPixelsHint = Infinity
): { peaks: RawPeak[]; findings: Finding[]; exhausted: boolean } {
  const findings: Finding[] = [];
  if (profile.length < 8) {
    findings.push({
      code: 'PROFILE_TOO_SHORT',
      severity: 'error',
      message: '剖面点数不足，无法检测条带',
      subject: null
    });
    return { peaks: [], findings, exhausted: false };
  }
  if (profile.length > maxPixelsHint) {
    return { peaks: [], findings, exhausted: true };
  }

  const raw = profile.map((p) => p.intensity);
  const baseline = rollingBaseline(raw, Math.max(9, Math.floor(profile.length / 12) | 1));
  const values = raw.map((v, i) => Math.max(0, v - baseline[i]));

  const peaks: RawPeak[] = [];
  for (let i = 2; i < values.length - 2; i += 1) {
    const v = values[i];
    if (v < params.peakProminence) continue;
    if (v <= values[i - 1] || v < values[i + 1]) continue;

    // 半高位置
    const half = v / 2;
    let lo = i;
    while (lo > 0 && values[lo] > half) lo -= 1;
    let hi = i;
    while (hi < values.length - 1 && values[hi] > half) hi += 1;
    const leftW = i - lo;
    const rightW = hi - i;
    const widthHalf = leftW + rightW;
    const asymmetry = rightW / Math.max(1, leftW);
    const tailing = asymmetry > 1.6 || leftW / Math.max(1, rightW) > 1.6;
    const saturated = raw[i] >= saturationLevel;

    const point = profile[i];
    peaks.push({
      centerS: point.s,
      x: point.x,
      y: point.y,
      peak: raw[i],
      halfLowS: profile[Math.max(0, lo)].s,
      halfHighS: profile[Math.min(profile.length - 1, hi)].s,
      widthHalf: (widthHalf * (profile[1].s - profile[0].s)),
      saturated,
      tailing,
      tailAsymmetry: asymmetry
    });

    if (saturated) {
      findings.push({
        code: 'SATURATED_BAND',
        severity: 'warning',
        message: '峰顶达到饱和阈值，强度与中心定位不可作为唯一证据，仅允许候选/区间',
        subject: { kind: 'peak', id: `@${point.s.toFixed(1)}` },
        at: { x: point.x, y: point.y },
        data: { peak: raw[i], saturationLevel }
      });
    }
    if (tailing) {
      findings.push({
        code: 'TAILING_BAND',
        severity: 'warning',
        message: '条带拖尾（半高宽不对称），仅允许区间解',
        subject: { kind: 'peak', id: `@${point.s.toFixed(1)}` },
        at: { x: point.x, y: point.y },
        data: { asymmetry: Number(asymmetry.toFixed(2)) }
      });
    }
  }

  // 重叠分组（按迁移距离排序后贪心合并近邻）
  peaks.sort((a, b) => a.centerS - b.centerS);
  const groupOf = new Map<number, string>();
  for (let i = 0; i < peaks.length; i += 1) {
    if (groupOf.has(i)) continue;
    const gid = `ovlp_${peaks[i].centerS.toFixed(1)}`;
    groupOf.set(i, gid);
    for (let j = i + 1; j < peaks.length; j += 1) {
      if (peaks[j].centerS - peaks[i].centerS <= params.overlapDistancePx) groupOf.set(j, gid);
    }
  }
  const groupSizes = new Map<string, number>();
  for (const gid of groupOf.values()) groupSizes.set(gid, (groupSizes.get(gid) ?? 0) + 1);

  return {
    peaks: peaks.map((peak, i) => {
      const gid = groupOf.get(i);
      if (gid && (groupSizes.get(gid) ?? 0) > 1) {
        findings.push({
          code: 'OVERLAPPING_BANDS',
          severity: 'warning',
          message: '两条带中心距过小发生重叠，无法唯一指派，保留组内全部合法候选',
          subject: { kind: 'peak', id: `@${peak.centerS.toFixed(1)}` },
          at: { x: peak.x, y: peak.y },
          data: { overlapGroup: gid }
        });
      }
      return peak;
    }),
    findings,
    exhausted: false
  };
}

export function toCandidates(
  laneOrdinal: number,
  peaks: RawPeak[],
  params: CalibrationParams
): BandCandidate[] {
  // 重新计算 overlap group 与 detectPeaks 一致的方式
  const groupOf = new Map<number, string>();
  for (let i = 0; i < peaks.length; i += 1) {
    if (groupOf.has(i)) continue;
    const gid = `ovlp_${peaks[i].centerS.toFixed(1)}`;
    groupOf.set(i, gid);
    for (let j = i + 1; j < peaks.length; j += 1) {
      if (peaks[j].centerS - peaks[i].centerS <= params.overlapDistancePx) groupOf.set(j, gid);
    }
  }
  const sizes = new Map<string, number>();
  for (const gid of groupOf.values()) sizes.set(gid, (sizes.get(gid) ?? 0) + 1);

  return peaks.map((peak, i) => {
    const gid = groupOf.get(i) ?? null;
    const overlapping = gid !== null && (sizes.get(gid) ?? 0) > 1;
    const status: BandCandidate['status'] =
      peak.saturated || peak.tailing || overlapping ? 'candidate' : 'candidate';
    const base = {
      laneOrdinal,
      centerX: round2(peak.x),
      centerY: round2(peak.y),
      sPx: round2(peak.centerS),
      sHalfLowPx: round2(peak.halfLowS),
      sHalfHighPx: round2(peak.halfHighS),
      widthHalfPx: round2(peak.widthHalf),
      peakIntensity: round2(peak.peak),
      saturated: peak.saturated,
      tailing: peak.tailing,
      overlapGroup: overlapping ? gid : null,
      status
    };
    return { ...base, id: contentId('band', base) };
  });
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
