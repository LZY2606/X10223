import type {
  AutoPeak, BandAnnotation, BandMwResult, CalibrationResult,
  Diagnostic, MwCandidate,
} from '../shared/types.js';
import { interpBp } from './calibration.js';
import { contentId } from '../shared/digest.js';

export interface BandMwInput {
  band: BandAnnotation;
  s: number;
  saturated: boolean;
  tailed: boolean;
  autoPeaks: AutoPeak[];
  calibration: CalibrationResult;
}

function bpAt(cal: CalibrationResult, s: number) {
  return interpBp(cal, s);
}

function statusFrom(diags: Diagnostic[]): BandMwResult['status'] {
  if (diags.some((d) => d.code === 'SEMANTIC_NO_SOLUTION')) return 'no-solution';
  if (diags.some((d) => d.code === 'OUT_OF_VALID_REGION')) return 'invalid';
  if (diags.some((d) => d.code === 'BUDGET_EXHAUSTED')) return 'budget-exhausted';
  if (diags.length) return 'candidate';
  return 'ok';
}

export function inferBandMw(input: BandMwInput): BandMwResult {
  const { band, s, saturated, tailed, autoPeaks, calibration } = input;
  const diags: Diagnostic[] = [];
  const candidates: MwCandidate[] = [];

  if (!calibration.monotonic || calibration.segments.length === 0) {
    diags.push({ code: 'SEMANTIC_NO_SOLUTION', materialId: band.id, message: '标尺非单调，无法唯一推断分子量' });
    return { bandId: band.id, laneId: band.laneId, s, sUnit: 'px-arc', status: 'no-solution', candidates, diagnostics: diags };
  }

  const overlapPeaks = autoPeaks.filter((p) => p.overlapGroup);
  const groups = new Map<string, AutoPeak[]>();
  for (const p of overlapPeaks) {
    const arr = groups.get(p.overlapGroup!) ?? [];
    arr.push(p); groups.set(p.overlapGroup!, arr);
  }
  const myGroup = [...groups.values()].find((grp) => grp.some((p) => Math.abs(p.s - s) <= 8));

  const pushBp = (kind: MwCandidate['kind'], sv: number, idKey: string) => {
    const r = bpAt(calibration, sv);
    candidates.push({
      candidateId: contentId('mwc', [band.id, idKey, sv.toFixed(2)]),
      bp: r.bp, s: Number(sv.toFixed(2)), segmentId: r.segmentId, kind,
    });
    if (!r.bp) diags.push({ code: 'OUT_OF_VALID_REGION', materialId: band.id, message: r.reason ?? '超出有效区', detail: { s: sv } });
    return r;
  };

  if (myGroup) {
    // 两条带重叠：无法唯一决定 -> 保留全部合法候选（每个峰一个），并给区间
    const ss = myGroup.map((p) => p.s).sort((a, b) => a - b);
    const points = myGroup.map((p, idx) => pushBp(idx === 0 ? 'overlap-a' : 'overlap-b', p.s, `ov${idx}`));
    const bps = points.map((r) => r.bp).filter((v): v is number => v !== null);
    if (bps.length) candidates.forEach((c) => { if (bps.length >= 2) c.bpRange = { low: Math.min(...bps), high: Math.max(...bps) }; });
    diags.push({ code: 'OVERLAP_CANDIDATES', materialId: band.id, message: '重叠条带：保留全部合法候选与分子量区间', detail: { sCandidates: ss } });
  } else if (saturated) {
    const r = pushBp('saturated', s, 'sat-center');
    if (r.bp !== null) candidates[0].bpRange = { low: Math.round(r.bp * 0.92), high: Math.round(r.bp * 1.08) };
    diags.push({ code: 'SATURATED_CANDIDATE', materialId: band.id, message: '饱和条带：中心不唯一，仅候选+±8% 区间' });
  } else if (tailed) {
    const r = pushBp('tail', s, 'tail-center');
    if (r.bp !== null) candidates[0].bpRange = { low: Math.round(r.bp * 0.95), high: Math.round(r.bp * 1.05) };
    diags.push({ code: 'TAIL_CANDIDATE', materialId: band.id, message: '拖尾条带：仅候选+±5% 区间' });
  } else {
    pushBp('unique', s, 'center');
  }

  // 自动候选 vs 人工中心
  const nearestAuto = autoPeaks
    .filter((p) => !p.overlapGroup)
    .map((p) => ({ p, d: Math.abs(p.s - s) }))
    .filter((x) => x.d <= 10)
    .sort((a, b) => a.d - b.d)[0];
  let autoMatched: BandMwResult['autoMatched'];
  if (nearestAuto) {
    const auto = bpAt(calibration, nearestAuto.p.s);
    const manualBp = candidates.find((c) => c.kind === 'unique')?.bp ?? null;
    autoMatched = {
      peakS: nearestAuto.p.s,
      bp: auto.bp,
      deltaBpVsManual: manualBp !== null && auto.bp !== null ? Number((auto.bp - manualBp).toFixed(1)) : null,
    };
  }

  return {
    bandId: band.id, laneId: band.laneId, s: Number(s.toFixed(2)), sUnit: 'px-arc',
    status: statusFrom(diags), candidates, diagnostics: diags, autoMatched,
  };
}
