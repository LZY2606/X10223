import { segmentIdDigest } from './calibration.js';
import { stableDigest } from './hash.js';
import type {
  BandObservationMaterial,
  CalibrationResult,
  DomainValue,
  InferenceResult,
  MwCandidate
} from './types.js';

function mwAt(cal: CalibrationResult, s: number): { value: number; segmentId: string; pointIds: string[] } | null {
  for (const seg of cal.segments) {
    if (s >= seg.validS[0] && s <= seg.validS[1]) {
      const value = Math.pow(10, seg.slope * s + seg.intercept);
      return {
        value,
        segmentId: seg.id,
        pointIds: [seg.fromLadderBandId, seg.toLadderBandId]
      };
    }
  }
  return null;
}

function dv(value: number, unit: DomainValue['unit'], s: number): DomainValue {
  return {
    value,
    unit,
    raw: `${value >= 1000 ? value.toFixed(0) : value.toFixed(1)} bp`,
    ref: { frameId: 'calibration', frameKind: 'lane-local', axis: 'mw', unit }
  };
}

/** 自动推断：绝不越界外推；饱和=候选，拖尾=区间，重叠=保留全部合法候选。 */
export function inferMolecularWeights(
  laneId: string,
  bands: BandObservationMaterial[],
  cal: CalibrationResult
): InferenceResult {
  const diagnostics = [...cal.diagnostics];
  const unit = cal.points[0]?.nominal.unit ?? 'bp';

  const groups = new Map<string, BandObservationMaterial[]>();
  for (const b of bands) {
    if (b.overlapGroupId) {
      const arr = groups.get(b.overlapGroupId) ?? [];
      arr.push(b);
      groups.set(b.overlapGroupId, arr);
    }
  }

  const candidates: MwCandidate[] = bands
    .slice()
    .sort((a, b) => (a.arcLength?.value ?? 0) - (b.arcLength?.value ?? 0))
    .map((band, ordinal) => {
      const s = band.arcLength?.value ?? null;
      const id = segmentIdDigest(laneId, Math.round((s ?? -1) * 10));
      const bandDiags = band.arcLength?.diagnostic ? [band.arcLength.diagnostic] : [];

      if (!cal.monotonic) {
        return {
          id,
          bandId: band.id,
          status: 'invalid',
          mw: null,
          segmentId: null,
          ladderPointIds: cal.points.filter((p) => p.used).map((p) => p.ladderBandId),
          alternatives: [],
          range: null,
          diagnostics: [
            ...bandDiags,
            {
              code: 'NON_MONOTONIC_SCALE',
              severity: 'error',
              message: '标尺非单调，分子量推断被拒绝',
              location: { materialId: band.id, point: band.center }
            }
          ],
          decidedBy: null
        };
      }

      if (s === null) {
        return invalidCandidate(id, band, unit, 'INCOMPLETE_INPUT', '缺少弧长，无法推断');
      }

      const inside = s >= cal.validRegion.s[0] && s <= cal.validRegion.s[1];
      const hit = mwAt(cal, s);
      if (!inside || !hit) {
        return invalidCandidate(id, band, unit, 'RULER_OUTSIDE_VALID_REGION',
          `s=${s.toFixed(1)}px 位于局部标尺有效区域 [${cal.validRegion.s[0]!.toFixed(1)}, ${cal.validRegion.s[1]!.toFixed(1)}] 之外，禁止外推`);
      }

      const alternatives: MwCandidate['alternatives'] = [];
      const siblings = band.overlapGroupId ? groups.get(band.overlapGroupId) ?? [] : [];
      for (const sib of siblings) {
        const ss = sib.arcLength?.value;
        if (ss === null || ss === undefined) continue;
        const h = mwAt(cal, ss);
        if (h) alternatives.push({ mw: dv(h.value, unit, ss), segmentId: h.segmentId, ladderPointIds: h.pointIds });
      }

      let status: MwCandidate['status'] = 'candidate';
      const cands: MwCandidate = {
        id,
        bandId: band.id,
        status,
        mw: dv(hit.value, unit, s),
        segmentId: hit.segmentId,
        ladderPointIds: hit.pointIds,
        alternatives,
        range: null,
        diagnostics: bandDiags,
        decidedBy: null
      };

      if (band.saturated) {
        cands.diagnostics.push({
          code: 'SATURATED_BAND',
          severity: 'warning',
          message: '饱和峰顶迁移位置不可信，仅标记为候选',
          location: { materialId: band.id, point: band.center }
        });
      }
      if (band.smeared) {
        status = 'range';
        cands.status = 'range';
        const lo = mwAt(cal, Math.min(s + band.widthPx / 2, cal.validRegion.s[1]!));
        const hi = mwAt(cal, Math.max(s - band.widthPx / 2, cal.validRegion.s[0]!));
        if (lo && hi) {
          cands.range = { lower: dv(lo.value, unit, s), upper: dv(hi.value, unit, s) };
        }
        cands.diagnostics.push({
          code: 'SMEARED_BAND',
          severity: 'warning',
          message: '拖尾条带只能给出分子量区间',
          location: { materialId: band.id, point: band.center }
        });
      }
      if (siblings.length > 1) {
        cands.status = 'candidate';
        cands.diagnostics.push({
          code: 'OVERLAPPING_BANDS',
          severity: 'warning',
          message: `重叠组 ${band.overlapGroupId}：保留 ${alternatives.length} 个合法候选，等待人工选择`,
          location: { materialId: band.id, point: band.center }
        });
      }
      void ordinal;
      void stableDigest;
      return cands;
    });

  return { laneId, candidates, diagnostics };
}

function invalidCandidate(
  id: string,
  band: BandObservationMaterial,
  unit: DomainValue['unit'],
  code: 'RULER_OUTSIDE_VALID_REGION' | 'INCOMPLETE_INPUT',
  message: string
): MwCandidate {
  return {
    id,
    bandId: band.id,
    status: 'invalid',
    mw: null,
    segmentId: null,
    ladderPointIds: [],
    alternatives: [],
    range: null,
    diagnostics: [{ code, severity: 'error', message, location: { materialId: band.id, point: band.center } }],
    decidedBy: null
  };
}
