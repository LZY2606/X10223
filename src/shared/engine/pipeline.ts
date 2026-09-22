// 编排：材料/参数 → 解码 → 定向 → 泳道 → 条带 → 标定 → 分子量。
// 所有步骤产出 DerivationRecord（输入摘要、参数版本、父级依赖）。
// 纯领域逻辑，可被 Node 服务与测试直接调用，不依赖浏览器/DOM。
import { hashJson, sha256Hex } from '../hash.js';
import { derivationId, stableId } from '../ids.js';
import { RULE_VERSIONS, type Budget, DEFAULT_BUDGET } from '../versions.js';
import { orientedToImage } from '../geometry.js';
import { toAbsorbance, orientImage, type OrientedGray } from './imageOps.js';
import { detectBands, type DetectedBandShape } from './detectBands.js';
import { detectLanes, type DetectedLaneShape } from './detectLanes.js';
import { calibrate } from './calibrate.js';
import { estimateBandMw } from './estimateMw.js';
import type {
  Band,
  Calibration,
  Diagnostic,
  ImageMaterial,
  LadderSpec,
  Lane,
  MolecularWeightEstimate,
  ParamSet,
  SourcedPoint,
  DerivationRecord,
} from '../types.js';
import { D, diag } from '../diagnostics.js';

export interface PipelineInput {
  image: { width: number; height: number; gray: Uint8Array };
  material: ImageMaterial;
  params: ParamSet;
  ladderSpec?: LadderSpec;
  ladderLaneIndex?: number; // 1-based
  forcedPairing?: Array<{ rank: number; bandId: string }>;
  calibrationId: string;
  budget?: Budget;
}

export interface PipelineOutput {
  lanes: Lane[];
  bands: Band[];
  calibration?: Calibration;
  estimates: MolecularWeightEstimate[];
  oriented: { width: number; height: number; deg: number };
  profiles: Record<number, import('./detectBands.js').ProfilePoint[]>;
  diagnostics: Diagnostic[];
  derivations: DerivationRecord[];
}

export function runPipeline(input: PipelineInput): PipelineOutput {
  const diagnostics: Diagnostic[] = [];
  const derivations: DerivationRecord[] = [];
  const budget = input.budget ?? DEFAULT_BUDGET;
  const img = input.image;
  const deg = input.material.acquisition.orientationDegrees;

  // 方向语义检查：迁移方向必须朝下。旋转后的图如果宽高与声明冲突则报错。
  if (![0, 90, 180, 270].includes(((deg % 360) + 360) % 360)) {
    diagnostics.push(
      diag(D.ORIENTATION_MISMATCH, 'warning', `非正交拍摄方向 ${deg}°，按最近邻旋转处理`, '/acquisition/orientationDegrees'),
    );
  }
  if (
    img.width * img.height > budget.maxPixelsPerChannel
  ) {
    diagnostics.push(
      diag(D.BUDGET_EXHAUSTED, 'error', `像素数超过预算 ${budget.maxPixelsPerChannel}`, '/image', {
        failureClass: 'budget_exhausted',
      }),
    );
    return emptyOut(input, orientedDims(img.width, img.height, deg), diagnostics, derivations);
  }

  const oriented = orientImage(img.gray, img.width, img.height, deg);
  derivations.push(
    mkDerivation(
      'image.oriented',
      RULE_VERSIONS.geometry,
      input.params.version,
      { sha256: input.material.sha256, deg, w: img.width, h: img.height },
      [],
      { width: oriented.width, height: oriented.height },
    ),
  );

  const absorb = toAbsorbance(oriented.gray);

  const laneRes = detectLanes(absorb, oriented.width, oriented.height, {
    laneMinSeparationPx: input.params.detector.laneMinSeparationPx,
  });
  diagnostics.push(...laneRes.diagnostics);
  const laneDeriv = mkDerivation(
    'lanes.detected',
    RULE_VERSIONS.detector,
    input.params.version,
    { oriented: [oriented.width, oriented.height], params: input.params.detector },
    derivations.map((d) => d.id),
    { count: laneRes.lanes.length, smile: laneRes.smileDetected },
  );
  derivations.push(laneDeriv);

  const bandRes = detectBands(
    absorb,
    oriented.width,
    oriented.height,
    laneRes.lanes,
    input.params.detector,
  );
  diagnostics.push(...bandRes.diagnostics);
  derivations.push(
    mkDerivation(
      'bands.detected',
      RULE_VERSIONS.detector,
      input.params.version,
      { laneCount: laneRes.lanes.length, params: input.params.detector },
      [laneDeriv.id],
      { count: bandRes.bands.length },
    ),
  );

  const provBase = (method: string) => ({
    origin: 'derived' as const,
    imageMaterialId: input.material.id,
    derivationId: laneDeriv.id,
    method,
  });

  const lanes: Lane[] = laneRes.lanes.map((shape) =>
    shapeToLane(shape, oriented, input.material.id, laneDeriv.id, deg),
  );
  if (input.ladderLaneIndex) {
    const l = lanes[input.ladderLaneIndex - 1];
    if (l) l.role = 'ladder';
  }

  const laneByIndex = new Map(lanes.map((l) => [l.laneIndex, l]));
  const bands: Band[] = bandRes.bands.map((shape, i) =>
    shapeToBand(shape, laneByIndex, oriented, input.material.id, derivations[derivations.length - 1]!.id, deg, i),
  );

  let calibration: Calibration | undefined;
  let estimates: MolecularWeightEstimate[] = [];

  if (input.ladderSpec && input.ladderLaneIndex) {
    const ladderLane = lanes[input.ladderLaneIndex - 1];
    const ladderBands = bands.filter((b) => b.laneId === ladderLane?.id).sort(
      (a, b) => a.migrationS.value - b.migrationS.value,
    );
    const calResult = calibrate({
      calibrationId: input.calibrationId,
      laneId: ladderLane?.id ?? 'unknown',
      ladderSpecId: input.ladderSpec.id,
      ladderBands: input.ladderSpec.bands.map((b) => ({
        nominal: b.nominal,
        rank: b.rank,
        present: b.present,
      })),
      observed: ladderBands.map((b) => ({ bandId: b.id, s: b.migrationS.value, centerX: b.center.x })),
      paramsVersion: input.params.version,
      centerline: ladderLane?.center ?? [],
      halfWidthPx: ladderLane?.halfWidthPx ?? 0,
      budget: { maxPairingPermutations: budget.maxPairingPermutations },
      forcedPairing: input.forcedPairing,
    });
    diagnostics.push(...calResult.diagnostics);
    calibration = calResult.calibration;
    derivations.push(
      mkDerivation(
        'calibration.fitted',
        RULE_VERSIONS.calibration,
        input.params.version,
        {
          ladder: input.ladderSpec.id,
          lane: ladderLane?.id,
          segments: calibration.segments.length,
          status: calibration.status,
        },
        [derivations[derivations.length - 1]!.id],
        { status: calibration.status },
      ),
    );
    const mwDerivParents = [derivations[derivations.length - 1]!.id];

    const sampleBands = bands.filter((b) => b.laneId !== ladderLane?.id);
    for (const b of sampleBands) {
      const { estimate, diagnostics: md } = estimateBandMw({
        band: b,
        calibration,
        s: b.migrationS.value,
        centerX: b.center.x,
        unit: input.ladderSpec.unit,
        derivationId: '',
      });
      estimates.push(estimate);
      diagnostics.push(...md);
    }
    derivations.push(
      mkDerivation(
        'mw.estimated',
        RULE_VERSIONS.mw,
        input.params.version,
        { calibration: calibration.id, bands: sampleBands.length },
        mwDerivParents,
        { count: estimates.length, unresolved: estimates.filter((e) => e.status === 'unresolved').length },
      ),
    );
    const mwDeriv = derivations[derivations.length - 1]!;
    for (const e of estimates) {
      for (const c of e.candidates) c.derivationId = mwDeriv.id;
    }
  }

  return {
    lanes,
    bands,
    calibration,
    estimates,
    oriented: { width: oriented.width, height: oriented.height, deg: oriented.deg },
    profiles: bandRes.profiles,
    diagnostics,
    derivations,
  };
}

function emptyOut(
  input: PipelineInput,
  dims: { w: number; h: number },
  diagnostics: Diagnostic[],
  derivations: DerivationRecord[],
): PipelineOutput {
  return {
    lanes: [],
    bands: [],
    estimates: [],
    oriented: { width: dims.w, height: dims.h, deg: input.material.acquisition.orientationDegrees },
    profiles: {},
    diagnostics,
    derivations,
  };
}

function orientedDims(w: number, h: number, deg: number): { w: number; h: number } {
  const r = ((deg % 360) + 360) % 360;
  return r === 90 || r === 270 ? { w: h, h: w } : { w, h: h };
}

function shapeToLane(
  shape: DetectedLaneShape,
  oriented: OrientedGray,
  imageMaterialId: string,
  derivationId: string,
  deg: number,
): Lane {
  const toImg = (p: { x: number; y: number }): SourcedPoint => {
    const q = orientedToImage(p, deg, oriented.width, oriented.height);
    return {
      x: Number(q.x.toFixed(2)),
      y: Number(q.y.toFixed(2)),
      frame: 'image_px',
      provenance: {
        origin: 'derived',
        imageMaterialId,
        derivationId,
        method: 'lane.tracking',
      },
    };
  };
  const id = stableId(
    'lane',
    imageMaterialId,
    shape.laneIndex,
    shape.centerline[0]!.x,
    shape.centerline[0]!.y,
  );
  return {
    id,
    laneIndex: shape.laneIndex,
    center: shape.centerline.map(toImg),
    leftEdge: shape.leftEdge.map(toImg),
    rightEdge: shape.rightEdge.map(toImg),
    halfWidthPx: shape.halfWidthPx,
    role: 'sample',
    status: 'proposed',
    origin: 'auto',
    diagnosticCodes: shape.curvaturePx >= 4 ? [D.SMILE_DETECTED] : [],
  };
}

function shapeToBand(
  shape: DetectedBandShape,
  laneByIndex: Map<number, Lane>,
  oriented: OrientedGray,
  imageMaterialId: string,
  derivationId: string,
  deg: number,
  order: number,
): Band {
  const lane = laneByIndex.get(shape.laneIndex)!;
  const q = orientedToImage({ x: shape.centerX, y: shape.centerY }, deg, oriented.width, oriented.height);
  const overlapId = shape.overlapGroupRank !== undefined
    ? stableId('overlap', lane.id, Math.round(shape.peakS))
    : undefined;
  const codes: string[] = [];
  if (shape.saturated) codes.push(D.BAND_SATURATED);
  if (shape.tailingAsymmetry >= 1.6) codes.push(D.BAND_TAILING);
  if (overlapId) codes.push(D.BANDS_OVERLAP);
  const id = stableId('band', lane.id, order + 1, q.x, q.y);
  return {
    id,
    laneId: lane.id,
    center: {
      x: Number(q.x.toFixed(2)),
      y: Number(q.y.toFixed(2)),
      frame: 'image_px',
      provenance: { origin: 'derived', imageMaterialId, derivationId, method: 'band.profilePeak' },
    },
    halfWidthPx: Number(shape.halfWidthPx.toFixed(2)),
    lateralHalfWidthPx: shape.lateralHalfWidthPx,
    peakAbsorbance: shape.peakAbsorbance,
    saturated: shape.saturated,
    saturatedPlateauPx: shape.plateauPx,
    tailingAsymmetry: shape.tailingAsymmetry,
    overlapGroupId: overlapId,
    migrationS: { value: Number(shape.peakS.toFixed(2)), unit: 'pixel', frame: 'lane_arc' },
    status: 'candidate',
    origin: 'auto',
    diagnosticCodes: codes,
  };
}

export function mkDerivation(
  kind: DerivationRecord['kind'],
  ruleVersion: string,
  paramsVersion: string,
  input: unknown,
  parents: string[],
  output: unknown,
): DerivationRecord {
  const inputSummary = hashJson(input);
  const id = derivationId(kind, ruleVersion, paramsVersion, inputSummary, parents);
  return {
    id,
    kind,
    ruleVersion,
    paramsVersion,
    inputSummary,
    parentDerivationIds: [...parents].sort(),
    createdAt: 'deterministic',
    outputJson: JSON.stringify(output),
  };
}

export function imageInputSummary(material: ImageMaterial): string {
  return sha256Hex(`${material.sha256}:${material.acquisition.orientationDegrees}:${material.widthPx}x${material.heightPx}`);
}
