import type {
  AnalysisResult,
  BandMaterial,
  ComputeBudget,
  Diagnostic,
  ExposureMaterial,
  LaneMaterial,
  LadderCalibrationResult,
  LaneProjectionResult,
  LadderNominalMaterial,
  MwInferenceResult,
  OrientationMaterial,
  ParamSet,
  ProjectState
} from './types';
import { DEFAULT_BUDGET, GelBenchError } from './types';
import type { ImageMaterial } from './types';
import { bendAmount, projectToPolyline, rotateGray } from './geometry';
import { laneProfile } from './image-analysis';
import { buildSegments, inferMw, residuals, validRange, type LadderPoint } from './calibration';
import { stableId } from './hash';
import { currentParams, singleMaterial } from './state';

/**
 * 分析引擎（可被测试直接调用，不依赖浏览器）。
 * 输出全部结果带 inputSummary / paramVersion / parents / basisEventId；
 * 输入不完整 => 只返回带位置的诊断（incomplete-input），绝不以默认值伪装成功。
 */

export interface EngineContext {
  getImageBytes: (sha256: string) => Uint8Array | null;
  decodePng: (bytes: Uint8Array) => { gray: Uint8Array; width: number; height: number };
  budget?: ComputeBudget;
}

export interface AnalyzeOutput {
  results: AnalysisResult[];
  diagnostics: Diagnostic[];
}

export function analyze(
  state: ProjectState,
  branchId: string,
  basisEventId: string,
  ctx: EngineContext
): AnalyzeOutput {
  const budget = ctx.budget ?? DEFAULT_BUDGET;
  const image = singleMaterial<ImageMaterial>(state, 'image');
  const orientation = singleMaterial<OrientationMaterial>(state, 'orientation', image?.id);
  const exposure = singleMaterial<ExposureMaterial>(state, 'exposure', image?.id);
  const nominal = singleMaterial<LadderNominalMaterial>(state, 'ladderNominal', image?.id);
  const param = currentParams(state);

  const pre: Diagnostic[] = [];
  if (!image) pre.push({ code: 'MISSING_ORIENTATION', message: '缺少原始图像材料', location: null });
  if (image && !orientation) {
    pre.push({ code: 'MISSING_ORIENTATION', message: '缺少拍摄方向材料，无法确定“电泳向下”', location: { kind: 'material', materialId: image.id } });
  }
  if (image && !exposure) {
    pre.push({ code: 'MISSING_EXPOSURE', message: '缺少曝光材料，饱和判定不可用', location: { kind: 'material', materialId: image.id } });
  }
  if (exposure && exposure.saturationLevel === null) {
    pre.push({ code: 'MISSING_SATURATION_LEVEL', message: '曝光材料缺少饱和电平；饱和条带只能保守标为候选', location: { kind: 'material', materialId: exposure.id } });
  }
  if (!nominal) {
    pre.push({ code: 'UNCONVERTIBLE_VALUE', message: '缺少 ladder 标称值材料', location: null });
  } else {
    for (const entry of nominal.entries) {
      if (entry.mass === null) {
        pre.push({
          code: 'UNCONVERTIBLE_VALUE',
          message: `ladder 标称值第 ${entry.row} 行 "${entry.token}" 无法转换为数值，保留在原位`,
          location: { kind: 'row', materialId: nominal.id, row: entry.row }
        });
      }
    }
  }
  if (!param) {
    pre.push({ code: 'MISSING_EXPOSURE', message: '缺少分析参数版本', location: { kind: 'parameter', name: 'paramSet' } });
  }
  if (state.lanes.length === 0) {
    pre.push({ code: 'MISSING_ORIENTATION', message: '缺少 lane 边界材料', location: null });
  }
  if (pre.length > 0 || !image || !orientation || !param) {
    const head = header(state, branchId, basisEventId, 'diagnostics', param, {}, [], pre);
    return { results: [{ ...head, kind: 'diagnostics', diagnostics: pre }], diagnostics: pre };
  }

  const bytes = ctx.getImageBytes(image.sha256);
  if (!bytes) throw new GelBenchError('semantic-unresolvable', `图像字节缺失：${image.sha256}`);
  const decoded = ctx.decodePng(bytes);
  const oriented = rotateGray(decoded.gray, decoded.width, decoded.height, orientation.rotation90);
  const gray = oriented.gray;
  const w = oriented.width;
  const h = oriented.height;
  if (w * h > budget.maxPixels) {
    throw new GelBenchError('budget-exhausted', `像素数 ${w * h} 超出预算 ${budget.maxPixels}`, [
      { code: 'BUDGET_EXHAUSTED', message: `maxPixels=${budget.maxPixels}`, location: { kind: 'parameter', name: 'maxPixels' } }
    ]);
  }

  const lanes = state.lanes as unknown as LaneMaterial[];
  const bands = state.bands as unknown as BandMaterial[];
  const materialDigest = digestMaterials([image, orientation, exposure, nominal, ...lanes, ...bands]);
  const results: AnalysisResult[] = [];
  const allDiag: Diagnostic[] = [];

  const ladderLane = lanes.find((l) => l.role === 'ladder') ?? null;
  let calib: LadderCalibrationResult | null = null;

  if (ladderLane && nominal) {
    calib = buildCalibration(state, branchId, basisEventId, ladderLane, bands.filter((b) => b.laneId === ladderLane.id), nominal, param, materialDigest);
    results.push(calib);
    allDiag.push(...calib.diagnostics);
  }

  for (const lane of lanes) {
    const laneBands = bands.filter((b) => b.laneId === lane.id);
    const proj = projectLane(state, branchId, basisEventId, lane, laneBands, param, materialDigest);
    results.push(proj);
    allDiag.push(...proj.diagnostics);

    if (lane.role === 'sample' && calib) {
      const halfWidth = Math.max(2, Math.round(lane.widthPx / 2)) - 1;
      const profile = safeProfile(gray, w, h, lane, halfWidth, budget);
      for (const band of laneBands) {
        const inferred = inferBand(state, branchId, basisEventId, lane, band, calib, param, materialDigest, exposure, profile);
        results.push(inferred);
        allDiag.push(...inferred.diagnostics);
      }
    }
  }

  return { results, diagnostics: allDiag };
}

function safeProfile(
  gray: Uint8Array,
  w: number,
  h: number,
  lane: LaneMaterial,
  halfWidth: number,
  budget: ComputeBudget
) {
  try {
    return laneProfile(gray, w, h, lane.center, halfWidth, 2, budget);
  } catch (err) {
    if (err instanceof GelBenchError && err.failure === 'budget-exhausted') throw err;
    return [];
  }
}

function projectLane(
  state: ProjectState,
  branchId: string,
  basisEventId: string,
  lane: LaneMaterial,
  laneBands: BandMaterial[],
  param: ParamSet,
  digest: Record<string, string>
): LaneProjectionResult {
  const diagnostics: Diagnostic[] = [];
  const bend = bendAmount(lane.center);
  if (bend > (param.smileTolerancePx ?? 0)) {
    diagnostics.push({
      code: 'SMILE_BEND',
      message: `泳道 "${lane.label ?? lane.laneIndex}" 微笑弯曲 ${bend.toFixed(1)}px > 容许 ${param.smileTolerancePx}px：同一像素高度不等于同一分子量，必须沿曲线取迁移弧长`,
      location: { kind: 'material', materialId: lane.id }
    });
  }
  const bandProjection = laneBands.map((band) => {
    const p = projectToPolyline({ x: band.center.x, y: band.center.y }, lane.center);
    if (Math.abs(p.offsetPx) > lane.widthPx / 2 + 4) {
      diagnostics.push({
        code: 'SMILE_BEND',
        message: `条带 ${band.id} 偏离泳道中心 ${p.offsetPx.toFixed(1)}px，可能属于相邻泳道`,
        location: { kind: 'pixel', imageId: lane.imageId, x: band.center.x, y: band.center.y }
      });
    }
    return { bandId: band.id, center: band.center, t: p.t, offsetPx: p.offsetPx };
  });
  const head = header(state, branchId, basisEventId, 'laneProjection', param, digest, [lane.id, ...laneBands.map((b) => b.id)], diagnostics, 'lp', lane.id);
  return { ...head, kind: 'laneProjection', laneId: lane.id, bandProjection, diagnostics };
}

function buildCalibration(
  state: ProjectState,
  branchId: string,
  basisEventId: string,
  lane: LaneMaterial,
  ladderBands: BandMaterial[],
  nominal: LadderNominalMaterial,
  param: ParamSet,
  digest: Record<string, string>
): LadderCalibrationResult {
  const diagnostics: Diagnostic[] = [];
  const usableEntries = nominal.entries.filter((e) => e.mass !== null && e.unit !== null);
  const points: LadderPoint[] = [];
  const matchedBands = new Set<string>();

  for (const entry of usableEntries) {
    const matches = ladderBands.filter((b) => b.nominalCandidates.some((c) => c.entryRow === entry.row));
    if (matches.length === 0) {
      diagnostics.push({
        code: 'LADDER_MISSING_BAND',
        message: `ladder 缺带：标称 ${entry.mass}${entry.unit}（第 ${entry.row} 行）未检出对应条带，跨越该区段的标尺无锚点`,
        location: { kind: 'row', materialId: nominal.id, row: entry.row }
      });
      continue;
    }
    if (matches.length > 1) {
      diagnostics.push({
        code: 'BAND_OVERLAP',
        message: `ladder 标称 ${entry.mass}${entry.unit} 有 ${matches.length} 个候选条带，按迁移顺序取最接近者，其余保留为歧义`,
        location: { kind: 'row', materialId: nominal.id, row: entry.row }
      });
    }
    const band = matches.sort((a, b) => a.center.y - b.center.y)[0];
    matchedBands.add(band.id);
    const p = projectToPolyline({ x: band.center.x, y: band.center.y }, lane.center);
    points.push({ ladderBandId: band.id, t: p.t, mass: entry.mass as number, unit: entry.unit as UnitMassType });
  }

  const { segments, diagnostics: segDiag } = buildSegments(points, param);
  diagnostics.push(...segDiag);
  const range = validRange(segments);
  if (!range) {
    diagnostics.push({ code: 'LADDER_NO_VALID_SEGMENT', message: '标尺没有任何有效段，分子量推断将整体语义无解', location: { kind: 'material', materialId: lane.id } });
  }
  const head = header(state, branchId, basisEventId, 'ladderCalibration', param, digest, [lane.id, nominal.id, ...points.map((p) => p.ladderBandId)], diagnostics, 'lc', lane.id);
  return {
    ...head,
    kind: 'ladderCalibration',
    laneId: lane.id,
    ladderNominalId: nominal.id,
    segments,
    residuals: residuals(points, segments),
    validTRange: range,
    diagnostics
  };
}

type UnitMassType = import('./types').UnitMass;

function inferBand(
  state: ProjectState,
  branchId: string,
  basisEventId: string,
  lane: LaneMaterial,
  band: BandMaterial,
  calib: LadderCalibrationResult,
  param: ParamSet,
  digest: Record<string, string>,
  exposure: ExposureMaterial | null,
  profile: { t: number; v: number }[]
): MwInferenceResult {
  const projection = projectToPolyline({ x: band.center.x, y: band.center.y }, lane.center);
  const diagnostics: Diagnostic[] = [];

  const bend = bendAmount(lane.center);
  if (bend > (param.smileTolerancePx ?? 0)) {
    diagnostics.push({
      code: 'SMILE_BEND',
      message: `分子量沿弯曲泳道弧长 t=${projection.t.toFixed(1)}px 取值，不使用像素高度`,
      location: { kind: 'material', materialId: lane.id }
    });
  }
  if (calib.validTRange && (projection.t < calib.validTRange.low || projection.t > calib.validTRange.high) && !param.extrapolate) {
    diagnostics.push({
      code: 'LOCAL_RULER_INVALIDATED',
      message: `局部标尺在 t=${projection.t.toFixed(1)}px 处失效（有效区域 ${calib.validTRange.low.toFixed(1)}..${calib.validTRange.high.toFixed(1)}px）：缺带或非单调使该段无锚点`,
      location: { kind: 'pixel', imageId: lane.imageId, x: band.center.x, y: band.center.y }
    });
  }

  let ambiguous: { mass: number; reason: string }[] | undefined;
  if (band.flags.includes('overlap')) {
    const nearby = calib.segments.filter((s) => s.valid);
    ambiguous = band.nominalCandidates
      .filter((c) => c.unit === nominalUnit(calib))
      .map((c) => ({ mass: c.mass, reason: '重叠条带的标称候选' }));
    void nearby;
    if (ambiguous.length < 2) {
      const seg = calib.segments.find((s) => s.valid && projection.t >= s.tLow && projection.t <= s.tHigh);
      if (seg) {
        const center = Math.pow(10, seg.a * projection.t + seg.b);
        ambiguous = [
          { mass: center * 1.06, reason: '重叠双峰：上沿候选' },
          { mass: center / 1.06, reason: '重叠双峰：下沿候选' }
        ];
      }
    }
  }
  void profile;
  void exposure;

  const { candidates, diagnostics: inferDiag } = inferMw({
    t: projection.t,
    fwhmPx: band.fwhmPx,
    saturated: band.saturated,
    smeared: band.smeared,
    ambiguousMasses: ambiguous,
    segments: calib.segments,
    param
  });
  diagnostics.push(...inferDiag);

  const decision = state.decisions.get(band.id)
    ? (() => {
        const d = state.decisions.get(band.id)!;
        return { eventId: d.eventId, verdict: d.verdict, chosen: d.chosen };
      })()
    : null;

  const unresolvable = diagnostics.some((d) => d.code === 'LADDER_NO_VALID_SEGMENT' || d.code === 'OUTSIDE_VALID_REGION' || d.code === 'LOCAL_RULER_INVALIDATED');
  const head = header(state, branchId, basisEventId, 'mwInference', param, digest, [band.id, lane.id, calib.id], diagnostics, 'mw', band.id, unresolvable ? 'semantic-unresolvable' : candidates.length === 0 ? 'incomplete-input' : 'ok');
  return { ...head, kind: 'mwInference', bandId: band.id, laneId: lane.id, candidates, decision, diagnostics };
}

function nominalUnit(calib: LadderCalibrationResult): import('./types').UnitMass | null {
  const seg = calib.segments.find((s) => s.valid);
  return seg ? seg.unit : null;
}

function digestMaterials(materials: { id: string; origin: string; supersedes: string | null; raw?: unknown }[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of materials) out[m.id] = stableId('mat', [m.id, m.origin, m.supersedes, m.raw ?? null]);
  return out;
}

function header(
  state: ProjectState,
  branchId: string,
  basisEventId: string,
  kind: AnalysisResult['kind'],
  param: ParamSet | null,
  inputSummary: Record<string, string>,
  parents: string[],
  diagnostics: Diagnostic[],
  idPrefix: string,
  idKey: string,
  statusOverride?: AnalysisResult['status']
): AnalysisResult {
  const status = statusOverride ?? (diagnostics.some((d) => d.code.startsWith('MISSING_')) ? 'incomplete-input' : 'ok');
  const fullDigest = { ...inputSummary };
  fullDigest.__paramVersion = String(param?.version ?? 'none');
  fullDigest.__basis = basisEventId;
  fullDigest.__kind = kind;
  return {
    id: stableId(idPrefix, [state.projectId, branchId, kind, idKey, fullDigest]),
    projectId: state.projectId,
    branchId,
    kind,
    computedAt: 0,
    inputSummary: fullDigest,
    paramVersion: param?.version ?? 0,
    parents,
    basisEventId,
    status
  } as AnalysisResult;
}
