import type { BandCandidate, Budget, Diagnostic, MwEstimate, Outcome, ParamSet, Ruler, Source } from '../shared/types';
import { fail, ok, spend } from '../shared/types';
import { mapY } from './calibration';

/**
 * 条带检测：在一维泳道剖面上找峰。
 * - 峰值达到饱和阈值 → saturated，只能给区间（平台范围）；
 * - 两峰间距小于 minPeakSeparationPx 或峰谷不显著 → overlap，保留全部合法候选；
 * - 峰形右拖 → smear，给区间。
 */
export function detectBands(
  profile: Float64Array,
  laneId: string,
  imageId: string,
  params: ParamSet,
  budget: Budget,
): Outcome<BandCandidate[]> {
  const diagnostics: Diagnostic[] = [];
  const n = profile.length;
  let base = 0;
  for (let i = 0; i < n; i++) base += profile[i];
  base /= n;
  const threshold = base + params.peakThreshold;
  const bands: BandCandidate[] = [];
  let i = 1;
  let idx = 0;
  while (i < n - 1) {
    if (!spend(budget)) return fail('budget_exhausted', [{ code: 'BUDGET', severity: 'error', message: '条带检测预算耗尽', position: { laneId } }]);
    if (profile[i] >= threshold && profile[i] >= profile[i - 1] && profile[i] >= profile[i + 1]) {
      // 找峰平台/范围
      let lo = i, hi = i;
      while (lo > 0 && profile[lo - 1] > base + params.peakThreshold * 0.4) lo--;
      while (hi < n - 1 && profile[hi + 1] > base + params.peakThreshold * 0.4) hi++;
      // 质心
      let num = 0, den = 0;
      for (let j = lo; j <= hi; j++) { const wgt = profile[j] - base; num += j * wgt; den += wgt; }
      const center = den > 0 ? num / den : i;
      const peak = profile[i];
      const saturated = peak >= params.saturationValue;
      // 拖尾：右半宽明显大于左半宽
      const leftW = center - lo, rightW = hi - center;
      const smear = rightW > leftW * 2.2 && rightW > 6;
      const source: Source = { kind: 'interval', imageId, axis: 'y', lo, hi };
      if (saturated) {
        diagnostics.push({ code: 'BAND_SATURATED', severity: 'warning', message: `泳道 ${laneId} y≈${center.toFixed(1)}px 条带饱和，仅可作候选/区间`, position: { y: center, laneId } });
        bands.push({ id: `band_${laneId}_${idx++}`, laneId, centerPx: center, kind: 'saturated', intervalPx: [lo, hi], source });
      } else if (smear) {
        diagnostics.push({ code: 'BAND_SMEAR', severity: 'warning', message: `泳道 ${laneId} y≈${center.toFixed(1)}px 条带拖尾，仅可作候选/区间`, position: { y: center, laneId } });
        bands.push({ id: `band_${laneId}_${idx++}`, laneId, centerPx: center, kind: 'smear', intervalPx: [lo, hi], source });
      } else {
        bands.push({ id: `band_${laneId}_${idx++}`, laneId, centerPx: center, kind: 'point', source });
      }
      i = hi + 1;
    } else i++;
  }
  // 重叠检测：相邻带中心过近 → 合并为 overlap，保留全部候选
  const merged: BandCandidate[] = [];
  for (let k = 0; k < bands.length; k++) {
    const cur = bands[k];
    const nxt = bands[k + 1];
    if (nxt && nxt.centerPx - cur.centerPx < params.minPeakSeparationPx && cur.kind === 'point' && nxt.kind === 'point') {
      const lo = cur.intervalPx?.[0] ?? cur.centerPx - 2;
      const hi = nxt.intervalPx?.[1] ?? nxt.centerPx + 2;
      diagnostics.push({
        code: 'BAND_OVERLAP',
        severity: 'warning',
        message: `泳道 ${laneId} y≈${cur.centerPx.toFixed(1)}/${nxt.centerPx.toFixed(1)}px 两条带重叠，保留全部合法候选`,
        position: { y: (cur.centerPx + nxt.centerPx) / 2, laneId },
      });
      merged.push({
        id: `band_${laneId}_${idx++}`,
        laneId,
        centerPx: (cur.centerPx + nxt.centerPx) / 2,
        kind: 'overlap',
        intervalPx: [lo, hi],
        alternativesPx: [cur.centerPx, nxt.centerPx],
        source: { kind: 'interval', imageId, axis: 'y', lo, hi },
      });
      k++;
    } else merged.push(cur);
  }
  return ok(merged, diagnostics);
}

/** 分子量推断：点估计 / 区间 / 多候选 / 不可判定。 */
export function inferMw(band: BandCandidate, ruler: Ruler, params: ParamSet): { estimate: MwEstimate; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = [];
  if (band.kind === 'saturated' || band.kind === 'smear') {
    const [lo, hi] = band.intervalPx!;
    const hiLog = mapY(ruler, lo, params).logSize; // 小 y = 大分子
    const loLog = mapY(ruler, hi, params).logSize;
    return {
      estimate: { kind: 'interval', loBp: Math.round(10 ** loLog), hiBp: Math.round(10 ** hiLog), reason: band.kind === 'saturated' ? 'saturated' : 'smear' },
      diagnostics: [{ code: 'MW_INTERVAL_ONLY', severity: 'info', message: `条带 ${band.id} 为${band.kind === 'saturated' ? '饱和' : '拖尾'}带，只能给分子量区间`, position: { y: band.centerPx, laneId: band.laneId } }],
    };
  }
  if (band.kind === 'overlap') {
    const options = (band.alternativesPx ?? [band.centerPx]).map((y) => {
      const m = mapY(ruler, y, params);
      return { sizeBp: Math.round(10 ** m.logSize), segmentId: m.segmentId ?? 'edge' };
    });
    return {
      estimate: { kind: 'candidates', options, reason: 'overlap' },
      diagnostics: [{ code: 'MW_AMBIGUOUS', severity: 'info', message: `条带 ${band.id} 重叠，保留 ${options.length} 个合法候选`, position: { y: band.centerPx, laneId: band.laneId } }],
    };
  }
  const m = mapY(ruler, band.centerPx, params);
  if (!m.within) {
    return {
      estimate: { kind: 'interval', loBp: Math.round(10 ** (m.logSize - 0.15)), hiBp: Math.round(10 ** (m.logSize + 0.15)), reason: 'out-of-range' },
      diagnostics: [{
        code: 'MW_OUT_OF_RANGE',
        severity: 'warning',
        message: `条带 ${band.id} y=${band.centerPx.toFixed(1)}px 超出标尺有效区域 [${ruler.validY.yMin}, ${ruler.validY.yMax}]px，只能给区间`,
        position: { y: band.centerPx, laneId: band.laneId, segmentId: m.segmentId ?? undefined },
      }],
    };
  }
  if (m.gap)
    diagnostics.push({ code: 'MW_GAP_SEGMENT', severity: 'warning', message: `条带 ${band.id} 落在缺带插值段 ${m.segmentId}，结果降级`, position: { y: band.centerPx, laneId: band.laneId, segmentId: m.segmentId ?? undefined } });
  return { estimate: { kind: 'value', sizeBp: Math.round(10 ** m.logSize), logSize: m.logSize, segmentId: m.segmentId!, within: true }, diagnostics };
}
