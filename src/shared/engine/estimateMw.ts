// 分子量推断：仅在有效段内做插值；越界/失效段/非单调不允许外推。
// 饱和、拖尾 → 候选；重叠 → 区间 + 全部合法候选（保留无法唯一决定时的候选集）。
import { D, diag } from '../diagnostics.js';
import { inValidRegion } from '../geometry.js';
import { RULE_VERSIONS } from '../versions.js';
import { stableId } from '../ids.js';
import type {
  Band,
  Calibration,
  Diagnostic,
  MolecularWeightEstimate,
  MolecularWeightValue,
  ValidRegion,
} from '../types.js';

interface EstimateBandInput {
  band: Band;
  calibration: Calibration;
  s: number;
  centerX: number;
  unit: 'bp' | 'kDa';
  derivationId: string;
}

function interpolate(segSides: { s: number; logM: number }[], s: number): number | undefined {
  for (let i = 0; i < segSides.length - 1; i++) {
    const a = segSides[i]!;
    const b = segSides[i + 1]!;
    if (s >= a.s - 1e-6 && s <= b.s + 1e-6) {
      const t = (s - a.s) / (b.s - a.s || 1);
      return a.logM + t * (b.logM - a.logM);
    }
  }
  return undefined;
}

export function estimateBandMw(input: EstimateBandInput): {
  estimate: MolecularWeightEstimate;
  diagnostics: Diagnostic[];
} {
  const diagnostics: Diagnostic[] = [];
  const { band, calibration, s, centerX, unit } = input;
  const id = stableId('mw', band.id, calibration.id, calibration.paramsVersion);
  const candidates: MolecularWeightValue[] = [];
  const reasonCodes: string[] = [];

  for (const seg of calibration.segments) {
    if (!seg.valid) continue;
    if (!inValidRegion(seg.validRegion, s, centerX)) continue;
    const t = (s - seg.sA) / (seg.sB - seg.sA || 1);
    if (t < -1e-6 || t > 1 + 1e-6) continue;
    const logM = seg.logMA + t * (seg.logMB - seg.logMA);
    const value: MolecularWeightValue = {
      value: Number((10 ** logM).toFixed(3)),
      unit,
      sPx: Number(s.toFixed(2)),
      segmentId: seg.id,
      validRegion: seg.validRegion,
      confidence: 'high',
      derivationId: input.derivationId,
    };
    candidates.push(value);
  }

  let status: MolecularWeightEstimate['status'] = 'unique';

  if (candidates.length === 0) {
    const inInvalid = calibration.segments.some(
      (seg) => !seg.valid && s >= seg.sA - 1e-6 && s <= seg.sB + 1e-6,
    );
    reasonCodes.push(inInvalid ? D.CALIBRATION_SEGMENT_NONMONOTONIC : D.BAND_OUTSIDE_VALID_REGION);
    diagnostics.push(
      diag(
        inInvalid ? D.CALIBRATION_SEGMENT_NONMONOTONIC : D.BAND_OUTSIDE_VALID_REGION,
        inInvalid ? 'error' : 'warning',
        inInvalid
          ? `带 ${band.id} 落在非单调/失效标尺段内，禁止给出分子量`
          : `带 ${band.id} 的迁移距离 ${s.toFixed(1)}px 位于全部有效段之外，不外推`,
        `/bands/${band.id}`,
        { subjectId: band.id },
      ),
    );
    status = 'unresolved';
  }

  // 饱和 / 拖尾：降级为候选
  if (band.saturated) {
    reasonCodes.push(D.BAND_SATURATED);
    for (const c of candidates) c.confidence = 'candidate';
    status = candidates.length ? 'ambiguous' : status;
  }
  if (band.tailingAsymmetry >= 1.6) {
    reasonCodes.push(D.BAND_TAILING);
    for (const c of candidates) c.confidence = 'candidate';
    if (status === 'unique') status = candidates.length ? 'ambiguous' : status;
  }

  // 重叠：以 s ± 半宽作为区间；保留所有合法候选
  if (band.overlapGroupId) {
    reasonCodes.push(D.BANDS_OVERLAP);
    for (const c of candidates) c.confidence = 'candidate';
    const lo = s - band.halfWidthPx;
    const hi = s + band.halfWidthPx;
    const segSides = candidates.map((c) => ({ s: c.sPx, logM: Math.log10(c.value) }));
    // 用所属段外扩区间
    const seg = calibration.segments.find((g) => g.id === candidates[0]?.segmentId);
    let interval: MolecularWeightEstimate['interval'];
    if (seg && seg.valid) {
      const sLo = Math.max(seg.sA, lo);
      const sHi = Math.min(seg.sB, hi);
      const tLo = (sLo - seg.sA) / (seg.sB - seg.sA || 1);
      const tHi = (sHi - seg.sA) / (seg.sB - seg.sA || 1);
      interval = {
        low: {
          value: Number((10 ** (seg.logMA + tHi * (seg.logMB - seg.logMA))).toFixed(3)),
          unit,
          sPx: Number(sLo.toFixed(2)),
          segmentId: seg.id,
          validRegion: seg.validRegion,
          confidence: 'candidate',
          derivationId: input.derivationId,
        },
        high: {
          value: Number((10 ** (seg.logMA + tLo * (seg.logMB - seg.logMA))).toFixed(3)),
          unit,
          sPx: Number(sHi.toFixed(2)),
          segmentId: seg.id,
          validRegion: seg.validRegion,
          confidence: 'candidate',
          derivationId: input.derivationId,
        },
      };
    }
    void segSides;
    const estimate: MolecularWeightEstimate = {
      id,
      bandId: band.id,
      laneId: band.laneId,
      calibrationId: calibration.id,
      segmentId: candidates[0]?.segmentId,
      primary: candidates[0],
      interval,
      candidates,
      status: candidates.length ? 'interval' : 'unresolved',
      reasonCodes,
      paramsVersion: calibration.paramsVersion,
      ruleVersion: RULE_VERSIONS.mw,
    };
    return { estimate, diagnostics };
  }

  if (candidates.length > 1) status = 'ambiguous';

  const estimate: MolecularWeightEstimate = {
    id,
    bandId: band.id,
    laneId: band.laneId,
    calibrationId: calibration.id,
    segmentId: candidates[0]?.segmentId,
    primary: status === 'unique' ? candidates[0] : candidates[0],
    candidates,
    status: candidates.length ? status : 'unresolved',
    reasonCodes,
    paramsVersion: calibration.paramsVersion,
    ruleVersion: RULE_VERSIONS.mw,
  };
  return { estimate, diagnostics };
}

export function isValidRegionOnly(vr: ValidRegion): string {
  return `${vr.frame}:s[${vr.sStart.toFixed(1)},${vr.sEnd.toFixed(1)}]px`;
}
