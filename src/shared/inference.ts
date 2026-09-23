import type {
  CalibrationResult,
  InferenceResult,
  InferredBand,
  LaneAnnotationMaterial,
  MwCandidate,
} from './types.js';
import { arcTable, projectToPolyline } from './geometry.js';
import { contentId } from './hash.js';
import type { PipelineParams } from './params.js';

export interface InferInput {
  frameId: string;
  lanes: LaneAnnotationMaterial;
  detection: DetectionResult;
  calibration: CalibrationResult;
  /** bandRef（按弧长排序）→ entryOrdinal（首选配对），来自校准输入材料。 */
  ladderNominalByBand: (pair: { bandRef: string; entryOrdinal: number }) => number | null;
  params: PipelineParams;
}

/**
 * 分子量推断（逐泳道、局部标尺）。
 *  - 沿每条 sample 泳道自身中心线投影出 f=s/L，再在覆盖 f 的插值段内求值；
 *  - f 落在任一段有效区域外 → out_of_range，绝不外推；
 *  - 饱和/拖尾 → 只能给区间；重叠 → 保留每个峰的候选并给并集区间；
 *  - 缺带导致多配对时 → candidate，保留全部合法候选；
 *  - ladder 泳道本身（标尺来源）局部失效标记 LOCAL_CALIBRATION_INVALID。
 */
export function inferMw(input: InferInput): InferenceResult {
  const { lanes, detection, calibration, params, frameId, ladderNominalByBand } = input;
  const perBand: InferredBand[] = [];
  const diagnostics: InferenceResult['diagnostics'] = [];

  // 预计算每个配对候选的分段映射（f 域 log MW）。
  const candidateMaps = calibration.pairingCandidates.map((pair) => {
    const ordered = pair.assignment;
    const segs: { fA: number; fB: number; logA: number; logB: number; ids: string[] }[] = [];
    for (let i = 0; i < ordered.length - 1; i++) {
      const pa = calibration.ladderPoints.find((p) => p.bandRef === ordered[i].bandRef)!;
      const pb = calibration.ladderPoints.find((p) => p.bandRef === ordered[i + 1].bandRef)!;
      const vA = ladderNominalByBand(ordered[i]);
      const vB = ladderNominalByBand(ordered[i + 1]);
      if (vA === null || vB === null) continue;
      const fA = pa.s / laneFractionDenom(calibration);
      const fB = pb.s / laneFractionDenom(calibration);
      segs.push({ fA, fB, logA: Math.log10(vA), logB: Math.log10(vB), ids: [pa.bandRef, pb.bandRef] });
    }
    return segs;
  });

  for (const band of detection.bands) {
    const lane = lanes.lanes.find((l) => l.laneRef === band.laneRef);
    if (!lane) {
      diagnostics.push({ code: 'INCOMPLETE_INPUT', message: `条带 ${band.bandRef} 的泳道缺失`, laneRef: band.laneRef });
      continue;
    }
    const table = arcTable(lane.centerline);
    const laneLength = table[table.length - 1].s;
    const s = projectToPolyline(lane.centerline, band.center).s;
    const f = s / laneLength;

    const segIndex = calibration.segments.findIndex(
      (g) => f >= g.validRange.fMin - 1e-9 && f <= g.validRange.fMax + 1e-9,
    );
    const reasons: InferredBand['reasons'] = [];
    if (band.status === 'saturated' || band.plateau) reasons.push('SATURATED_BAND');
    if (band.status === 'tailing') reasons.push('TAILING_BAND');
    if (band.overlapGroupId || band.status === 'overlapping') reasons.push('OVERLAPPING_BANDS');

    const out: InferredBand = {
      bandRef: band.bandRef,
      laneRef: band.laneRef,
      center: band.center,
      arcLength: Math.round(s * 100) / 100,
      fraction: Math.round(f * 1e5) / 1e5,
      status: 'unique',
      point: null,
      candidates: [],
      interval: null,
      reasons,
      segmentIndex: segIndex === -1 ? null : segIndex,
    };

    if (segIndex === -1) {
      out.status = 'out_of_range';
      reasons.push('OUT_OF_VALID_RANGE');
      diagnostics.push({
        code: 'OUT_OF_VALID_RANGE',
        message: `条带 ${band.bandRef} 位于 f=${f.toFixed(3)}，超出 ladder 有效区域，不外推`,
        laneRef: band.laneRef,
        at: band.center,
      });
      perBand.push(out);
      continue;
    }

    if (band.laneRef === calibration.ladderLaneRef) {
      out.status = 'unresolved';
      reasons.push('LOCAL_CALIBRATION_INVALID');
      diagnostics.push({
        code: 'LOCAL_CALIBRATION_INVALID',
        message: `条带 ${band.bandRef} 属于标尺泳道，标尺点不能作为独立分子量推断`,
        laneRef: band.laneRef,
        segmentIndex: segIndex,
      });
      perBand.push(out);
      continue;
    }

    const cands: MwCandidate[] = [];
    for (const segs of candidateMaps) {
      const seg = segs[segIndex];
      if (!seg || f < Math.min(seg.fA, seg.fB) - 1e-9 || f > Math.max(seg.fA, seg.fB) + 1e-9) continue;
      const t = (f - seg.fA) / (seg.fB - seg.fA || 1);
      const logMw = seg.logA + t * (seg.logB - seg.logA);
      cands.push({
        value: Math.round(10 ** logMw * 100) / 100,
        unit: calibration.unit,
        segmentIndex: segIndex,
        ladderPointIds: seg.ids,
      });
    }
    const uniqueCands = dedupeCandidates(cands);
    const uncertainty = uniqueCands.length > 1;

    if (reasons.length > 0) {
      const widthFrac = band.widthPx ? band.widthPx / laneLength : 0.006;
      const loSeg = calibration.segments[segIndex];
      const fLo = Math.max(loSeg.validRange.fMin, f - widthFrac);
      const fHi = Math.min(loSeg.validRange.fMax, f + widthFrac);
      let lo = Infinity;
      let hi = -Infinity;
      for (const segs of candidateMaps) {
        const seg = segs[segIndex];
        if (!seg) continue;
        for (const ff of [fLo, fHi]) {
          const t = (ff - seg.fA) / (seg.fB - seg.fA || 1);
          if (t < -1e-9 || t > 1 + 1e-9) continue;
          const v = 10 ** (seg.logA + t * (seg.logB - seg.logA));
          lo = Math.min(lo, v);
          hi = Math.max(hi, v);
        }
      }
      out.interval = { low: Math.round(lo * 100) / 100, high: Math.round(hi * 100) / 100, unit: calibration.unit };
      out.candidates = uniqueCands;
      out.status = uncertainty ? 'candidate' : 'interval';
      if (reasons.includes('OVERLAPPING_BANDS')) {
        diagnostics.push({
          code: 'OVERLAPPING_BANDS',
          message: `条带 ${band.bandRef} 与邻近条带重叠，仅给区间/候选`,
          laneRef: band.laneRef,
          at: band.center,
        });
      }
      if (reasons.includes('SATURATED_BAND')) {
        diagnostics.push({
          code: 'SATURATED_BAND',
          message: `条带 ${band.bandRef} 平台饱和，中心位置不可信，仅给区间`,
          laneRef: band.laneRef,
          at: band.center,
        });
      }
      if (reasons.includes('TAILING_BAND')) {
        diagnostics.push({
          code: 'TAILING_BAND',
          message: `条带 ${band.bandRef} 拖尾，仅给区间`,
          laneRef: band.laneRef,
          at: band.center,
        });
      }
    } else if (uncertainty) {
      out.status = 'candidate';
      out.candidates = uniqueCands;
      reasons.push('AMBIGUOUS_MATCH');
    } else {
      out.status = 'unique';
      out.point = uniqueCands[0] ?? null;
    }

    perBand.push(out);
  }

  const resultBase = {
    kind: 'inference' as const,
    frameId,
    calibrationId: calibration.id,
    paramsVersion: params.version!,
    parentIds: [lanes.id, detection.id, calibration.id],
    perBand,
    diagnostics,
    inputSummary: {
      lanes: lanes.id,
      detection: detection.id,
      calibration: calibration.id,
      paramsVersion: params.version,
      bandCount: detection.bands.length,
    },
  };
  return { ...resultBase, id: contentId('inf', resultBase) };
}

function laneFractionDenom(cal: CalibrationResult): number {
  return cal.inputSummary.ladderLaneLengthPx as number;
}

function dedupeCandidates(list: MwCandidate[]): MwCandidate[] {
  const seen = new Set<string>();
  return list.filter((c) => {
    const key = c.value.toFixed(1);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
