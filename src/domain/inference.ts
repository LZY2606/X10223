import type {
  BandCenterMaterial,
  Diagnostic,
  InferenceCandidate,
  InputSummary,
  LaneTraceMaterial,
  Qty,
} from './types';
import { derivedId } from './ids';
import { projectionArcLength, polylineLength } from './geometry';
import { interpolateBp, type LadderAlignment } from './calibration';
import type { CalcParams } from './params';

export interface InferenceRecord {
  id: string;
  kind: 'inference';
  subjectId: string; // sample lane id
  state: 'ok' | 'candidate_set' | 'interval' | 'invalid';
  value: { candidates: InferenceCandidate[] };
  diagnostics: Diagnostic[];
  parentDerivedIds: string[];
}

/**
 * 样本 lane 分子量推断。
 * - 标尺是 ladder lane 弧长上的局部标尺（"微笑"时绝不跨 lane 用同一 y）。
 * - 饱和/拖尾/重叠：不给唯一点值，给区间（区间半宽取条带宽度对应迁移量）。
 * - 超出有效区域：该带 local failure，记录诊断而不是编造数值。
 */
export function inferLane(
  sampleLane: LaneTraceMaterial,
  bands: BandCenterMaterial[],
  alignment: LadderAlignment,
  calibrationId: string,
  params: CalcParams,
  inputSummary: InputSummary
): InferenceRecord {
  const total = polylineLength(sampleLane.centerline);
  const candidates: InferenceCandidate[] = [];
  const diagnostics: Diagnostic[] = [];

  for (const band of bands) {
    if (band.status === 'rejected' || band.status === 'superseded') continue;
    const s = projectionArcLength(sampleLane.centerline, band.center).s;
    const n = s / (alignment.totalLengthPx || total);
    const bandDiags: Diagnostic[] = [];
    const uncertain = band.saturated || band.tailing || !!band.overlapWith;

    if (band.saturated) {
      bandDiags.push({
        code: 'SATURATED_BAND',
        severity: 'warning',
        message: '饱和条带：峰平顶，中心弧长不确定，仅给区间',
        location: { bandId: band.id, laneId: sampleLane.id, at: band.center },
      });
    }
    if (band.tailing) {
      bandDiags.push({
        code: 'TAILING_BAND',
        severity: 'warning',
        message: '拖尾条带：质心偏移，仅给区间/候选',
        location: { bandId: band.id, laneId: sampleLane.id, at: band.center },
      });
    }
    if (band.overlapWith) {
      bandDiags.push({
        code: 'OVERLAPPING_BANDS',
        severity: 'warning',
        message: '与邻近条带重叠：两个分量都无法唯一拆分，保留区间',
        location: { bandId: band.id, laneId: sampleLane.id, at: band.center },
      });
    }

    if (uncertain) {
      const half = (band.widthPx / 2) / (alignment.totalLengthPx || total);
      const lo = interpolateBp(alignment, Math.max(alignment.spanNorm.min, n - half));
      const hi = interpolateBp(alignment, Math.min(alignment.spanNorm.max, n + half));
      const merged = [...lo.diagnostics, ...hi.diagnostics, ...bandDiags];
      if (Number.isNaN(lo.value) || Number.isNaN(hi.value)) {
        candidates.push({
          bandId: band.id,
          state: 'invalid',
          normalizedMigration: round6(n),
          segmentRefs: [],
          diagnostics: merged,
        });
      } else {
        const unit: Qty['unit'] = 'bp';
        candidates.push({
          bandId: band.id,
          state: 'interval',
          interval: { low: { value: round2(Math.min(lo.value, hi.value)), unit }, high: { value: round2(Math.max(lo.value, hi.value)), unit } },
          normalizedMigration: round6(n),
          segmentRefs: Array.from(new Set([...lo.segmentRefs, ...hi.segmentRefs])),
          diagnostics: merged,
        });
      }
    } else {
      const r = interpolateBp(alignment, n);
      if (Number.isNaN(r.value)) {
        candidates.push({
          bandId: band.id,
          state: 'invalid',
          normalizedMigration: round6(n),
          segmentRefs: [],
          diagnostics: r.diagnostics.map((d) => ({ ...d, location: { ...d.location, bandId: band.id, laneId: sampleLane.id } })),
        });
      } else {
        candidates.push({
          bandId: band.id,
          state: 'ok',
          molecularWeight: { value: round2(r.value), unit: 'bp' },
          normalizedMigration: round6(n),
          segmentRefs: r.segmentRefs,
          diagnostics: [],
        });
      }
    }
  }

  const state: InferenceRecord['state'] = candidates.every((c) => c.state === 'ok')
    ? 'ok'
    : candidates.some((c) => c.state === 'invalid') && !candidates.some((c) => c.state !== 'invalid')
      ? 'invalid'
      : candidates.some((c) => c.state === 'interval')
        ? 'interval'
        : 'candidate_set';

  for (const c of candidates) diagnostics.push(...c.diagnostics);

  const id = derivedId('inference', {
    lane: sampleLane.id,
    calibration: calibrationId,
    params: params.version,
    bands: bands
      .filter((b) => b.status !== 'rejected' && b.status !== 'superseded')
.map((b): [string, number, string, boolean, boolean, string | null] => [
          b.id,
          round6(projectionArcLength(sampleLane.centerline, b.center).s),
          b.status,
          b.saturated,
          b.tailing,
          b.overlapWith ?? null,
        ])
      .sort((a, b) => a[0].localeCompare(b[0])),
  });

  return {
    id,
    kind: 'inference',
    subjectId: sampleLane.id,
    state,
    value: { candidates },
    diagnostics,
    parentDerivedIds: [calibrationId],
  };
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
function round6(v: number): number {
  return Math.round(v * 1e6) / 1e6;
}
