import { diag, type Diagnostic, IMAGE_BASIS } from './units.ts';
import {
  JUDGEMENT,
  type BandCenter,
  type Judgement,
  type LaneBoundary,
  type Outcome,
  type ParamSet,
} from './types.ts';

/** Lane geometry with a quadratic "smile" model: apparent y of a band at
 *  the same molecular weight differs per lane, so the same image height is
 *  NOT the same molecular weight. Each lane gets a local ruler that must
 *  carry its valid region. */
export interface LaneCurve {
  lane_index: number;
  role: 'ladder' | 'sample';
  x_center: number;
  /** vertical smile offset in px at this lane's center: y_corr = y - offset */
  smile_offset_px: number;
  polyline: { x: number; y: number }[];
}

export interface RulerPoint {
  y_corr: number;
  log10_size: number;
  size_bp: number;
  ladder_point_id: string;
}

export interface RulerSegment {
  index: number;
  y0: number;
  y1: number;
  slope: number;
  intercept: number;
  /** true when a nominal ladder band is missing inside this segment */
  gap: boolean;
  point_ids: [string, string];
}

export interface LocalRuler {
  lane_index: number;
  /** smile offset (px) applied to convert apparent y into corrected y */
  smile_offset_px: number;
  points: RulerPoint[];
  segments: RulerSegment[];
  valid_region: { y_min: number; y_max: number; unit: 'px'; basis: typeof IMAGE_BASIS };
  residuals: { ladder_point_id: string; residual_px: number }[];
}

export function smileOffset(smileK: number, xCenter: number, xMid: number): number {
  return smileK * (xCenter - xMid) * (xCenter - xMid);
}

export function buildLaneCurves(
  lanes: LaneBoundary[],
  smileK: number,
  imageWidth: number,
  imageHeight: number,
): LaneCurve[] {
  const xMid = imageWidth / 2;
  return lanes.map((lane) => {
    const xCenter = (lane.x0 + lane.x1) / 2;
    const offset = smileOffset(smileK, xCenter, xMid);
    const polyline: { x: number; y: number }[] = [];
    for (let y = 0; y <= imageHeight; y += 12) {
      // centerline bends horizontally with the smile: bands at corrected
      // height y appear at apparent y + offset
      polyline.push({ x: xCenter, y });
    }
    return {
      lane_index: lane.lane_index,
      role: lane.role,
      x_center: xCenter,
      smile_offset_px: offset,
      polyline,
    };
  });
}

export interface RulerInput {
  lane: LaneCurve;
  /** smile offset (px) of the ladder lane itself, used to bring ladder
   *  points into the true frame before shifting into this lane's frame */
  ladderLaneOffsetPx: number;
  ladderPoints: { y: number; size_bp: number; id: string }[];
  nominalSizesBp: number[];
  params: ParamSet;
}

export type RulerOutcome =
  | { outcome: { kind: 'ok' }; ruler: LocalRuler; judgements: Judgement[] }
  | { outcome: Exclude<Outcome, { kind: 'ok' }>; ruler?: never; judgements: Judgement[] };

/** Build the local log-linear ruler for one lane. A non-monotonic ladder
 *  is semantically unsolvable — a distinct outcome, not an exception. */
export function buildLocalRuler(input: RulerInput): RulerOutcome {
  const { lane, ladderLaneOffsetPx, ladderPoints, nominalSizesBp, params } = input;
  const judgements: Judgement[] = [];
  const diagnostics: Diagnostic[] = [];

  if (Math.abs(lane.smile_offset_px) > 0.5) {
    judgements.push({
      code: JUDGEMENT.SMILE_LOCAL_RULER_REQUIRED,
      subject: `lane[${lane.lane_index}]`,
      detail:
        '“微笑”弯曲使同一高度不等于同一分子量，局部标尺必须带有效区域',
      affected: [`lane:${lane.lane_index}`],
    });
  }

  if (ladderPoints.length < 2) {
    diagnostics.push(
      diag(`lanes[${lane.lane_index}].ladder`, 'LADDER_TOO_SPARSE',
        `need at least 2 ladder band centers, got ${ladderPoints.length}`),
    );
    return { outcome: { kind: 'semantically_unsolvable', diagnostics }, judgements };
  }

  const sorted = [...ladderPoints].sort((a, b) => a.y - b.y);
  // ladder apparent y -> true frame (subtract ladder lane offset) ->
  // this lane's apparent frame (add this lane's offset)
  const points: RulerPoint[] = sorted.map((p) => ({
    y_corr: p.y - ladderLaneOffsetPx + lane.smile_offset_px,
    log10_size: Math.log10(p.size_bp),
    size_bp: p.size_bp,
    ladder_point_id: p.id,
  }));

  // Monotonicity: corrected y must strictly increase as size decreases.
  for (let i = 1; i < points.length; i++) {
    if (!(points[i].y_corr > points[i - 1].y_corr) || !(points[i].log10_size < points[i - 1].log10_size)) {
      diagnostics.push(
        diag(`lanes[${lane.lane_index}].ladder[${i}]`, 'RULER_NON_MONOTONIC',
          `ladder not monotonic at ${points[i].ladder_point_id}: y_corr=${points[i].y_corr}, size=${points[i].size_bp}bp`),
      );
      return { outcome: { kind: 'semantically_unsolvable', diagnostics }, judgements };
    }
  }

  // Missing nominal bands mark the enclosing segment as a gap.
  const present = new Set(sorted.map((p) => p.size_bp));
  const missing = nominalSizesBp.filter((s) => !present.has(s));

  const segments: RulerSegment[] = [];
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i];
    const b = points[i + 1];
    const slope = (b.log10_size - a.log10_size) / (b.y_corr - a.y_corr);
    const gap = missing.some((m) => m < a.size_bp && m > b.size_bp);
    segments.push({
      index: i,
      y0: a.y_corr,
      y1: b.y_corr,
      slope,
      intercept: a.log10_size - slope * a.y_corr,
      gap,
      point_ids: [a.ladder_point_id, b.ladder_point_id],
    });
    if (gap) {
      judgements.push({
        code: JUDGEMENT.LADDER_GAP_INTERVAL,
        subject: `lane[${lane.lane_index}].segment[${i}]`,
        detail: 'ladder 缺带：该插值段只能给出区间估计',
        affected: [`lane:${lane.lane_index}`, `segment:${i}`],
      });
    }
  }

  const margin = params.valid_region_margin_px;
  const valid_region = {
    y_min: points[0].y_corr - margin,
    y_max: points[points.length - 1].y_corr + margin,
    unit: 'px' as const,
    basis: IMAGE_BASIS,
  };

  // Residuals of the piecewise fit at the ladder points themselves (0 at
  // knots by construction; reported so the review page can overlay them).
  const residuals = points.map((p) => ({ ladder_point_id: p.ladder_point_id, residual_px: 0 }));

  return {
    outcome: { kind: 'ok' },
    ruler: { lane_index: lane.lane_index, smile_offset_px: lane.smile_offset_px, points, segments, valid_region, residuals },
    judgements,
  };
}

export type BandFlag = 'saturated' | 'tailing' | 'overlap';

export interface MwEstimate {
  band_id: string;
  lane_index: number;
  status: 'ok' | 'candidate' | 'interval' | 'invalid';
  y_corr: number;
  /** point estimate only when status === 'ok' */
  mw_bp?: number;
  /** interval estimates for candidate/interval statuses; all legal
   *  candidates are preserved when no unique decision is possible */
  interval_bp?: [number, number];
  candidates_bp?: number[];
  segment_index?: number;
  ladder_point_ids?: [string, string];
  flags: BandFlag[];
  reason?: string;
  unit: 'bp';
}

export interface InferInput {
  band: BandCenter;
  ruler: LocalRuler;
  params: ParamSet;
  saturated: boolean;
  tailing: boolean;
  overlapGroup: BandCenter[];
}

export function inferMw(input: InferInput): { estimate: MwEstimate; judgements: Judgement[] } {
  const { band, ruler, params, saturated, tailing, overlapGroup } = input;
  const judgements: Judgement[] = [];
  const yCorr = band.y; // apparent y in this lane's own frame, matching the local ruler
  const flags: BandFlag[] = [];
  if (saturated) flags.push('saturated');
  if (tailing) flags.push('tailing');
  if (overlapGroup.length > 1) flags.push('overlap');

  const base: MwEstimate = {
    band_id: band.band_id,
    lane_index: band.lane_index,
    status: 'ok',
    y_corr: yCorr,
    flags,
    unit: 'bp',
  };

  const region = ruler.valid_region;
  if (yCorr < region.y_min || yCorr > region.y_max) {
    judgements.push({
      code: JUDGEMENT.OUTSIDE_VALID_REGION,
      subject: band.band_id,
      detail: `y_corr=${yCorr.toFixed(1)}px 超出有效区域 [${region.y_min.toFixed(1)}, ${region.y_max.toFixed(1)}]px`,
      affected: [band.band_id],
    });
    return {
      estimate: { ...base, status: 'invalid', reason: 'outside_valid_region' },
      judgements,
    };
  }

  const seg = ruler.segments.find((s) => yCorr >= s.y0 && yCorr <= s.y1);
  if (!seg) {
    return { estimate: { ...base, status: 'invalid', reason: 'no_interpolation_segment' }, judgements };
  }

  const log10size = seg.slope * yCorr + seg.intercept;
  const mw = Math.pow(10, log10size);
  const segLenLog = Math.abs(seg.slope) * (seg.y1 - seg.y0);
  const estimate: MwEstimate = {
    ...base,
    segment_index: seg.index,
    ladder_point_ids: seg.point_ids,
  };

  // Saturated / tailing / overlapping bands may only ever be reported as
  // candidates or intervals — never as accepted point estimates.
  if (saturated || tailing || overlapGroup.length > 1) {
    const spread = overlapGroup.length > 1
      ? overlapGroup.map((b) => Math.pow(10, seg.slope * b.y + seg.intercept))
      : [mw * 0.9, mw * 1.1];
    const lo = Math.min(...spread);
    const hi = Math.max(...spread);
    estimate.status = overlapGroup.length > 1 ? 'interval' : 'candidate';
    estimate.interval_bp = [lo, hi];
    estimate.candidates_bp = [...spread].sort((a, b) => a - b);
    estimate.reason = flags.join('+');
    for (const f of flags) {
      const code =
        f === 'saturated' ? JUDGEMENT.SATURATED_CANDIDATE_ONLY
        : f === 'tailing' ? JUDGEMENT.TAILING_CANDIDATE_ONLY
        : JUDGEMENT.OVERLAP_INTERVAL_ONLY;
      judgements.push({
        code,
        subject: band.band_id,
        detail: '饱和条带、拖尾和重叠只能标为候选或区间',
        affected: [band.band_id, ...overlapGroup.map((b) => b.band_id)],
      });
    }
    return { estimate, judgements };
  }

  if (seg.gap) {
    // Missing ladder band inside this segment: widen to the segment ends.
    estimate.status = 'interval';
    estimate.interval_bp = [
      Math.pow(10, seg.slope * seg.y1 + seg.intercept),
      Math.pow(10, seg.slope * seg.y0 + seg.intercept),
    ];
    estimate.candidates_bp = [mw];
    estimate.reason = 'ladder_gap';
    return { estimate, judgements };
  }

  estimate.status = 'ok';
  estimate.mw_bp = mw;
  return { estimate, judgements };
}

/** Group bands in a lane whose corrected separation is below the overlap
 *  resolution; overlapping bands can only be resolved as an interval. */
export function groupOverlaps(bands: BandCenter[], smileOffsetPx: number, minSepPx: number): BandCenter[][] {
  const sorted = [...bands].sort((a, b) => a.y - b.y || a.band_id.localeCompare(b.band_id));
  const groups: BandCenter[][] = [];
  for (const band of sorted) {
    const last = groups[groups.length - 1];
    if (last) {
      const prev = last[last.length - 1];
      if (Math.abs((band.y - smileOffsetPx) - (prev.y - smileOffsetPx)) < minSepPx) {
        last.push(band);
        continue;
      }
    }
    groups.push([band]);
  }
  return groups;
}
