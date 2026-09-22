import type { ParamSet, ProfileSample, AutoPeak, PixelSpan, Diagnostic } from '../shared/types.js';
import { contentId } from '../shared/digest.js';

// 暗带：值越小越强。转换为“带强度” score = 255 - intensity。
// 简单稳健的峰检测：局部极大 + prominence，返回 s、宽度、饱和、拖尾与重叠分组。
export function detectAutoPeaks(
  laneId: string,
  profile: ProfileSample[],
  params: ParamSet,
): { peaks: AutoPeak[]; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = [];
  const score = profile.map((p) => ({ s: p.s, v: 255 - p.intensity, sat: p.saturated }));
  const peaksRaw: { idx: number; s: number; v: number; width: number; prominence: number; saturated: boolean; tail: boolean }[] = [];

  for (let i = 2; i < score.length - 2; i++) {
    if (!(score[i].v > score[i - 1].v && score[i].v >= score[i + 1].v)) continue;
    // prominence
    let left = i - 1;
    while (left > 0 && score[left].v >= score[i].v) left--;
    let right = i + 1;
    while (right < score.length - 1 && score[right].v >= score[i].v) right++;
    const base = Math.min(
      left >= 0 ? score[left].v : score[i].v,
      right < score.length ? score[right].v : score[i].v,
    );
    const prominence = score[i].v - base;
    if (prominanceBelow(prominence, params.bandPeakProminence)) continue;
    // width at half prominence
    const half = base + prominence / 2;
    let l = i; while (l > 0 && score[l].v > half) l--;
    let r = i; while (r < score.length - 1 && score[r].v > half) r++;
    const width = score[r].s - score[l].s;
    if (width > params.bandHalfWidthMax * 2 + 4) {
      // 过宽：拖尾候选，不丢弃
      peaksRaw.push({ idx: i, s: score[i].s, v: score[i].v, width, prominence, saturated: false, tail: true });
      continue;
    }
    const saturated = score[i].sat;
    peaksRaw.push({ idx: i, s: score[i].s, v: score[i].v, width, prominence, saturated, tail: false });
  }

  // 重叠分组：相邻峰中心间距小于阈值 => 共享 overlapGroup，中心给区间
  const groupOf: Record<number, string> = {};
  for (let i = 0; i < peaksRaw.length; i++) {
    for (let j = i + 1; j < peaksRaw.length; j++) {
      if (Math.abs(peaksRaw[j].s - peaksRaw[i].s) < params.overlapSeparationMin + 6) {
        const g = groupOf[i] ?? `ov_${laneId}_${i}_${j}`;
        groupOf[i] = g; groupOf[j] = g;
      }
    }
  }

  const peaks: AutoPeak[] = peaksRaw.map((p, i) => {
    const overlapGroup = groupOf[i];
    const sSpan: PixelSpan | undefined = (p.saturated || p.tail || overlapGroup)
      ? { from: p.s - p.width / 2, to: p.s + p.width / 2, axis: 's' }
      : undefined;
    return {
      bandCandidateId: contentId('auto-peak', [laneId, p.s.toFixed(2), params.version]),
      s: Number(p.s.toFixed(2)),
      sSpan,
      prominence: Number(p.prominence.toFixed(2)),
      width: Number(p.width.toFixed(2)),
      saturated: p.saturated,
      tailed: p.tail,
      overlapGroup,
    };
  });

  peaks.forEach((pk) => {
    if (pk.overlapGroup) diagnostics.push({ code: 'OVERLAP_CANDIDATES', path: `lane:${laneId}`, message: `s=${pk.s} 存在重叠峰，仅能给区间/多候选`, detail: { group: pk.overlapGroup } });
    if (pk.saturated) diagnostics.push({ code: 'SATURATED_CANDIDATE', path: `lane:${laneId}`, message: `s=${pk.s} 像素饱和，中心不可唯一确定`, detail: { span: pk.sSpan } });
    if (pk.tailed) diagnostics.push({ code: 'TAIL_CANDIDATE', path: `lane:${laneId}`, message: `s=${pk.s} 拖尾，标记为候选`, detail: { width: pk.width } });
  });
  return { peaks, diagnostics };
}

function prominanceBelow(value: number, threshold: number): boolean {
  return value < threshold;
}
