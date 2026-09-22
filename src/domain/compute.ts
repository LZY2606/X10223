import type {
  BandCenter, ComputeResult, Diagnostic, Estimate, GelImageMeta, LaneBoundary,
  LadderBandNominal, PixelPoint,
} from '../shared/types.js';
import { resultId } from '../shared/id.js';
import {
  buildLanePath, buildScale, estimateMw, NonMonotonicScaleError, pixelToS,
} from './calibration.js';
import { classifyPeaks, findPeaks, sampleProfile, type ClassifyOptions } from './bands.js';
import { decodeGrayPng, PngDecodeError } from './png.js';

export interface InferenceInput {
  image: { meta: GelImageMeta; png: Buffer } | null;
  ladderNominal: LadderBandNominal[] | null;
  lanes: LaneBoundary[] | null;
  bandCenters: BandCenter[] | null;
}

export interface InferenceParams {
  version: string;
  minPeakHeight: number;
  minPeakDistance: number;
  classify: ClassifyOptions;
  wideGapFactor: number;
}

export const DEFAULT_PARAMS: InferenceParams = {
  version: 'params.v1',
  minPeakHeight: 60,
  minPeakDistance: 6,
  classify: { grayMax: 255, saturationPlateau: 3, tailingAsymmetry: 1.8, overlapGap: 10 },
  wideGapFactor: 2.5,
};

/** 输入完整性校验：返回带位置的诊断，绝不用空值/默认值伪装成功 */
export function validateInput(input: InferenceInput): Diagnostic[] {
  const d: Diagnostic[] = [];
  if (!input.image) d.push({ path: 'image', code: 'missing', message: '缺少原始凝胶图像' });
  if (!input.ladderNominal || input.ladderNominal.length === 0)
    d.push({ path: 'ladderNominal', code: 'missing', message: '缺少 ladder 标称值' });
  if (!input.lanes || input.lanes.length === 0)
    d.push({ path: 'lanes', code: 'missing', message: '缺少 lane 边界' });
  if (!input.bandCenters || input.bandCenters.length === 0)
    d.push({ path: 'bandCenters', code: 'missing', message: '缺少条带中心' });
  if (input.image) {
    if (!input.image.meta.exposure?.time || input.image.meta.exposure.time.value <= 0)
      d.push({ path: 'image.exposure.time', code: 'invalid', message: '曝光时间缺失或非法' });
    if (!input.image.meta.orientation)
      d.push({ path: 'image.orientation', code: 'invalid', message: '拍摄方向缺失' });
  }
  if (input.lanes) {
    input.lanes.forEach((lane, i) => {
      if (!lane.centerline || lane.centerline.length < 2)
        d.push({ path: `lanes[${i}].centerline`, code: 'invalid', message: `lane ${lane.laneId} 中心线不足 2 点` });
    });
  }
  if (input.bandCenters) {
    input.bandCenters.forEach((b, i) => {
      if (b.center.x == null || b.center.y == null)
        d.push({ path: `bandCenters[${i}].center`, code: 'invalid', message: `band ${b.bandId} 中心坐标缺失` });
    });
  }
  const ladderLanes = (input.lanes ?? []).filter((l) => l.role === 'ladder');
  if (input.lanes && ladderLanes.length === 0)
    d.push({ path: 'lanes', code: 'no_ladder_lane', message: '没有 ladder 泳道，无法建立标尺' });
  return d;
}

class Budget {
  constructor(public left: number) {}
  step(n = 1) {
    this.left -= n;
    if (this.left < 0) throw new BudgetExhausted();
  }
}
class BudgetExhausted extends Error {}

export interface InferenceOutput {
  result: ComputeResult;
  /** 供事件落库：每个 estimate 的像素级来源 */
  traces: { bandId: string; laneId: string; pixel: PixelPoint; s: number; projectionDistance: number }[];
  profile?: { laneId: string; s: number[]; v: number[] };
}

/**
 * 分子量推断管线。资源预算耗尽、格式损坏、语义无解是三种不同结果。
 */
export function runInference(
  input: InferenceInput,
  params: InferenceParams,
  budgetSteps: number,
  eventIdForResults: string,
  provenance: { materialIds: string[]; parentEventIds: string[] },
): InferenceOutput {
  const diagnostics = validateInput(input);
  if (diagnostics.length > 0) return { result: { status: 'incomplete_input', diagnostics }, traces: [] };

  let pixels: Uint8Array;
  let width: number;
  let height: number;
  try {
    const decoded = decodeGrayPng(input.image!.png);
    pixels = decoded.pixels;
    width = decoded.width;
    height = decoded.height;
  } catch (e) {
    if (e instanceof PngDecodeError) {
      return {
        result: { status: 'corrupt_format', diagnostics: [{ path: 'image.png', code: 'decode', message: e.message }] },
        traces: [],
      };
    }
    throw e;
  }

  const budget = new Budget(budgetSteps);
  const traces: InferenceOutput['traces'] = [];
  try {
    budget.step(2);
    const lanes = input.lanes!;
    const ladderLane = lanes.find((l) => l.role === 'ladder')!;
    const ladderPath = buildLanePath(ladderLane);
    const centers = input.bandCenters!;
    const nominal = input.ladderNominal!;

    // ladder 点：标称值按 bp 降序与 ladder 泳道内检测峰按 s 升序配对
    const ladderCenters = centers.filter((c) => c.laneId === ladderLane.laneId);
    const ladderProfile = sampleProfile(pixels, width, height, ladderPath);
    budget.step(Math.ceil(ladderProfile.s.length / 50));
    const ladderPeaks = findPeaks(ladderProfile.s, ladderProfile.v, params.minPeakHeight, params.minPeakDistance);
    const ladderPoints = ladderPeaks.map((p, i) => {
      const src = ladderCenters[i];
      const proj = src ? pixelToS(ladderPath, src.center) : { s: p.sPeak, distance: 0 };
      if (src) traces.push({ bandId: src.bandId, laneId: ladderLane.laneId, pixel: src.center, s: proj.s, projectionDistance: proj.distance });
      return { bandId: src?.bandId ?? `ladder_peak_${i}`, s: proj.s, bp: nominal[i]?.size.value };
    }).filter((p) => typeof p.bp === 'number') as { bandId: string; s: number; bp: number }[];

    let scale;
    try {
      scale = buildScale(ladderPoints, params.wideGapFactor);
    } catch (e) {
      if (e instanceof NonMonotonicScaleError) {
        return {
          result: {
            status: 'semantic_unsolvable',
            reason: e.detail,
            diagnostics: [{ path: 'ladderNominal', code: 'non_monotonic', message: e.detail }],
          },
          traces,
        };
      }
      throw e;
    }
    budget.step(2);

    const estimates: Estimate[] = [];
    let idx = 0;
    for (const lane of lanes) {
      budget.step(1);
      const path = buildLanePath(lane);
      const profile = sampleProfile(pixels, width, height, path);
      budget.step(Math.ceil(profile.s.length / 50));
      const peaks = findPeaks(profile.s, profile.v, params.minPeakHeight, params.minPeakDistance);
      const classified = classifyPeaks(peaks, params.classify);
      const laneCenters = centers.filter((c) => c.laneId === lane.laneId);
      classified.forEach(({ peak, cls }, ci) => {
        const src = laneCenters[ci];
        const bandId = src?.bandId ?? `${lane.laneId}_peak_${ci}`;
        if (src) {
          const proj = pixelToS(path, src.center);
          traces.push({ bandId, laneId: lane.laneId, pixel: src.center, s: proj.s, projectionDistance: proj.distance });
        }
        const base = {
          bandId,
          laneId: lane.laneId,
          provenance: {
            materialIds: provenance.materialIds,
            paramsVersion: params.version,
            parentEventIds: provenance.parentEventIds,
          },
        };
        const push = (e: Omit<Estimate, 'id'>) => estimates.push({ ...e, id: resultId(eventIdForResults, idx++) } as Estimate);
        if (cls.kind === 'point') {
          const est = estimateMw(scale, cls.s);
          if (est.ok) {
            push({
              ...base, bp: { value: est.value.bp, unit: 'bp' }, status: 'candidate',
              segmentId: est.value.segment.id,
              validRegion: { sLo: est.value.segment.s0, sHi: est.value.segment.s1 },
              ...(est.value.segment.wideGap ? { invalidReason: '插值段为 ladder 缺带造成的宽间隙段' } : {}),
            });
          } else {
            push({ ...base, status: 'candidate', invalidReason: est.reason, validRegion: { sLo: scale.validRegion.sLo, sHi: scale.validRegion.sHi } });
          }
        } else if (cls.kind === 'interval') {
          const lo = estimateMw(scale, cls.sHi); // s 大 → bp 小
          const hi = estimateMw(scale, cls.sLo);
          push({
            ...base,
            status: 'candidate',
            bpInterval: {
              lo: { value: lo.ok ? lo.value.bp : NaN, unit: 'bp' },
              hi: { value: hi.ok ? hi.value.bp : NaN, unit: 'bp' },
            },
            invalidReason: cls.cause === 'saturated' ? '饱和条带：只能给区间' : '拖尾条带：只能给区间',
            validRegion: { sLo: scale.validRegion.sLo, sHi: scale.validRegion.sHi },
          });
        } else {
          const cands = cls.candidates
            .map((c) => estimateMw(scale, c.s))
            .filter((r) => r.ok)
            .map((r) => ({ value: (r as { ok: true; value: { bp: number } }).value.bp, unit: 'bp' as const }));
          push({
            ...base, status: 'candidate', candidates: cands,
            invalidReason: '两条带重叠：保留全部合法候选，无法唯一决定',
            validRegion: { sLo: scale.validRegion.sLo, sHi: scale.validRegion.sHi },
          });
        }
      });
    }
    return { result: { status: 'ok', estimates, diagnostics }, traces, profile: { laneId: ladderLane.laneId, ...ladderProfile } };
  } catch (e) {
    if (e instanceof BudgetExhausted) {
      return { result: { status: 'budget_exhausted', consumedSteps: budgetSteps - budget.left, budget: budgetSteps }, traces };
    }
    throw e;
  }
}
