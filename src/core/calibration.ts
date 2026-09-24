import type {
  Band,
  CalibrationParameters,
  CalibrationSegment,
  Diagnostic,
  GelImage,
  InferenceResult,
  LadderBandNominal,
  Lane,
  MassCandidate,
} from './types.ts';
import { GelError } from './errors.ts';
import { buildArcTable, projectToLane, type ArcTable } from './geometry.ts';
import { derivedId, sha256Hex } from './ids.ts';

export interface InferenceRun {
  id: string;
  imageId: string;
  parametersVersion: number;
  segments: CalibrationSegment[];
  results: InferenceResult[];
  runDiagnostics: Diagnostic[];
  inputSummary: string;
  outcome: InferenceResult['outcome'];
}

export interface InferenceInputs {
  image: GelImage;
  lanes: Lane[];
  ladderBands: LadderBandNominal[];
  bands: Band[];
  parameters: CalibrationParameters;
  /** 触发父级（事件 id / 材料 id），进入 provenance。 */
  parents: string[];
}

interface LadderMark extends LadderBandNominal {
  arc: number;
}

const logMass = (m: number) => Math.log(m);

export function inferMolecularWeights(inputs: InferenceInputs): InferenceRun {
  const { image, lanes, ladderBands, bands, parameters } = inputs;

  const incomplete = checkCompleteness(inputs);
  if (incomplete.length) {
    return failRun(inputs, incomplete, 'incomplete');
  }

  const ladderLane = lanes.find((l) => l.isLadder);
  if (!ladderLane) {
    return failRun(inputs, [
      diag('INCOMPLETE_INPUT', '缺少 ladder 泳道指派', { kind: 'project', imageId: image.id }, lanes.map((l) => l.id)),
    ], 'incomplete');
  }

  const budget = { evaluations: 0 };
  const ladderTable = buildArcTable(ladderLane.centerline);
  const marks: LadderMark[] = ladderBands
    .filter((b) => b.laneId === ladderLane.id && !b.missing)
    .map((b) => ({ ...b, arc: projectToLane(ladderTable, b.center).arc }))
    .sort((a, b) => a.arc - b.arc);

  const runDiagnostics: Diagnostic[] = [];
  const missingBands = ladderBands.filter((b) => b.laneId === ladderLane.id && b.missing);
  for (const m of missingBands) {
    runDiagnostics.push(diag('MISSING_LADDER_BAND', `ladder 标称带 ${m.id}（${m.nominal}${m.unit}）缺失，仅允许使用扩展段`, { kind: 'ladder_band', id: m.id, imageId: image.id }, [m.id]));
  }

  // 非单调标尺：沿迁移弧长，分子量必须单调减小，否则语义无解（绝不伪造）。
  for (let i = 1; i < marks.length; i++) {
    if (marks[i].nominal >= marks[i - 1].nominal) {
      return failRun(inputs, [
        ...runDiagnostics,
        diag(
          'NONMONOTONIC_SCALE',
          `非单调标尺：s=${marks[i - 1].arc.toFixed(1)}px 处 ${marks[i - 1].nominal} 与 s=${marks[i].arc.toFixed(1)}px 处 ${marks[i].nominal} 未单调递减`,
          { kind: 'ladder_band', id: marks[i].id, imageId: image.id },
          marks.map((m) => m.id),
        ),
      ], 'no_solution');
    }
  }

  if (marks.length < 2) {
    return failRun(inputs, [
      ...runDiagnostics,
      diag('INCOMPLETE_INPUT', '可用 ladder 带少于 2 条，无法建立任何插值段', { kind: 'lane', id: ladderLane.id, imageId: image.id }, [ladderLane.id]),
    ], 'incomplete');
  }

  const { segments, segDiagnostics } = buildSegments(marks, missingBands.map((m) => m.id), parameters, ladderTable, inputs.parents);
  runDiagnostics.push(...segDiagnostics);

  // 全局 log(MW)~s 线性拟合残差（梯道证据），用于叠加显示拟合残差。
  const globalResidual = globalFitResidual(marks);

  const laneTables = new Map<string, ArcTable>();
  for (const lane of lanes) laneTables.set(lane.id, buildArcTable(lane.centerline));

  const results: InferenceResult[] = [];
  for (const band of bands) {
    if (++budget.evaluations > parameters.maxSegmentEvaluations) {
      return failRun(inputs, [
        diag('BUDGET_EXHAUSTED', `资源预算耗尽：弧段评估超过 ${parameters.maxSegmentEvaluations}`, { kind: 'band', id: band.id, imageId: image.id }, bands.map((b) => b.id)),
      ], 'budget_exhausted');
    }
    results.push(inferBand(band, lanes, laneTables, ladderLane.id, marks, segments, parameters, inputs.parents, image, globalResidual, budget));
  }

  enrichOverlapCandidates(results, inputs);
  const inputSummary = sha256Hex(summaryOf(inputs));
  return {
    id: derivedId("run", [inputSummary, parameters.version, inputs.parents]),
    imageId: image.id,
    parametersVersion: parameters.version,
    segments,
    results,
    runDiagnostics,
    inputSummary,
    outcome: results.some((r) => r.outcome !== 'unique')
      ? results.some((r) => r.outcome === 'candidate_set' || r.outcome === 'interval')
        ? 'candidate_set'
        : (results.find((r) => r.outcome !== 'unique')?.outcome ?? 'unique')
      : 'unique',
  };
}

function checkCompleteness(inputs: InferenceInputs): Diagnostic[] {
  const out: Diagnostic[] = [];
  if (!inputs.image) out.push(diag('INCOMPLETE_INPUT', '缺少原始图像材料', { kind: 'project' }, []));
  if (!inputs.lanes.length) out.push(diag('INCOMPLETE_INPUT', '缺少 lane 边界材料', { kind: 'project', imageId: inputs.image?.id }, []));
  if (!inputs.bands.length) out.push(diag('INCOMPLETE_INPUT', '缺少 band 中心材料', { kind: 'project', imageId: inputs.image?.id }, []));
  if (!inputs.ladderBands.length) out.push(diag('INCOMPLETE_INPUT', '缺少 ladder 标称值材料', { kind: 'project', imageId: inputs.image?.id }, []));
  for (const lane of inputs.lanes) {
    if (lane.centerline.some((p) => !Number.isFinite(p.x) || !Number.isFinite(p.y))) {
      out.push(diag('INCOMPLETE_INPUT', 'lane 曲线存在不可解析坐标（保留原始位置，未做转换）', { kind: 'lane', id: lane.id, imageId: inputs.image?.id }, [lane.id]));
    }
  }
  for (const b of inputs.ladderBands) {
    if (!Number.isFinite(b.nominal) || b.nominal <= 0) {
      out.push(diag('INCOMPLETE_INPUT', 'ladder 标称值无法转换为正数，留在原位置并附诊断', { kind: 'ladder_band', id: b.id, imageId: inputs.image?.id }, [b.id]));
    }
  }
  return out;
}

function failRun(inputs: InferenceInputs, diagnostics: Diagnostic[], outcome: InferenceResult['outcome']): InferenceRun {
  const inputSummary = sha256Hex(summaryOf(inputs));
  return {
    id: derivedId('run', [inputSummary, inputs.parameters.version, inputs.parents]),
    imageId: inputs.image?.id ?? '',
    parametersVersion: inputs.parameters.version,
    segments: [],
    results: [],
    runDiagnostics: diagnostics,
    inputSummary,
    outcome,
  };
}

function diag(
  code: Diagnostic['code'],
  message: string,
  position: NonNullable<Diagnostic['position']>,
  affectedObjectIds: string[],
): Diagnostic {
  return { code, message, position, affectedObjectIds };
}

function summaryOf(inputs: InferenceInputs) {
  return {
    image: inputs.image ? { id: inputs.image.id, w: inputs.image.width, h: inputs.image.height, sat: inputs.image.exposure.saturationLevel } : null,
    lanes: inputs.lanes.map((l) => ({ id: l.id, c: l.centerline, w: l.widthPx, shape: l.shape, ladder: !!l.isLadder })),
    ladder: inputs.ladderBands.map((b) => ({ id: b.id, lane: b.laneId, p: b.center, n: b.nominal, u: b.unit, missing: !!b.missing })),
    bands: inputs.bands.map((b) => ({ id: b.id, lane: b.laneId, p: b.center, st: b.status, iv: b.interval, pi: b.peakIntensity })),
  };
}

/** 局部标尺：每个相邻 ladder 对构成一个插值段，有效区域为该段两端弧长范围。 */
function buildSegments(
  marks: LadderMark[],
  missingIds: string[],
  params: CalibrationParameters,
  ladderTable: ArcTable,
  parents: string[],
): { segments: CalibrationSegment[]; segDiagnostics: Diagnostic[] } {
  const segments: CalibrationSegment[] = [];
  const segDiagnostics: Diagnostic[] = [];
  for (let i = 0; i < marks.length - 1; i++) {
    const a = marks[i];
    const b = marks[i + 1];
    const gapWasMissingBand = missingIds.length > 0;
    const slope = (logMass(b.nominal) - logMass(a.nominal)) / (b.arc - a.arc);
    const intercept = logMass(a.nominal) - slope * a.arc;
    const status: CalibrationSegment['status'] = gapWasMissingBand ? 'extended' : 'valid';
    const id = derivedId('seg', [a.id, b.id, a.arc.toFixed(3), b.arc.toFixed(3), params.version]);
    segments.push({
      id,
      ladderBandA: a.id,
      ladderBandB: b.id,
      validRange: { start: a.arc, end: b.arc, unit: 'px' },
      slope,
      intercept,
      residual: 0,
      status,
    });
    if (status === 'extended') {
      segDiagnostics.push(diag('EXTENDED_SEGMENT', `段 ${id} 跨越 ladder 缺带区域，仅作为扩展段使用，有效区域受限`, { kind: 'segment', id, x: (a.center.x + b.center.x) / 2, y: (a.center.y + b.center.y) / 2 }, [id]));
    }
  }
  // 跨越缺带：若缺带位于首/末端，没有可建立的相邻段，其影响以 MISSING_LADDER_BAND 诊断保留。
  void ladderTable;
  void parents;
  return { segments, segDiagnostics };
}

function globalFitResidual(marks: LadderMark[]): number {
  if (marks.length < 2) return 0;
  const n = marks.length;
  const sx = marks.reduce((s, m) => s + m.arc, 0);
  const sy = marks.reduce((s, m) => s + logMass(m.nominal), 0);
  const sxx = marks.reduce((s, m) => s + m.arc * m.arc, 0);
  const sxy = marks.reduce((s, m) => s + m.arc * logMass(m.nominal), 0);
  const slope = (n * sxy - sx * sy) / (n * sxx - sx * sx);
  const intercept = (sy - slope * sx) / n;
  const rss = marks.reduce((s, m) => s + (logMass(m.nominal) - (slope * m.arc + intercept)) ** 2, 0);
  return Math.sqrt(rss / n);
}

function inferBand(
  band: Band,
  lanes: Lane[],
  laneTables: Map<string, ArcTable>,
  ladderLaneId: string,
  marks: LadderMark[],
  segments: CalibrationSegment[],
  params: CalibrationParameters,
  parents: string[],
  image: GelImage,
  globalResidual: number,
  budget: { evaluations: number },
): InferenceResult {
  const lane = lanes.find((l) => l.id === band.laneId);
  const diagnostics: Diagnostic[] = [];
  const table = laneTables.get(band.laneId);
  const provenance = {
    inputSummary: '',
    parametersVersion: params.version,
    parents: [...parents, band.id, lane?.id ?? ''],
    formula: params.model,
  };

  if (!lane || !table) {
    return resultShell(band, params, parents, 'incomplete', [
      diag('INCOMPLETE_INPUT', `band ${band.id} 找不到所属 lane`, { kind: 'band', id: band.id, imageId: image.id }, [band.id]),
    ]);
  }

  // 迁移对齐：把 band 投影到它自己的泳道曲线得到弧长，再按弧长比例对齐到 ladder。
  // 微笑弯曲时，同样的像素高度在弯曲泳道上对应不同弧长 ⇒ 不同分子量，这就是局部标尺的意义。
  const proj = projectToLane(table, band.center);
  if (proj.normalDistancePx > lane.widthPx / 2) {
    diagnostics.push(diag('OUTSIDE_VALID_RANGE', `band 中心距泳道中心线 ${proj.normalDistancePx.toFixed(1)}px，超出 lane 边界`, { kind: 'band', id: band.id, x: band.center.x, y: band.center.y, imageId: image.id }, [band.id]));
  }

  const total = table.total;
  const ladderTable = laneTables.get(ladderLaneId)!;
  const toLadder = (s: number) => (total > 0 ? (s / total) * ladderTable.total : s);
  const sLadder = toLadder(proj.arc);
  const unit = marks[0]?.unit ?? 'bp';

  const baseId = derivedId('mw', [band.id, sLadder.toFixed(3), params.version, marks.map((m) => [m.id, m.arc.toFixed(2), m.nominal]).flat()]);

  // 饱和条带：只能给区间。
  if (band.status === 'saturated' || (band.peakIntensity ?? 0) >= params.saturationRatio) {
    const range = boundsAt(sLadder, marks, params, true);
    diagnostics.push(diag('SATURATED_BAND', `条带饱和（峰值强度 ${(band.peakIntensity ?? 1).toFixed(3)} ≥ ${params.saturationRatio}），只能给候选/区间`, { kind: 'band', id: band.id, x: band.center.x, y: band.center.y, imageId: image.id }, [band.id]));
    const values: MassCandidate[] = range ? [{ mass: (range.low + range.high) / 2, unit, status: 'bounded', basis: 'saturation_bounds' }] : [];
    return {
      id: baseId, bandId: band.id, laneId: lane.id, values,
      range: range ? { ...range, unit } : undefined, segmentId: nearestSegment(sLadder, segments)?.id ?? null,
      ladderPointIds: nearestLadderPoints(sLadder, marks).map((m) => m.id), unit, diagnostics,
      outcome: 'interval', provenance: withSummary(provenance, band, sLadder),
    };
  }

  // 拖尾/带显式区间：沿区间弧长给全部合法候选。
  if (band.status === 'smeared' || band.interval) {
    const iv = band.interval ?? { start: proj.arc - 3, end: proj.arc + 3, unit: 'px' as const };
    diagnostics.push(diag('SMEARED_BAND', `拖尾/区间条带（${iv.start.toFixed(1)}–${iv.end.toFixed(1)}px），无法唯一决定，保留全部合法候选`, { kind: 'band', id: band.id, x: band.center.x, y: band.center.y, imageId: image.id }, [band.id]));
    const s0 = toLadder(iv.start);
    const s1 = toLadder(iv.end);
    const m0 = massAt(s0, marks, params, diagnostics, image, band, budget);
    const m1 = massAt(s1, marks, params, diagnostics, image, band, budget);
    const low = Math.min(m0?.mass ?? NaN, m1?.mass ?? NaN);
    const high = Math.max(m0?.mass ?? NaN, m1?.mass ?? NaN);
    const seg = nearestSegment((s0 + s1) / 2, segments);
    return {
      id: baseId, bandId: band.id, laneId: lane.id,
      values: Number.isFinite(low) ? [
        { mass: low, unit, status: 'candidate', basis: 'saturation_bounds', segmentId: seg?.id },
        { mass: high, unit, status: 'candidate', basis: 'saturation_bounds', segmentId: seg?.id },
      ] : [],
      range: Number.isFinite(low) ? { low, high, unit } : undefined,
      segmentId: seg?.id ?? null, ladderPointIds: nearestLadderPoints((s0 + s1) / 2, marks).map((m) => m.id),
      unit, diagnostics, outcome: 'candidate_set', provenance: withSummary(provenance, band, (s0 + s1) / 2),
    };
  }

  let hit: { mass: number; basis: MassCandidate['basis'] } | null = null;
  try {
    hit = massAt(sLadder, marks, params, diagnostics, image, band, budget);
  } catch (err) {
    if (err instanceof GelError && err.code === 'BUDGET_EXHAUSTED') throw err;
    throw err;
  }
  if (!hit) {
    return {
      id: baseId, bandId: band.id, laneId: lane.id, values: [], segmentId: null, ladderPointIds: [],
      unit, diagnostics, outcome: 'no_solution', provenance: withSummary(provenance, band, sLadder),
    };
  }

  // 重叠由 enrichOverlapCandidates 基于同 lane 弧距统一补全；此处先给基础候选。
  const seg = nearestSegment(sLadder, segments);
  const isOverlapped = band.status === 'overlapped';
  if (isOverlapped) {
    diagnostics.push(diag('OVERLAPPING_BANDS', `条带标记为重叠（弧距阈值 ${params.overlapGapPx}px），保留全部合法候选`, { kind: 'band', id: band.id, x: band.center.x, y: band.center.y, imageId: image.id }, [band.id]));
  }
  if (seg?.status === 'extended') {
    diagnostics.push(diag('EXTENDED_SEGMENT', '分子量落在跨越 ladder 缺带的扩展段上，标记为候选', { kind: 'segment', id: seg.id }, [seg.id]));
  }
  void globalResidual;
  const candidate = isOverlapped || seg?.status === 'extended';
  return {
    id: baseId, bandId: band.id, laneId: lane.id,
    values: [{ mass: hit.mass, unit, status: candidate ? 'candidate' : 'precise', basis: hit.basis, segmentId: seg?.id }],
    segmentId: seg?.id ?? null, ladderPointIds: nearestLadderPoints(sLadder, marks).map((m) => m.id),
    unit, diagnostics, outcome: candidate ? 'candidate_set' : 'unique',
    provenance: withSummary(provenance, band, sLadder),
  };
}

function withSummary(p: InferenceResult['provenance'], band: Band, sLadder: number) {
  return { ...p, inputSummary: sha256Hex({ band: band.id, s: Number(sLadder.toFixed(3)), v: p.parametersVersion, parents: p.parents }) };
}

function resultShell(
  band: Band,
  params: CalibrationParameters,
  parents: string[],
  outcome: InferenceResult['outcome'],
  diagnostics: Diagnostic[],
): InferenceResult {
  return {
    id: derivedId('mw', [band.id, 'shell', params.version, parents]),
    bandId: band.id, laneId: band.laneId, values: [], segmentId: null, ladderPointIds: [],
    unit: 'bp', diagnostics, outcome,
    provenance: { inputSummary: '', parametersVersion: params.version, parents: [...parents, band.id], formula: params.model },
  };
}

function nearestSegment(s: number, segments: CalibrationSegment[]): CalibrationSegment | undefined {
  let best: CalibrationSegment | undefined;
  let bestD = Infinity;
  for (const seg of segments) {
    if (s >= seg.validRange.start && s <= seg.validRange.end) return seg;
    const d = Math.min(Math.abs(s - seg.validRange.start), Math.abs(s - seg.validRange.end));
    if (d < bestD) { bestD = d; best = seg; }
  }
  return best;
}

function nearestLadderPoints(s: number, marks: LadderMark[]): LadderMark[] {
  if (!marks.length) return [];
  const sorted = [...marks].sort((a, b) => Math.abs(a.arc - s) - Math.abs(b.arc - s));
  return sorted.slice(0, 2);
}

/** 在弧长 s 处用分段线性 log(MW) 求值；超出最近梯道端+余量则无合法解。 */
function massAt(
  s: number,
  marks: LadderMark[],
  params: CalibrationParameters,
  diagnostics: Diagnostic[],
  image: GelImage,
  band: Band,
  budget: { evaluations: number },
): { mass: number; basis: MassCandidate['basis'] } | null {
  if (++budget.evaluations > params.maxSegmentEvaluations) {
    throw GelBudgetError(params.maxSegmentEvaluations);
  }
  const lo = marks[0];
  const hi = marks[marks.length - 1];
  for (let i = 0; i < marks.length - 1; i++) {
    const a = marks[i];
    const b = marks[i + 1];
    if (s >= a.arc && s <= b.arc) {
      const t = (s - a.arc) / (b.arc - a.arc);
      return { mass: Math.exp(logMass(a.nominal) + t * (logMass(b.nominal) - logMass(a.nominal))), basis: 'segment_interpolation' };
    }
  }
  if (s < lo.arc && lo.arc - s <= params.extrapolationMarginPx) {
    const b = marks[1];
    const t = (s - lo.arc) / (b.arc - lo.arc);
    diagnostics.push(diag('EXTENDED_SEGMENT', '弧长位于 ladder 顶端外的外推余量内，使用扩展段', { kind: 'band', id: band.id, x: band.center.x, y: band.center.y, imageId: image.id }, [band.id]));
    return { mass: Math.exp(logMass(lo.nominal) + t * (logMass(b.nominal) - logMass(lo.nominal))), basis: 'extended_segment' };
  }
  if (s > hi.arc && s - hi.arc <= params.extrapolationMarginPx) {
    const a = marks[marks.length - 2];
    const t = (s - hi.arc) / (hi.arc - a.arc);
    diagnostics.push(diag('EXTENDED_SEGMENT', '弧长位于 ladder 底端外的外推余量内，使用扩展段', { kind: 'band', id: band.id, x: band.center.x, y: band.center.y, imageId: image.id }, [band.id]));
    return { mass: Math.exp(logMass(hi.nominal) + t * (logMass(hi.nominal) - logMass(a.nominal))), basis: 'extended_segment' };
  }
  diagnostics.push(diag('OUTSIDE_VALID_RANGE', `弧长 ${s.toFixed(1)}px 超出局部标尺有效区域（外推余量 ${params.extrapolationMarginPx}px）`, { kind: 'band', id: band.id, x: band.center.x, y: band.center.y, imageId: image.id }, [band.id]));
  return null;
}

function boundsAt(
  s: number,
  marks: LadderMark[],
  params: CalibrationParameters,
  _saturated: boolean,
): { low: number; high: number } | null {
  const lo = marks[0];
  const hi = marks[marks.length - 1];
  if (s < lo.arc - params.extrapolationMarginPx || s > hi.arc + params.extrapolationMarginPx) return null;
  // 饱和：以 ±半个外推余量的弧长不确定度给出上下界。
  const mHi = massAtSilent(s - params.extrapolationMarginPx / 2, marks) ?? lo.nominal;
  const mLo = massAtSilent(s + params.extrapolationMarginPx / 2, marks) ?? hi.nominal;
  return { low: Math.min(mLo, mHi), high: Math.max(mLo, mHi) };
}

function massAtSilent(s: number, marks: LadderMark[]): number | null {
  for (let i = 0; i < marks.length - 1; i++) {
    const a = marks[i];
    const b = marks[i + 1];
    if (s >= a.arc && s <= b.arc) {
      const t = (s - a.arc) / (b.arc - a.arc);
      return Math.exp(logMass(a.nominal) + t * (logMass(b.nominal) - logMass(a.nominal)));
    }
  }
  const end = s < marks[0].arc ? marks[0] : marks[marks.length - 1];
  return end.nominal;
}

function GelBudgetError(max: number): GelError {
  return new GelError('BUDGET_EXHAUSTED', `资源预算耗尽：弧段评估超过 ${max}`, { kind: 'parameter' });
}

function collectOverlaps(
  band: Band,
  lanes: Lane[],
  laneTables: Map<string, ArcTable>,
  ladderTable: ArcTable,
  params: CalibrationParameters,
  _budget: { evaluations: number },
): string[] {
  const table = laneTables.get(band.laneId);
  if (!table) return [];
  const sSelf = projectToLane(table, band.center).arc / table.total * ladderTable.total;
  const out: string[] = [];
  // bands from caller via closure is not available here; enrichment handled in enrichOverlapCandidates.
  void lanes;
  void params;
  void sSelf;
  return out;
}

/** 重叠后处理：同一 lane 内弧距小于阈值的条带互为合法候选，全部保留。 */
export function enrichOverlapCandidates(
  results: InferenceResult[],
  inputs: InferenceInputs,
): void {
  const ladderLane = inputs.lanes.find((l) => l.isLadder)!;
  const ladderTable = buildArcTable(ladderLane.centerline);
  const tables = new Map(inputs.lanes.map((l) => [l.id, buildArcTable(l.centerline)]));
  const arcOf = (b: Band) => {
    const t = tables.get(b.laneId)!;
    return projectToLane(t, b.center).arc / t.total * ladderTable.total;
  };
  const byLane = new Map<string, Band[]>();
  for (const b of inputs.bands) {
    if (b.status === 'smeared' || b.status === 'saturated') continue;
    const arr = byLane.get(b.laneId) ?? [];
    arr.push(b);
    byLane.set(b.laneId, arr);
  }
  for (const [laneId, arr] of byLane) {
    for (let i = 0; i < arr.length; i++) {
      for (let j = i + 1; j < arr.length; j++) {
        const gap = Math.abs(arcOf(arr[i]) - arcOf(arr[j]));
        if (gap < inputs.parameters.overlapGapPx) {
          for (const band of [arr[i], arr[j]]) {
            const res = results.find((r) => r.bandId === band.id && r.laneId === laneId);
            const other = band === arr[i] ? arr[j] : arr[i];
            if (!res) continue;
            if (!res.diagnostics.some((d) => d.code === 'OVERLAPPING_BANDS')) {
              res.diagnostics.push(diag('OVERLAPPING_BANDS', `两条带重叠（弧距 ${gap.toFixed(1)} < ${inputs.parameters.overlapGapPx}px）：${arr[i].id}, ${arr[j].id}`, { kind: 'band', id: band.id, imageId: inputs.image.id }, [arr[i].id, arr[j].id]));
            }
            const otherMass = massAtSilent(arcOf(other), sortedMarks(inputs));
            const own = res.values[0]?.mass;
            res.outcome = 'candidate_set';
            const seg = res.segmentId ? { id: res.segmentId } : undefined;
            const vals: MassCandidate[] = [];
            if (Number.isFinite(own)) vals.push({ mass: own!, unit: res.unit, status: 'candidate', basis: 'overlap_set', segmentId: seg?.id });
            if (otherMass != null) vals.push({ mass: otherMass, unit: res.unit, status: 'candidate', basis: 'overlap_set', segmentId: seg?.id });
            res.values = dedupeCandidates(vals);
            const masses = res.values.map((v) => v.mass);
            res.range = { low: Math.min(...masses), high: Math.max(...masses), unit: res.unit };
          }
        }
      }
    }
  }
}

function dedupeCandidates(vals: MassCandidate[]): MassCandidate[] {
  const seen = new Set<number>();
  return vals.filter((v) => {
    const key = Math.round(v.mass * 1000);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function sortedMarks(inputs: InferenceInputs) {
  const ladderLane = inputs.lanes.find((l) => l.isLadder)!;
  const table = buildArcTable(ladderLane.centerline);
  return inputs.ladderBands
    .filter((b) => b.laneId === ladderLane.id && !b.missing)
    .map((b) => ({ ...b, arc: projectToLane(table, b.center).arc }))
    .sort((a, b) => a.arc - b.arc);
}
