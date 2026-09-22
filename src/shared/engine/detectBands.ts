// 条带检测：沿 lane 弯曲中线法向积分得到迁移轮廓（profile），再做峰值检测。
// 饱和平台/拖尾/重叠分别给出结构化标记；这些带只能成为候选或区间。
import { D, diag } from '../diagnostics.js';
import { nearestS, sampleAtS, totalArcLength } from '../geometry.js';
import type { Diagnostic } from '../types.js';
import type { DetectedLaneShape } from './detectLanes.js';

export interface ProfilePoint {
  s: number;
  x: number;
  y: number;
  absorbance: number;
}

export interface DetectedBandShape {
  laneIndex: number;
  peakS: number;
  centerX: number;
  centerY: number;
  halfWidthPx: number;
  lateralHalfWidthPx: number;
  peakAbsorbance: number;
  saturated: boolean;
  plateauPx: number;
  tailingAsymmetry: number;
  profileLeftHalfPx: number;
  profileRightHalfPx: number;
  overlapGroupRank?: number;
}

export interface DetectBandsResult {
  bands: DetectedBandShape[];
  profiles: Record<number, ProfilePoint[]>;
  diagnostics: Diagnostic[];
}

interface BandParams {
  bandProminenceZ: number;
  minBandGapPx: number;
  saturationAbsorbance: number;
  tailingAsymmetryThreshold: number;
  overlapHalfWidths: number;
}

export function detectBands(
  absorbance: Float32Array,
  width: number,
  height: number,
  lanes: DetectedLaneShape[],
  params: BandParams,
): DetectBandsResult {
  const diagnostics: Diagnostic[] = [];
  const profiles: Record<number, ProfilePoint[]> = {};
  const bands: DetectedBandShape[] = [];

  for (const lane of lanes) {
    const pts = lane.centerline;
    const sMax = totalArcLength(pts);
    const halfW = lane.halfWidthPx - 2;
    const profile: ProfilePoint[] = [];
    for (let s = 0; s <= sMax; s += 2) {
      const sm = sampleAtS(pts, s);
      if (!sm) continue;
      let sum = 0;
      let n = 0;
      for (let off = -halfW; off <= halfW; off += 2) {
        const x = Math.round(sm.p.x + sm.normal.x * off);
        const y = Math.round(sm.p.y + sm.normal.y * off);
        if (x < 0 || x >= width || y < 0 || y >= height) continue;
        sum += absorbance[y * width + x]!;
        n++;
      }
      profile.push({ s, x: sm.p.x, y: sm.p.y, absorbance: n ? sum / n : 0 });
    }
    profiles[lane.laneIndex] = profile;

    // 基线：滑动最小
    const win = 25;
    const base = profile.map((_, i) => {
      const lo = Math.max(0, i - win);
      const hi = Math.min(profile.length, i + win);
      let m = Infinity;
      for (let k = lo; k < hi; k++) m = Math.min(m, profile[k]!.absorbance);
      return m;
    });
    const corrected = profile.map((p, i) => Math.max(0, p.absorbance - base[i]!));
    const mean = corrected.reduce((a, b) => a + b, 0) / corrected.length;
    const sd =
      Math.sqrt(corrected.reduce((a, b) => a + (b - mean) ** 2, 0) / corrected.length) || 1e-6;
    const threshold = mean + params.bandProminenceZ * sd;

    const peaks: Array<{ i: number; v: number }> = [];
    for (let i = 2; i < corrected.length - 2; i++) {
      if (
        corrected[i]! > threshold &&
        corrected[i]! >= corrected[i - 1]! &&
        corrected[i]! >= corrected[i + 1]!
      ) {
        const last = peaks[peaks.length - 1];
        if (!last || profile[i]!.s - profile[last.i]!.s >= params.minBandGapPx) {
          peaks.push({ i, v: corrected[i]! });
        } else if (corrected[i]! > last.v) {
          last.i = i;
          last.v = corrected[i]!;
        }
      }
    }

    const shapes: DetectedBandShape[] = peaks.map((pk) => {
      const halfAt = corrected[pk.i]! * 0.5;
      let li = pk.i;
      while (li > 0 && corrected[li]! > halfAt) li--;
      let ri = pk.i;
      while (ri < corrected.length - 1 && corrected[ri]! > halfAt) ri++;
      const leftHalf = profile[pk.i]!.s - profile[Math.max(0, li)]!.s;
      const rightHalf = profile[Math.min(corrected.length - 1, ri)]!.s - profile[pk.i]!.s;
      const halfWidth = Math.max(3, (rightHalf + leftHalf) / 2);

      // 饱和平台：沿 s 方向吸光度连续顶到上限的跨度
      let plateau = 0;
      let maxRun = 0;
      for (let i = pk.i - 12; i <= pk.i + 12; i++) {
        if (i < 0 || i >= profile.length) continue;
        if (profile[i]!.absorbance >= params.saturationAbsorbance) {
          plateau += profile[1] ? profile[1].s - profile[0].s : 2;
          maxRun = Math.max(maxRun, plateau);
        } else {
          plateau = 0;
        }
      }
      const saturated =
        profile[pk.i]!.absorbance >= params.saturationAbsorbance && maxRun >= 4;
      const asym = leftHalf > 0 ? rightHalf / leftHalf : 1;

      return {
        laneIndex: lane.laneIndex,
        peakS: profile[pk.i]!.s,
        centerX: profile[pk.i]!.x,
        centerY: profile[pk.i]!.y,
        halfWidthPx: halfWidth,
        lateralHalfWidthPx: halfW,
        peakAbsorbance: Number(profile[pk.i]!.absorbance.toFixed(4)),
        saturated,
        plateauPx: Math.round(maxRun),
        tailingAsymmetry: Number(asym.toFixed(3)),
        profileLeftHalfPx: leftHalf,
        profileRightHalfPx: rightHalf,
      };
    });

    // 重叠聚类：两峰距离 < overlapHalfWidths * (半宽和)/2
    for (let i = 0; i < shapes.length; i++) {
      for (let j = i + 1; j < shapes.length; j++) {
        const d = Math.abs(shapes[j]!.peakS - shapes[i]!.peakS);
        const crit = params.overlapHalfWidths * ((shapes[i]!.halfWidthPx + shapes[j]!.halfWidthPx) / 2);
        if (d < crit) {
          const group = `${lane.laneIndex}:${i}`;
          shapes[i]!.overlapGroupRank = i;
          shapes[j]!.overlapGroupRank = j;
          diagnostics.push(
            diag(
              D.BANDS_OVERLAP,
              'warning',
              `泳道 ${lane.laneIndex} 中两条带在 s=${shapes[i]!.peakS.toFixed(1)}px 附近重叠（间距 ${d.toFixed(1)}px < ${crit.toFixed(1)}px），仅可给候选或区间`,
              `/bands/${group}`,
              { subjectId: group },
            ),
          );
        }
      }
      if (shapes[i]!.saturated) {
        diagnostics.push(
          diag(
            D.BAND_SATURATED,
            'warning',
            `泳道 ${lane.laneIndex} s=${shapes[i]!.peakS.toFixed(1)}px 条带饱和（平台 ${shapes[i]!.plateauPx}px），峰中心不可唯一化`,
            `/lane/${lane.laneIndex}/band/${i}`,
          ),
        );
      }
      if (shapes[i]!.tailingAsymmetry >= params.tailingAsymmetryThreshold) {
        diagnostics.push(
          diag(
            D.BAND_TAILING,
            'warning',
            `泳道 ${lane.laneIndex} s=${shapes[i]!.peakS.toFixed(1)}px 条带拖尾（不对称度 ${shapes[i]!.tailingAsymmetry}）`,
            `/lane/${lane.laneIndex}/band/${i}`,
          ),
        );
      }
    }

    bands.push(...shapes);
  }

  // 引用 nearestS 以保留“人工修订像素中心→弧长”的映射工具可达性
  void nearestS;
  return { bands, profiles, diagnostics };
}
