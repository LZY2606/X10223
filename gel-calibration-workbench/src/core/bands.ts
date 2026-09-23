import type { BandCenter, Diagnostic, ParamSet } from '../shared/types';

export interface BandAssessment {
  band: BandCenter;
  // 点估计是否可信：饱和 / 重叠 / 拖尾时只能作为候选或区间
  pointReliable: boolean;
  intervalHalfWidthPx: number; // 区间半宽（px, image-pixel 纵向）
  reasons: string[]; // SATURATED_BAND / OVERLAP_UNRESOLVED / TAILING_SMEAR
  candidates: { candidateId: string; note: string }[];
  diagnostics: Diagnostic[];
}

// 条带证据分级：干净条带给点候选；饱和、拖尾、重叠只给候选或区间。
export function assessBands(
  bands: BandCenter[],
  params: ParamSet,
): { assessments: BandAssessment[]; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = [];
  const sorted = [...bands].sort(
    (a, b) => a.laneId.localeCompare(b.laneId) || a.position.y - b.position.y || a.id.localeCompare(b.id),
  );
  const assessments: BandAssessment[] = [];

  for (const band of sorted) {
    const reasons: string[] = [];
    const candidates: { candidateId: string; note: string }[] = [];
    let intervalHalfWidthPx = 0;

    const saturated =
      band.flags.includes('saturated') || band.intensity >= params.saturationThreshold;
    if (saturated) {
      reasons.push('SATURATED_BAND');
      intervalHalfWidthPx = Math.max(intervalHalfWidthPx, band.halfWidthPx);
      diagnostics.push({
        code: 'SATURATED_BAND',
        severity: 'warning',
        location: { entity: 'bandCenter', id: band.id, point: band.position },
        message: `条带 ${band.id} 强度 ${band.intensity.toFixed(2)} 达到饱和阈值 ${params.saturationThreshold}，质心不可信，只能给区间`,
      });
    }

    if (band.flags.includes('tailing')) {
      reasons.push('TAILING_SMEAR');
      intervalHalfWidthPx = Math.max(intervalHalfWidthPx, band.halfWidthPx * 1.5);
      diagnostics.push({
        code: 'TAILING_SMEAR',
        severity: 'warning',
        location: { entity: 'bandCenter', id: band.id, point: band.position },
        message: `条带 ${band.id} 存在拖尾，质心偏向只能给区间`,
      });
    }

    assessments.push({
      band,
      pointReliable: reasons.length === 0,
      intervalHalfWidthPx,
      reasons,
      candidates,
      diagnostics: [],
    });
  }

  // 重叠检测：同泳道内间距小于分辨极限的条带两两成组，保留全部合法候选。
  const byLane = new Map<string, BandAssessment[]>();
  for (const a of assessments) {
    const list = byLane.get(a.band.laneId) ?? [];
    list.push(a);
    byLane.set(a.band.laneId, list);
  }
  for (const [laneId, list] of [...byLane.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const bi = list[i].band;
        const bj = list[j].band;
        const sep = Math.abs(bi.position.y - bj.position.y);
        const limit = Math.max(params.overlapResolutionPx, (bi.halfWidthPx + bj.halfWidthPx) / 2);
        const flagged = bi.flags.includes('overlap') || bj.flags.includes('overlap');
        if (sep < limit || flagged) {
          for (const [self, other] of [
            [list[i], list[j]],
            [list[j], list[i]],
          ] as const) {
            if (!self.reasons.includes('OVERLAP_UNRESOLVED')) self.reasons.push('OVERLAP_UNRESOLVED');
            self.pointReliable = false;
            self.intervalHalfWidthPx = Math.max(
              self.intervalHalfWidthPx,
              sep / 2 + self.band.halfWidthPx,
            );
            self.candidates.push({
              candidateId: `${self.band.id}~distinct`,
              note: `与 ${other.band.id} 为两条独立带（间距 ${sep.toFixed(1)} px < 分辨极限 ${limit.toFixed(1)} px）`,
            });
            self.candidates.push({
              candidateId: `${self.band.id}~merged:${other.band.id}`,
              note: `与 ${other.band.id} 实为一条带的边缘`,
            });
          }
          diagnostics.push({
            code: 'OVERLAP_UNRESOLVED',
            severity: 'warning',
            location: { entity: 'bandCenter', id: bi.id, point: bi.position },
            message: `泳道 ${laneId} 中 ${bi.id} 与 ${bj.id} 间距 ${sep.toFixed(1)} px 小于分辨极限，保留全部合法候选`,
          });
        }
      }
    }
  }

  return { assessments, diagnostics };
}
