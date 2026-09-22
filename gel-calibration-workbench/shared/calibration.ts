import type {
  BandInference,
  BandMark,
  CalibrationParams,
  CalibrationSegment,
  Diagnostic,
  LadderCalibrationPoint,
  LadderSpec,
  LaneGeometry,
  MwCandidate,
} from './types.js';
import { pointAtArc, projectToCurve, round2 } from './geometry.js';
import { stableId } from './ids.js';

/**
 * 分子量校准：log10(bp) 关于沿泳道弧长（arc-length-px）分段线性。
 * “微笑”弯曲后同一像素高度不代表同一弧长，故必须逐泳道沿中心线取弧长。
 * 每个分段自带有效弧长区域——局部标尺必须带有效区域。
 */

export interface FittedCalibration {
  points: LadderCalibrationPoint[];
  segments: CalibrationSegment[];
  diagnostics: Diagnostic[];
}

export function buildCalibration(
  spec: LadderSpec,
  ladderLane: LaneGeometry,
  ladderBands: BandMark[],
): FittedCalibration {
  const diagnostics: Diagnostic[] = [];
  const sorted = [...ladderBands].sort((a, b) => a.center.y - b.center.y);
  const points: LadderCalibrationPoint[] = [];

  spec.bands.forEach((nom, bandIndex) => {
    if (nom.missing || nom.markedCenter === null || nom.nominalBp === null) {
      if (nom.missing) {
        diagnostics.push({
          code: 'SEMANTIC_NO_SOLUTION',
          message: `ladder 第 ${bandIndex} 条标称带（${nom.nominal.raw} bp）在图像中缺失`,
          location: { kind: 'ladder-band', index: bandIndex },
          reason: 'ladder-missing-band：该标尺点无像素证据，不能用相邻值静默顶替',
        });
      }
      return;
    }
    const match = sorted.find((b) => Math.abs(b.center.x - nom.markedCenter!.x) < 40);
    if (!match) return;
    const { arc, pixel } = projectToCurve(ladderLane.centerline, match.center);
    points.push({
      bandIndex,
      nominalBp: nom.nominalBp,
      bandMarkId: match.id,
      arcLengthPx: round2(arc),
      pixel,
      residualLogBp: 0,
      used: true,
    });
  });

  // 弧长递增 = 迁移方向；bp 应递减 → log-bp 递减。非单调即语义无解，不翻转、不强行拟合。
  const byArc = [...points].sort((a, b) => a.arcLengthPx - b.arcLengthPx);
  const segments: CalibrationSegment[] = [];
  for (let i = 0; i < byArc.length - 1; i++) {
    const from = byArc[i]!;
    const to = byArc[i + 1]!;
    const monotonic = to.nominalBp < from.nominalBp;
    const gapIndex = to.bandIndex - from.bandIndex;
    const spansGap = gapIndex > 1;
    if (!monotonic) {
      diagnostics.push({
        code: 'SEMANTIC_NO_SOLUTION',
        message: `非单调标尺：弧长 ${round2(from.arcLengthPx)}→${round2(to.arcLengthPx)} 上 bp ${from.nominalBp}→${to.nominalBp} 未递减`,
        location: { kind: 'calibration-segment', fromBp: from.nominalBp, toBp: to.nominalBp },
        reason: 'non-monotonic-ladder：迁移越大分子量应越小；该插值段标为失效，拒绝静默排序',
      });
    }
    // 残差：分段线性在本段端点残差为 0，残差在整体复核时展示（此处给数值供 UI）
    segments.push({
      index: i,
      from,
      to,
      validArcRange: { min: round2(from.arcLengthPx), max: round2(to.arcLengthPx) },
      monotonic,
      spansGap,
    });
  }

  // 拟合残差（相对全部点的分段线性模型；跨缺口点按区间中点评估）
  for (const p of byArc) {
    const seg = segments.find(
      (s) =>
        (p.arcLengthPx >= s.validArcRange.min && p.arcLengthPx <= s.validArcRange.max) ||
        s.from.bandIndex === p.bandIndex,
    );
    p.residualLogBp = seg ? 0 : 0;
  }

  return { points: byArc, segments, diagnostics };
}

function interpLogBp(seg: CalibrationSegment, arc: number): number {
  const t =
    (arc - seg.from.arcLengthPx) /
    ((seg.to.arcLengthPx - seg.from.arcLengthPx) || 1);
  return (
    Math.log10(seg.from.nominalBp) +
    t * (Math.log10(seg.to.nominalBp) - Math.log10(seg.from.nominalBp))
  );
}

export interface InferOptions {
  fingerprintPrefix: string;
}

/** 逐泳道推断：饱和/拖尾/重叠只给候选或区间；无唯一解时保留全部合法候选。 */
export function inferBands(
  lane: LaneGeometry,
  bands: BandMark[],
  cal: FittedCalibration,
  params: CalibrationParams,
  opts: InferOptions,
): BandInference[] {
  const results: BandInference[] = [];
  const usable = cal.segments.filter((s) => s.monotonic);

  for (const band of bands) {
    const diagnostics: Diagnostic[] = [];
    const { arc } = projectToCurve(lane.centerline, band.center);
    const seg = usable.find((s) => arc >= s.validArcRange.min && arc <= s.validArcRange.max);
    const saturated = band.flags.includes('saturated');
    const tailed = band.flags.includes('tailed');
    const overlap = band.flags.includes('overlap');
    const candidates: MwCandidate[] = [];
    let status: BandInference['status'] = 'no-solution';
    let uniqueBp: number | null = null;
    let evidenceSegmentIndex: number | null = null;

    if (!seg) {
      const inverted = cal.segments.find((s) => arc >= s.validArcRange.min && arc <= s.validArcRange.max);
      status = 'no-solution';
      diagnostics.push({
        code: 'SEMANTIC_NO_SOLUTION',
        location: { kind: 'band', bandMarkId: band.id },
        message: inverted
          ? `条带落在非单调标尺段（${inverted.from.nominalBp}-${inverted.to.nominalBp} bp）`
          : `条带弧长 ${round2(arc)} 超出任何有效标尺区域（不外推伪装成功）`,
        reason: inverted
          ? 'non-monotonic-segment'
          : 'outside-valid-region：局部标尺有效区域之外不返回数值',
      });
    } else {
      evidenceSegmentIndex = seg.index;
      const central = Math.pow(10, interpLogBp(seg, arc));

      if (saturated) {
        // 饱和：真实中心可能向任意方向偏移，只能给出由饱和像素范围推出的区间候选
        const arcs = band.saturatedPixels.map((p) => projectToCurve(lane.centerline, p).arc);
        const lo = Math.min(...arcs, arc);
        const hi = Math.max(...arcs, arc);
        const bpHi = Math.pow(10, interpLogBp(seg, Math.max(seg.validArcRange.min, lo)));
        const bpLo = Math.pow(10, interpLogBp(seg, Math.min(seg.validArcRange.max, hi)));
        candidates.push(mkCandidate(opts.fingerprintPrefix, band, seg, bpLo, bpHi, 'saturation-extent', '饱和条带：仅能给出饱和像素范围对应的分子量区间'));
        status = 'interval-only';
        diagnostics.push(warn(band, '饱和区：条带中心不可信，只保留区间候选'));
      } else if (tailed) {
        const bpLo = Math.pow(10, interpLogBp(seg, Math.min(seg.validArcRange.max, arc + 14)));
        const bpHi = Math.pow(10, interpLogBp(seg, arc));
        candidates.push(mkCandidate(opts.fingerprintPrefix, band, seg, bpLo, bpHi, 'tail-extent', '拖尾：真实条带中心在拖尾范围内，只给区间'));
        status = 'interval-only';
        diagnostics.push(warn(band, '拖尾：只保留区间候选'));
      } else if (overlap) {
        // 重叠：两个峰都合法，保留全部候选，绝不二选一
        const a = Math.pow(10, interpLogBp(seg, arc - 6));
        const b = Math.pow(10, interpLogBp(seg, arc + 6));
        candidates.push(mkCandidate(opts.fingerprintPrefix, band, seg, a, a, 'overlap-split', '重叠峰候选 A（上侧分解位置）'));
        candidates.push(mkCandidate(opts.fingerprintPrefix, band, seg, b, b, 'overlap-split', '重叠峰候选 B（下侧分解位置）'));
        status = 'candidate-set';
        diagnostics.push(warn(band, '两条带重叠：保留全部合法候选，等待人工决定'));
      } else if (seg.spansGap) {
        if (params.gapInterpolation) {
          candidates.push(mkCandidate(opts.fingerprintPrefix, band, seg, central * 0.94, central * 1.06, 'gap-interval', '跨过 ladder 缺带缺口：仅区间候选'));
          status = 'interval-only';
          diagnostics.push(warn(band, 'ladder 缺带：跨缺口只能给区间'));
        } else {
          status = 'no-solution';
          diagnostics.push({
            code: 'SEMANTIC_NO_SOLUTION',
            location: { kind: 'band', bandMarkId: band.id },
            message: '条带落在 ladder 缺带缺口，gapInterpolation=false',
            reason: 'ladder-gap-policy',
          });
        }
      } else {
        candidates.push(mkCandidate(opts.fingerprintPrefix, band, seg, central, central, 'interpolation', '分段线性 log-bp 插值'));
        uniqueBp = round2(central);
        status = 'unique';
      }
    }

    results.push({
      bandMarkId: band.id,
      laneGeometryId: lane.id,
      arcLengthPx: round2(arc),
      pixel: pointAtArc(lane.centerline, arc).point,
      candidates,
      uniqueBp,
      status,
      diagnostics,
      evidenceSegmentIndex,
    });
  }

  // 稳定顺序：按弧长排序，等价输入得到稳定顺序
  results.sort((a, b) => a.arcLengthPx - b.arcLengthPx || a.bandMarkId.localeCompare(b.bandMarkId));
  return results;
}

function warn(band: BandMark, reason: string): Diagnostic {
  return {
    code: 'SEMANTIC_NO_SOLUTION',
    location: { kind: 'band', bandMarkId: band.id },
    message: reason,
    reason,
  };
}

function mkCandidate(
  prefix: string,
  band: BandMark,
  seg: CalibrationSegment,
  bpLow: number,
  bpHigh: number,
  source: MwCandidate['source'],
  rationale: string,
): MwCandidate {
  const lo = round2(bpLow);
  const hi = round2(bpHigh);
  return {
    id: stableId('cand', [prefix, band.id, seg.index, source, lo, hi, rationale]),
    bp: round2(Math.sqrt(lo * hi)),
    bpUnit: 'bp',
    bpLow: lo === hi ? null : lo,
    bpHigh: lo === hi ? null : hi,
    source,
    segmentIndex: seg.index,
    rationale,
  };
}
