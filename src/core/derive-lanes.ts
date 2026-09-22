import type {
  CalibrationSegment,
  DerivedBand,
  Diagnostic,
  LadderPoint,
  LaneCalibration,
  LaneDerivation,
  MwCandidate,
  ProfilePoint,
  Quant,
} from './types.js';
import type { ExposureMaterial, LadderSpecMaterial, LaneSpec, ParameterSet, ProjectState } from './types.js';
import type { BandCenterMaterial } from './types.js';
import type { GrayRaster } from './raster.js';
import { findPeaks, migrationOf, type ProfileSample } from './raster.js';
import { PX, buildLocalCalibration, buildPolyline, pointAtS } from './geometry.js';
import { param } from './events.js';
import { contentId } from './ids.js';
import { SemanticUnsolvableError } from './errors.js';

export interface LaneRuntime {
  state: ProjectState;
  exposure: ExposureMaterial;
  ladderMat: LadderSpecMaterial;
  lane: LaneSpec;
  sourceLaneId: string;
  bandsMat: BandCenterMaterial;
  analyzeCenters: Array<{ x: number; y: number; src: import('./types.js').PixelProvenance }>;
  analyzeRaster: GrayRaster;
  budgetTick: (n: number) => void;
}

const bp = (v: number): Quant => ({ value: v, unit: 'bp' });
const gray = (v: number): Quant => ({ value: v, unit: 'graylevel' });

export function emptyCalibration(laneId: string): LaneCalibration {
  return {
    laneId,
    status: 'invalid',
    ladderPoints: [],
    segments: [],
    validRegion: null,
    diagnostics: [
      {
        code: 'no-local-ruler',
        severity: 'info',
        message: `sample lane ${laneId} 使用 ladder lane 的局部标尺，不单独拟合`,
      },
    ],
    monotonic: true,
  };
}

export function deriveLane(rt: LaneRuntime): LaneDerivation {
  const { state, lane, exposure, analyzeRaster, ladderMat } = rt;
  const halfWidth = Math.round(param(state, lane.laneId, 'profileHalfWidth').value);
  const samples = analyzeRaster.sampleProfile(lane.centerline, halfWidth, 1);
  rt.budgetTick(samples.length);

  const isLadder = lane.laneId === ladderMat.ladderLaneId;
  let calibration: LaneCalibration;
  if (isLadder) {
    calibration = calibrateLadder(rt, samples);
  } else {
    calibration = {
      ...emptyCalibration(lane.laneId),
      diagnostics: [],
    };
  }

  const bands = deriveBands(rt, samples, isLadder ? calibration : null);
  return { lane, calibration, bands };
}

function calibrateLadder(rt: LaneRuntime, samples: ProfileSample[]): LaneCalibration {
  const { lane, ladderMat, state, exposure } = rt;
  const poly = buildPolyline(lane.centerline);
  const diagnostics: Diagnostic[] = [];
  const points: LadderPoint[] = [];
  const calibInputs: Array<{ ladderBandId: string; s: number; bp: number }> = [];
  const segments: CalibrationSegment[] = [];

  // ladder 标称带：以人工/厂商中心为像素来源，匹配自动检测峰。
  const peakOpts = {
    minProminence: param(state, lane.laneId, 'minProminence').value,
    saturationGray: exposure.saturationGray.value,
    mergeDistance: param(state, lane.laneId, 'overlapDistance').value,
  };
  const peaks = findPeaks(samples, peakOpts);
  rt.budgetTick(peaks.length * 10);

  let expectedCount = 0;
  let detectedCount = 0;
  const missing: typeof ladderMat.bands = [];

  for (let idx = 0; idx < ladderMat.bands.length; idx++) {
    const nominal = ladderMat.bands[idx]!;
    const center = nominal.center;
    // 分析帧坐标：把原图中心投影到（已变换的）lane 折线。
    const an = rt.analyzeCenters.find(
      (c) => c.src.x.value === center.x.value && c.src.y.value === center.y.value,
    );
    const proj = an
      ? migrationOf(lane.centerline, an.x, an.y)
      : migrationOf(lane.centerline, center.x.value, center.y.value);
    const s = proj.s;

    const peak = nearestPeak(peaks, s, param(state, lane.laneId, 'overlapDistance').value + 6);
    const detected = Boolean(peak);
    if (nominal.expected) expectedCount++;
    if (nominal.expected && detected) detectedCount++;
    if (nominal.expected && !detected) missing.push(nominal);

    points.push({
      ladderBandId: `lb_${lane.laneId}_${idx}`,
      s: PX(s),
      nominalBp: nominal.nominalBp,
      center,
      fitResidual: { value: 0, unit: 'ratio' },
      detected,
    });

    if (detected) {
      calibInputs.push({
        ladderBandId: `lb_${lane.laneId}_${idx}`,
        s,
        bp: nominal.nominalBp.value,
      });
    } else if (nominal.expected) {
      diagnostics.push({
        code: 'ladder-missing-band',
        severity: 'warning',
        message: `ladder 缺带：标称 ${nominal.nominalBp.value}${nominal.nominalBp.unit} 附近未检测到峰`,
        at: center,
      });
    }
  }

  const built = buildLocalCalibration(calibInputs);
  let status: LaneCalibration['status'] = 'ok';
  let validRegion: LaneCalibration['validRegion'] = null;

  if (!built.calib) {
    status = 'invalid';
    diagnostics.push({
      code: built.reason,
      severity: 'error',
      message:
        built.reason === 'ladder-points-insufficient'
          ? `可用 ladder 点不足（期望 ${expectedCount}，检出 ${detectedCount}），无法建立标尺`
          : 'ladder 标尺无法建立',
      at: { path: `materials.ladder-spec`, materialId: ladderMat.id },
    });
  } else if (!built.monotonic) {
    // 非单调标尺：语义无解，明确区别于缺数据/损坏。
    status = 'invalid';
    diagnostics.push({
      code: 'non-monotonic-ruler',
      severity: 'error',
      message:
        '非单调标尺：迁移距离增大时分子量未严格递减，该 lane 标尺在数学上无合法解，相关分子量标记为无效',
      at: { path: 'materials.ladder-spec.bands', materialId: ladderMat.id },
    });
    for (const p of points) {
      const res = built.calib.residuals[p.ladderBandId];
      if (res !== undefined) p.fitResidual = { value: res, unit: 'ratio' };
    }
  } else {
    const calib = built.calib;
    validRegion = { sLo: PX(calib.validLo), sHi: PX(calib.validHi) };
    for (const p of points) {
      const res = calib.residuals[p.ladderBandId];
      if (res !== undefined) p.fitResidual = { value: res, unit: 'ratio' };
    }
    for (let i = 0; i < calib.points.length - 1; i++) {
      const p0 = calib.points[i]!;
      const p1 = calib.points[i + 1]!;
      segments.push({
        segmentId: `seg_${p0.ladderBandId}_${p1.ladderBandId}`,
        fromLadderBandId: p0.ladderBandId,
        toLadderBandId: p1.ladderBandId,
        sLo: PX(p0.s),
        sHi: PX(p1.s),
        bpLo: bp(Math.min(p0.bp, p1.bp)),
        bpHI: bp(Math.max(p0.bp, p1.bp)),
      });
    }
    if (missing.length > 0) status = 'candidate';
    // 缺带导致有效区间只覆盖检出点之间；首/末缺带会收缩边界。
  }

  // 朴素“同高度=同分子量”：取该 lane 在中点 y 的 ladder 弧长做对照。
  const naive: Quant | undefined =
    built.calib && built.monotonic
      ? bp(10 ** built.calib.fitLogBp(poly.length * 0.5))
      : undefined;

  return {
    laneId: lane.laneId,
    status,
    ladderPoints: points,
    segments,
    validRegion,
    diagnostics,
    monotonic: built.monotonic,
    ...(naive ? { naiveSharedHeightBp: naive } : {}),
  };
}

function nearestPeak(
  peaks: ProfileSample extends never ? never : ReturnType<typeof findPeaks>,
  s: number,
  tol: number,
) {
  let best: (typeof peaks)[number] | null = null;
  for (const p of peaks) {
    const d = Math.abs(p.s - s);
    if (d <= tol && (!best || d < Math.abs(best.s - s))) best = p;
  }
  return best;
}

function deriveBands(
  rt: LaneRuntime,
  samples: ProfileSample[],
  ladderCalibration: LaneCalibration | null,
): DerivedBand[] {
  const { lane, state, exposure, ladderMat } = rt;
  const diagnostics: Diagnostic[] = [];
  const overlapDist = param(state, lane.laneId, 'overlapDistance').value;
  const tailAsym = param(state, lane.laneId, 'tailingAsymmetry').value;
  const peaks = findPeaks(samples, {
    minProminence: param(state, lane.laneId, 'minProminence').value,
    saturationGray: exposure.saturationGray.value,
    mergeDistance: overlapDist,
  });
  rt.budgetTick(peaks.length * 8);

  // sample lane 使用 ladder lane 的局部标尺（微笑下按各自 lane 弧长，不共享高度）。
  const sharedCalib =
    ladderCalibration ?? findLadderCalibration(rt, peaks) ?? null;

  const out: DerivedBand[] = [];
  rt.analyzeCenters.forEach((center, idx) => {
    const proj = migrationOf(lane.centerline, center.x, center.y);
    const s = proj.s;
    const peak = nearestPeak(peaks, s, overlapDist + 6);
    const profile: ProfilePoint[] = samples
      .filter((sp) => Math.abs(sp.s - s) <= 24)
      .map((sp) => ({ s: PX(sp.s), gray: gray(sp.minGray), x: PX(sp.x), y: PX(sp.y) }));

    const bandDiag: Diagnostic[] = [];
    const saturated = peak?.saturated ?? false;
    const clipFraction = peak?.clippingFraction ?? 0;
    const asymmetry = peak?.asymmetry ?? 1;
    const tailed = peak ? peak.asymmetry >= tailAsym || peak.asymmetry <= 1 / tailAsym : false;
    const overlapped = peak ? Boolean((peak as { _overlap?: boolean })._overlap) : false;

    if (saturated) {
      bandDiag.push({
        code: 'band-saturated',
        severity: 'warning',
        message: `饱和条带：峰灰度达到裁剪阈值（裁剪比例 ${clipFraction.toFixed(2)}），中心分子量只能作为候选/区间`,
        at: center.src,
      });
    }
    if (tailed) {
      bandDiag.push({
        code: 'band-tailing',
        severity: 'warning',
        message: `拖尾：半高不对称比 ${asymmetry.toFixed(2)}，只能给候选`,
        at: center.src,
      });
    }
    if (overlapped) {
      bandDiag.push({
        code: 'bands-overlap',
        severity: 'warning',
        message: `两条带重叠：迁移距离在 ${overlapDist}px 内出现相邻峰，无法唯一决定，保留全部合法候选`,
        at: center.src,
      });
    }

    const candidates = buildCandidates({
      rt,
      sharedCalib,
      s,
      saturated,
      overlapped,
      overlappedPeaks: peaks,
      bandKey: `${lane.laneId}_${idx}`,
      isLadder: lane.laneId === ladderMat.ladderId,
      diagnostics: bandDiag,
    });

    let status: DerivedBand['status'] = 'ok';
    if (!sharedCalib || sharedCalib.status === 'invalid') status = 'invalid';
    else if (candidates.length === 0) status = 'invalid';
    else if (candidates.some((c) => c.kind !== 'point')) status = 'interval';
    else if (saturated || tailed || overlapped) status = 'candidate';

    out.push({
      bandId: `band_${lane.laneId}_${idx}`,
      laneId: lane.laneId,
      migration: PX(s),
      candidates,
      status,
      diagnostics: bandDiag,
      profile,
      saturation: {
        saturated,
        maxGray: gray(peak?.minGray ?? 255),
        clippingFraction: { value: clipFraction, unit: 'ratio' },
      },
      tailing: { tailed, asymmetry: { value: asymmetry, unit: 'ratio' } },
      overlap: { overlapped },
    });
  });

  return out;
}

function findLadderCalibration(_rt: LaneRuntime, _peaks: unknown): LaneCalibration | null {
  return null; // 占位：由 derive() 在拿到 ladder lane 后注入共享标尺
}
