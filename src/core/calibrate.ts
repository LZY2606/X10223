import type { Diagnostic, Material } from './types.js';
import { contentId } from './ids.js';

export interface LadderBand {
  bandId: string;
  bp: number;
  pixel: { x: number; y: number; basis: 'image-pixel' };
}

export interface CalibrationSegment {
  segmentId: string;
  yMinPx: number;
  yMaxPx: number;
  logBpMin: number; // log10(bp) at yMaxPx（大 y 对应小分子量）
  logBpMax: number; // log10(bp) at yMinPx
  pointIds: [string, string];
  spansGap: boolean; // 跨越 ladder 缺带
  valid: boolean;
}

export interface CalibrationResult {
  segments: CalibrationSegment[];
  monotonic: boolean;
  missingSizesBp: number[];
  validity: { yMinPx: number; yMaxPx: number; basis: 'image-pixel' } | null;
  residuals: Array<{ bandId: string; yPx: number; residualLogBp: number }>;
}

/**
 * 由 ladder 标称值构建分段 log-linear 标尺。
 * 非单调标尺：判定失败并给出带位置的诊断，不产出可用插值段。
 * 缺带：保留段但标记 spansGap，并给诊断。
 */
export function buildCalibration(ladder: Material): {
  result: CalibrationResult;
  diagnostics: Diagnostic[];
} {
  const diagnostics: Diagnostic[] = [];
  const p = ladder.payload as {
    laneIndex: number;
    expectedSizesBp?: number[];
    bands: LadderBand[];
  };
  const bands = [...p.bands].sort((a, b) => a.pixel.y - b.pixel.y);

  // 非单调检查：y 增大时 bp 必须严格减小
  let monotonic = true;
  for (let i = 1; i < bands.length; i++) {
    if (bands[i].bp >= bands[i - 1].bp) {
      monotonic = false;
      diagnostics.push({
        code: 'NON_MONOTONIC_SCALE',
        severity: 'error',
        message: `ladder 标称值非单调：y=${bands[i - 1].pixel.y}px 处 ${bands[i - 1].bp}bp，y=${bands[i].pixel.y}px 处 ${bands[i].bp}bp`,
        position: {
          materialId: ladder.id,
          laneIndex: p.laneIndex,
          bandId: bands[i].bandId,
          pixel: { x: bands[i].pixel.x, y: bands[i].pixel.y },
        },
      });
    }
  }

  // 缺带检查：标称规格中声明的大小是否都出现
  const present = new Set(bands.map((b) => b.bp));
  const missingSizesBp = (p.expectedSizesBp ?? []).filter((s) => !present.has(s));
  for (const size of missingSizesBp) {
    diagnostics.push({
      code: 'LADDER_GAP',
      severity: 'warning',
      message: `ladder 缺带：标称 ${size}bp 未在 ladder 泳道中出现，跨越该处的插值段仅作候选`,
      position: { materialId: ladder.id, laneIndex: p.laneIndex },
    });
  }

  const segments: CalibrationSegment[] = [];
  if (monotonic && bands.length >= 2) {
    for (let i = 0; i + 1 < bands.length; i++) {
      const a = bands[i];
      const b = bands[i + 1];
      // 段是否跨越缺带：段区间内是否存在标称大小缺失
      const lo = b.bp;
      const hi = a.bp;
      const spansGap = missingSizesBp.some((s) => s > lo && s < hi);
      const segPayload = {
        ladderId: ladder.id,
        y0: a.pixel.y,
        y1: b.pixel.y,
        bp0: a.bp,
        bp1: b.bp,
      };
      segments.push({
        segmentId: contentId('seg', segPayload),
        yMinPx: a.pixel.y,
        yMaxPx: b.pixel.y,
        logBpMax: Math.log10(a.bp),
        logBpMin: Math.log10(b.bp),
        pointIds: [a.bandId, b.bandId],
        spansGap,
        valid: !spansGap,
      });
    }
  }

  // 拟合残差：全局 log10(bp)~y 最小二乘，用于复核页残差图
  const residuals: CalibrationResult['residuals'] = [];
  if (monotonic && bands.length >= 2) {
    const n = bands.length;
    const sy = bands.reduce((s, b) => s + b.pixel.y, 0);
    const sl = bands.reduce((s, b) => s + Math.log10(b.bp), 0);
    const syy = bands.reduce((s, b) => s + b.pixel.y * b.pixel.y, 0);
    const syl = bands.reduce((s, b) => s + b.pixel.y * Math.log10(b.bp), 0);
    const denom = n * syy - sy * sy;
    if (denom !== 0) {
      const slope = (n * syl - sy * sl) / denom;
      const intercept = (sl - slope * sy) / n;
      for (const b of bands) {
        residuals.push({
          bandId: b.bandId,
          yPx: b.pixel.y,
          residualLogBp: Math.log10(b.bp) - (slope * b.pixel.y + intercept),
        });
      }
    }
  }

  const validity =
    monotonic && bands.length >= 2
      ? {
          yMinPx: bands[0].pixel.y,
          yMaxPx: bands[bands.length - 1].pixel.y,
          basis: 'image-pixel' as const,
        }
      : null;

  return {
    result: { segments, monotonic, missingSizesBp, validity, residuals },
    diagnostics,
  };
}
