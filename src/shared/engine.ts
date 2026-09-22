import type {
  BandCenterMaterial,
  BandResult,
  CalibrationParams,
  ComputeOutput,
  Diagnostic,
  Frame,
  Judgment,
  LaneBoundaryMaterial,
  LaneResult,
  LadderNominalMaterial,
  Material,
  RawImageMaterial,
} from './types.js';
import { arcFrame, centerline, cumulativeLength, imageFrame, projectToArc, q } from './geometry.js';
import { detectPeaks, laneProfile, type Peak } from './imageops.js';
import type { Raster } from './png.js';
import {
  buildSegments,
  enumerateAssignments,
  rejectNonMonotonic,
  segmentMwAt,
  type Knot,
} from './calibration.js';
import { inferSampleBands } from './calibration.js';
import { stableId, stableSort } from './hash.js';

export const DEFAULT_PARAMS: CalibrationParams = {
  paramVersion: 'cal-v1',
  model: 'piecewise-linear-log',
  bandSearchRadiusPx: 24,
  saturationFraction: 0.25,
  overlapBandWidthRatio: 2.2,
  maxAssignments: 256,
  confidenceAuto: 0.6,
};

export type RasterLoader = (blobId: string) => Raster;

interface EngineInput {
  eventId: string;
  parentEventId: string | null;
  materials: Material[];
  decisions: Map<string, BandResult['decision']>;
  params: CalibrationParams;
  loadRaster: RasterLoader;
  prior?: ComputeOutput | null;
  changedMaterialId?: string;
}

function as<T extends Material>(materials: Material[], type: T['type'], imageId?: string): T[] {
  return materials.filter(
    (m) => m.type === type && (!imageId || (m as { imageId?: string }).imageId === imageId),
  ) as T[];
}

export function compute(input: EngineInput): ComputeOutput {
  const diagnostics: Diagnostic[] = [];
  const judgments: Judgment[] = [];
  const frames: Frame[] = [];
  const images = stableSort(as<RawImageMaterial>(input.materials, 'rawImage'), (m) => m.id);
  if (images.length === 0) {
    return {
      frames,
      lanes: [],
      diagnostics: [
        {
          code: 'INPUT_INCOMPLETE',
          severity: 'error',
          failureClass: 'SEMANTIC_NO_SOLUTION',
          message: '缺少原始凝胶图像，输入不完整（不得以默认值伪装成功）',
          position: { frame: 'none' },
        },
      ],
      inputDigest: stableId('digest', ['no-image']),
      paramsVersion: input.params.paramVersion,
      parents: input.parentEventId ? [input.parentEventId] : [],
      judgments,
      affectedTargets: [],
    };
  }
  const image = images[images.length - 1];
  const raster = input.loadRaster(image.blobId);
  const frame = imageFrame(image.id, raster.width, raster.height);
  frames.push(frame);

  const lanesMat = stableSort(
    as<LaneBoundaryMaterial>(input.materials, 'laneBoundary', image.id),
    (m) => m.laneId,
  );
  const laneResults: LaneResult[] = [];
  const ladderCalibration = new Map<
    string,
    { segments: LaneResult['segments']; knots: Knot[]; diagnostic?: Diagnostic }
  >();

  for (const lane of lanesMat) {
    frames.push(arcFrame(lane.laneId, image.id));
    const { center, profile, arcLength } = laneProfile(raster, lane);
    const peaks = detectPeaks(profile, {
      minHeight: 28,
      saturationFraction: input.params.saturationFraction,
      smearHalfWidthPx: 14,
      overlapValleyRatio: 0.7,
    });
    const laneDiagnostics: Diagnostic[] = [];

    if (lane.role === 'ladder') {
      const result = buildLadder(lane, peaks, input.materials, frame.id, input.params, {
        laneDiagnostics,
        judgments,
      });
      ladderCalibration.set(lane.laneId, result);
      laneResults.push({
        laneId: lane.laneId,
        role: 'ladder',
        centerline: center,
        arcLengthPx: arcLength,
        segments: result.segments,
        globalFit:
          result.knots.length >= 2 ? fitGlobal(result.knots, frame.id) : undefined,
        bands: ladderBands(lane.laneId, result.knots, frame.id),
        diagnostics: laneDiagnostics,
      });
    } else {
      const nominalLadder = lanesMat.find((l) => l.role === 'ladder');
      const calibration = nominalLadder
        ? ladderCalibration.get(nominalLadder.laneId)
        : undefined;
      const arcFrameId = arcFrame(lane.laneId, image.id).id;
      const bandMaterials = stableSort(
        as<BandCenterMaterial>(input.materials, 'bandCenter', image.id).filter(
          (b) => b.laneId === lane.laneId,
        ),
        (b) => `${b.at.y}-${b.at.x}-${b.id}`,
      ).map((b) => ({ id: b.id, at: b.at, source: b.source }));

      const inferred = calibration
        ? inferSampleBands(
            {
              laneId: lane.laneId,
              frame: arcFrameId,
              lane,
              peaks,
              bandMaterials,
              segments: calibration.segments,
              knotCount: calibration.knots.length,
              params: input.params,
              ladderLane: nominalLadder,
            },
            input.decisions,
          )
        : {
            bands: bandMaterials.map((b) => ({
              id: b.id,
              laneId: lane.laneId,
              center: b.at,
              arcS: q(projectToArc(b.at, center), 'px', arcFrameId),
              status: 'invalid' as const,
              flags: [],
              diagnostics: [
                {
                  code: 'NO_LADDER',
                  severity: 'error' as const,
                  failureClass: 'SEMANTIC_NO_SOLUTION' as const,
                  message: '该泳道缺少可用 ladder 校准',
                  position: { frame: arcFrameId, laneId: lane.laneId, bandId: b.id, point: b.at },
                },
              ],
            })),
            diagnostics: [] as Diagnostic[],
            judgments: [] as Judgment[],
          };
      judgments.push(...inferred.judgments);
      laneDiagnostics.push(...inferred.diagnostics);
      if (calibration?.diagnostic) laneDiagnostics.push(calibration.diagnostic);
      laneResults.push({
        laneId: lane.laneId,
        role: 'sample',
        centerline: center,
        arcLengthPx: arcLength,
        validDomain: calibration?.segments[0]
          ? {
              min: calibration.segments[0].validDomain.min,
              max: calibration.segments[calibration.segments.length - 1].validDomain.max,
            }
          : undefined,
        segments: calibration?.segments ?? [],
        bands: inferred.bands,
        diagnostics: laneDiagnostics,
      });
    }
  }

  diagnostics.push(...laneResults.flatMap((l) => l.diagnostics));
  smileJudgment(laneResults, judgments);
  validDomainJudgment(laneResults, judgments);
  transitionJudgment(input, laneResults, judgments);
  impactJudgment(input, laneResults, judgments, lanesMat);

  const completeness = completenessCheck(lanesMat, input.materials, image.id);
  diagnostics.push(...completeness);

  const inputDigest = stableId('digest', [
    image.sha256,
    input.materials.map((m) => [m.id, m.version]),
    input.params.paramVersion,
  ]);

  return {
    frames,
    lanes: laneResults,
    diagnostics,
    inputDigest,
    paramsVersion: input.params.paramVersion,
    parents: input.parentEventId ? [input.parentEventId] : [],
    judgments,
    affectedTargets: Array.from(
      new Set(
        judgments
          .filter((j) => j.rule !== 'impact-scope-contained')
          .flatMap((j) => j.targets),
      ),
    ),
  };
}

function fitGlobal(knots: Knot[], frame: string): LaneResult['globalFit'] {
  const n = knots.length;
  const xs = knots.map((k) => k.s);
  const ys = knots.map((k) => Math.log(k.mwBp));
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my);
    sxx += (xs[i] - mx) ** 2;
    syy += (ys[i] - my) ** 2;
  }
  const slope = sxx ? sxy / sxx : 0;
  const intercept = my - slope * mx;
  const r2 = sxx && syy ? (sxy * sxy) / (sxx * syy) : 0;
  return {
    intercept,
    slope,
    r2,
    residuals: knots.map((k) => ({
      knotId: k.id,
      residualPx: k.s - (Math.log(k.mwBp) - intercept) / (slope || 1e-9),
    })),
  };
}

function ladderBands(laneId: string, knots: Knot[], frame: string): BandResult[] {
  return knots.map((k) => ({
    id: stableId('lb', [laneId, k.id]),
    laneId,
    center: { x: 0, y: k.s },
    arcS: q(k.s, 'px', frame),
    status: 'accepted' as const,
    mw: q(k.mwBp, 'bp', 'ladder nominal'),
    flags: [],
    diagnostics: [],
  }));
}

function buildLadder(
  lane: LaneBoundaryMaterial,
  peaks: Peak[],
  materials: Material[],
  frame: string,
  params: CalibrationParams,
  ctx: { laneDiagnostics: Diagnostic[]; judgments: Judgment[] },
): { segments: LaneResult['segments']; knots: Knot[]; diagnostic?: Diagnostic } {
  const nominal = as<LadderNominalMaterial>(materials, 'ladderNominal').find(
    (m) => m.laneId === lane.laneId,
  );
  if (!nominal) {
    const diagnostic: Diagnostic = {
      code: 'LADDER_NOMINAL_MISSING',
      severity: 'error',
      failureClass: 'SEMANTIC_NO_SOLUTION',
      message: 'ladder 泳道缺少标称分子量表',
      position: { frame, laneId: lane.laneId, materialId: lane.id },
    };
    ctx.laneDiagnostics.push(diagnostic);
    return { segments: [], knots: [], diagnostic };
  }
  const nominalRows = nominal.bands.map((b, i) => ({ id: b.id, mwBp: b.mw.value, idx: i }));
  const { assignments, budgetExceeded } = enumerateAssignments(
    lane.laneId,
    peaks,
    nominalRows,
    params.maxAssignments,
  );

  if (budgetExceeded || assignments.length > params.maxAssignments) {
    const diagnostic: Diagnostic = {
      code: 'ASSIGNMENT_BUDGET_EXHAUSTED',
      severity: 'error',
      failureClass: 'BUDGET_EXHAUSTED',
      message: `缺带配准合法候选超过预算 ${params.maxAssignments}，资源预算耗尽（区别于格式损坏/语义无解）`,
      position: { frame, laneId: lane.laneId, materialId: nominal.id },
    };
    ctx.laneDiagnostics.push(diagnostic);
    ctx.judgments.push({
      id: stableId('jdg', ['budget', lane.laneId]),
      rule: 'candidate-set-exhausted-budget',
      outcome: 'violation',
      targets: [lane.laneId],
      evidence: { maxAssignments: params.maxAssignments },
      basis: [{ materialId: nominal.id, version: nominal.version, frame }],
    });
  }

  // 缺带：检测到的 ladder 峰少于标称值，显式记录候选枚举（采纳首个等长候选）。
  if (peaks.length < nominalRows.length) {
    ctx.laneDiagnostics.push({
      code: 'LADDER_MISSING_BAND',
      severity: 'warning',
      message: `ladder 缺带：检测到 ${peaks.length} 条，标称 ${nominalRows.length} 条；保留 ${assignments.length} 个合法配准候选`,
      position: { frame, laneId: lane.laneId, materialId: nominal.id },
    });
    ctx.judgments.push({
      id: stableId('jdg', ['missing', lane.laneId]),
      rule: 'missing-band-enumerate-assignments',
      outcome: 'hold',
      targets: [lane.laneId],
      evidence: {
        detected: peaks.length,
        nominal: nominalRows.length,
        assignmentCount: Math.min(assignments.length, params.maxAssignments),
      },
      basis: [{ materialId: nominal.id, version: nominal.version, frame }],
    });
  }

  const fullKnot = (): Knot[] =>
    peaks.map((peak, i) => ({
      id: stableId('knot', [lane.laneId, peak.s, nominalRows[i]?.id ?? `x${i}`]),
      s: peak.s,
      mwBp: nominalRows[i]?.mwBp ?? 0,
      nominalId: nominalRows[i]?.id ?? `nominal-${i}`,
      observed: true,
    }));

  let knots = fullKnot();
  const mono = rejectNonMonotonic(lane.laneId, knots, frame);
  if (!mono.ok && mono.diagnostic) {
    ctx.laneDiagnostics.push(mono.diagnostic);
    ctx.judgments.push({
      id: stableId('jdg', ['nonmono', lane.laneId]),
      rule: 'nonmonotonic-ruler-rejected',
      outcome: 'violation',
      targets: [lane.laneId],
      evidence: { knots: knots.map((k) => ({ s: k.s, mw: k.mwBp })) },
      basis: [{ materialId: nominal.id, version: nominal.version, frame }],
    });
    return { segments: [], knots, diagnostic: mono.diagnostic };
  }

  const segments = buildSegments(lane.laneId, frame, knots, 0);
  return { segments, knots };
}

/** “微笑”弯曲：同一 y 高度在不同弯曲泳道上弧长 s 不同 → 不得当作同一分子量。 */
function smileJudgment(lanes: LaneResult[], judgments: Judgment[]): void {
  const curved = lanes.filter((l) => l.centerline.length > 2);
  if (curved.length < 1) return;
  for (const lane of curved) {
    const first = lane.centerline[0];
    const mid = lane.centerline[Math.floor(lane.centerline.length / 2)];
    const bow = Math.abs(mid.x - (first.x + lane.centerline[lane.centerline.length - 1].x) / 2);
    if (bow > 3) {
      judgments.push({
        id: stableId('jdg', ['smile', lane.laneId]),
        rule: 'smile-height-not-equal-mw',
        outcome: 'hold',
        targets: [lane.laneId],
        evidence: { bowPx: bow, arcLengthPx: lane.arcLengthPx },
        basis: [{ materialId: `laneBoundary:${lane.laneId}`, version: 1, frame: 'image-px' }],
      });
    }
  }
}

function validDomainJudgment(lanes: LaneResult[], judgments: Judgment[]): void {
  for (const lane of lanes) {
    if (lane.role !== 'sample' || !lane.validDomain) continue;
    const outside = lane.bands.filter((b) => b.status === 'invalid');
    if (outside.length > 0) {
      judgments.push({
        id: stableId('jdg', ['domain', lane.laneId]),
        rule: 'local-ruler-requires-valid-domain',
        outcome: 'hold',
        targets: [lane.laneId, ...outside.map((b) => b.id)],
        evidence: {
          domain: [lane.validDomain.min.value, lane.validDomain.max.value],
          outside: outside.map((b) => b.arcS.value),
        },
        basis: [{ materialId: `laneBoundary:${lane.laneId}`, version: 1, frame: `frame-arc-${lane.laneId}` }],
      });
    }
  }
}

function transitionJudgment(
  input: EngineInput,
  lanes: LaneResult[],
  judgments: Judgment[],
): void {
  if (!input.prior) return;
  const before = new Map(
    input.prior.lanes.flatMap((l) => l.bands.map((b) => [`${l.laneId}:${b.id}`, b.status])),
  );
  const changed: string[] = [];
  for (const lane of lanes) {
    for (const band of lane.bands) {
      const key = `${lane.laneId}:${band.id}`;
      if (before.has(key) && before.get(key) !== band.status) changed.push(band.id);
    }
  }
  if (changed.length > 0) {
    judgments.push({
      id: stableId('jdg', ['revision', input.eventId]),
      rule: 'revision-local-invalidation',
      outcome: 'hold',
      targets: changed,
      evidence: { changedMaterial: input.changedMaterialId ?? null },
      basis: [{ materialId: input.changedMaterialId ?? 'params', version: 1, frame: 'arc-s' }],
    });
  }
}

/** 影响范围限定：单条 lane 源改动只能影响该 lane 及其条带。 */
function impactJudgment(
  input: EngineInput,
  lanes: LaneResult[],
  judgments: Judgment[],
  laneMaterials: LaneBoundaryMaterial[],
): void {
  if (!input.changedMaterialId || !input.prior) return;
  const changedLane = laneMaterials.find((l) => l.id === input.changedMaterialId);
  const scope = changedLane ? [changedLane.laneId] : [];
  const touched = lanes
    .filter((l) => scope.includes(l.laneId) || hasDiagnosticChange(input.prior!, l))
    .map((l) => l.laneId);
  const contained = changedLane ? touched.every((id) => scope.includes(id)) : true;
  judgments.push({
    id: stableId('jdg', ['impact', input.changedMaterialId]),
    rule: 'impact-scope-contained',
    outcome: contained ? 'hold' : 'violation',
    targets: Array.from(new Set([...scope, ...touched])),
    evidence: { expectedScope: scope, touched },
    basis: [{ materialId: input.changedMaterialId, version: 1, frame: 'image-px' }],
  });
}

function hasDiagnosticChange(prior: ComputeOutput, lane: LaneResult): boolean {
  const old = prior.lanes.find((l) => l.laneId === lane.laneId);
  if (!old) return true;
  return JSON.stringify(old.diagnostics.map((d) => d.code).sort()) !==
    JSON.stringify(lane.diagnostics.map((d) => d.code).sort());
}

function completenessCheck(
  laneMaterials: LaneBoundaryMaterial[],
  materials: Material[],
  imageId: string,
): Diagnostic[] {
  const out: Diagnostic[] = [];
  if (!materials.some((m) => m.type === 'orientation')) {
    out.push({
      code: 'ORIENTATION_MISSING',
      severity: 'error',
      failureClass: 'SEMANTIC_NO_SOLUTION',
      message: '缺少拍摄方向，输入不完整',
      position: { frame: 'image-px' },
    });
  }
  if (!materials.some((m) => m.type === 'exposure')) {
    out.push({
      code: 'EXPOSURE_MISSING',
      severity: 'error',
      failureClass: 'SEMANTIC_NO_SOLUTION',
      message: '缺少曝光信息，输入不完整',
      position: { frame: 'image-px' },
    });
  }
  if (!laneMaterials.some((l) => l.role === 'ladder')) {
    out.push({
      code: 'LADDER_LANE_MISSING',
      severity: 'error',
      failureClass: 'SEMANTIC_NO_SOLUTION',
      message: '缺少 ladder 泳道边界',
      position: { frame: 'image-px' },
    });
  }
  if (
    !materials.some(
      (m) => m.type === 'bandCenter' && (m as BandCenterMaterial).imageId === imageId,
    )
  ) {
    out.push({
      code: 'BAND_CENTER_MISSING',
      severity: 'error',
      failureClass: 'SEMANTIC_NO_SOLUTION',
      message: '缺少条带中心像素来源',
      position: { frame: 'image-px' },
    });
  }
  return out;
}
