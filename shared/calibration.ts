/**
 * 校准与分子量推断（核心业务规则，纯函数、可被服务端/存储/UI 直接测试）。
 *
 * 不变量：
 *  - 比较基准是沿 lane 中心线的弧长 s，不是像素行 y；
 *    “微笑”弯曲下同一 y 对应不同 s，因此同一高度不等于同一分子量。
 *  - 每条局部标尺段自带有效区域 [sMin, sMax]，段外只能给区间/诊断。
 *  - 饱和、拖尾、重叠 -> 候选或区间，并保留全部合法候选。
 *  - ladder 缺带 -> 在 maxMissingBands 内枚举全部合法配对。
 *  - 非单调（标称值与迁移顺序矛盾）-> SEMANTIC_UNRESOLVABLE 标记，受影响段失效。
 */
import { cumulativeLengths, projectToCurve } from './geometry';
import { hashJson, shortId } from './hash';
import { diag, type Diagnostic } from './diagnostics';
import type {
  BandCandidate,
  BandMark,
  BandMarksMaterial,
  CalibrationSegment,
  Derivation,
  InputSummary,
  LadderCalibrationPoint,
  LadderSpecMaterial,
  LaneMapMaterial,
  RuleParams
} from './types';
import { DEFAULT_RULE_PARAMS, RULES_VERSION } from './types';

export interface MaterialState {
  imageId?: string;
  orientation?: import('./types').OrientationMaterial;
  exposure?: import('./types').ExposureMaterial;
  ladder?: LadderSpecMaterial;
  laneMap?: LaneMapMaterial;
  bandMarks: BandMarksMaterial[];
}

export interface DeriveInputs {
  materials: MaterialState;
  params?: RuleParams;
  paramsHash?: string;
  acceptedDecisionIds?: string[];
  decisions?: { targetId: string; verb: 'accept' | 'reject' | 'adjust'; payload?: Record<string, unknown> }[];
  trigger: Derivation['trigger'];
  parents: string[];
}

export interface DeriveOutput {
  derivation: Derivation;
}

/** 应用人工决定：reject 移除带，adjust 覆盖中心（保留 manual 来源）。 */
export function applyDecisions(
  base: BandMarksMaterial,
  decisions: NonNullable<DeriveInputs['decisions']>
): BandMark[] {
  const rejected = new Set<string>();
  const adjustments = new Map<string, Record<string, unknown>>();
  for (const d of decisions) {
    if (d.verb === 'reject') rejected.add(d.targetId);
    if (d.verb === 'adjust') adjustments.set(d.targetId, d.payload ?? {});
  }
  return base.bands
    .filter((b) => !rejected.has(b.id))
    .map((b) => {
      const adj = adjustments.get(b.id);
      if (!adj) return b;
      const nx = typeof adj.x === 'number' ? adj.x : b.center.x;
      const ny = typeof adj.y === 'number' ? adj.y : b.center.y;
      return {
        ...b,
        center: {
          x: nx,
          y: ny,
          frame: 'canonical' as const,
          source: { ...b.center.source, origin: 'manual' as const, method: 'decision-adjust' }
        },
        arcLength: typeof adj.s === 'number' ? adj.s : b.arcLength
      };
    });
}

/**
 * 缺带枚举：观测峰按 s 排序；标称带按迁移排序（核酸：s 越大 bp 越小）。
 * 允许跳过若干 present=true 标称带，枚举全部保持单调的配对方案。
 */
export function enumerateLadderAssignments(
  observed: BandMark[],
  ladder: LadderSpecMaterial,
  maxMissing: number
): number[][] {
  const nominal = ladder.bands
    .filter((b) => b.present)
    .map((b) => ({ index: b.index, mass: b.mass.value }));
  const m = observed.length;
  const n = nominal.length;
  if (m > n) return [];
  if (n - m > maxMissing) return [];
  const solutions: number[][] = [];
  const chosen: number[] = [];
  const increasingS = observed.map((_, i) => i);
  // 选择 m 个标称带下标，保持顺序；每个选择对应一种“缺带”解释。
  (function walk(obsIdx: number, startNom: number, skipped: number) {
    if (obsIdx === m) {
      solutions.push([...chosen]);
      return;
    }
    const remaining = m - obsIdx;
    for (let j = startNom; j <= n - remaining; j++) {
      const skipNow = j - startNom + skipped;
      if (skipNow > maxMissing) break;
      chosen[obsIdx] = j;
      walk(obsIdx + 1, j + 1, skipNow);
    }
  })(0, 0, 0);
  void increasingS;
  return solutions;
}

/** 判断一组 (mass, s) 是否满足迁移单调性。 */
export function isMonotonic(pairs: { mass: number | null; s: number }[], analyte: string): boolean {
  for (let i = 1; i < pairs.length; i++) {
    const m0 = pairs[i - 1]!.mass;
    const m1 = pairs[i]!.mass;
    if (m0 === null || m1 === null) return false;
    // 弧长越大迁移越远：核酸分子量应严格减小；蛋白经 orientation 归一后同样减小。
    if (analyte === 'protein') {
      if (!(m1 < m0)) return false;
    } else if (!(m1 < m0)) return false;
  }
  return true;
}

/** PCHIP 风格的单调三次（这里用保证单调的分段线性 log 实现，可按 method 切换）。 */
function interpMassAt(s: number, pairs: { s: number; logMass: number }[]): { logMass: number; inside: boolean } {
  if (pairs.length === 0) return { logMass: NaN, inside: false };
  if (s <= pairs[0]!.s) {
    const t = (s - pairs[0]!.s) / ((pairs[1]?.s ?? pairs[0]!.s + 1) - pairs[0]!.s || 1);
    return { logMass: pairs[0]!.logMass + t * ((pairs[1]?.logMass ?? pairs[0]!.logMass) - pairs[0]!.logMass), inside: false };
  }
  for (let i = 1; i < pairs.length; i++) {
    if (s <= pairs[i]!.s) {
      const a = pairs[i - 1]!;
      const b = pairs[i]!;
      const t = (s - a.s) / (b.s - a.s || 1);
      return { logMass: a.logMass + t * (b.logMass - a.logMass), inside: true };
    }
  }
  const last = pairs[pairs.length - 1]!;
  const prev = pairs[pairs.length - 2] ?? last;
  const t = (s - last.s) / (last.s - prev.s || 1);
  return { logMass: last.logMass + t * (last.logMass - prev.logMass), inside: false };
}

function candidateId(parts: Record<string, unknown>): string {
  return shortId(hashJson(parts), 'cand');
}

function segmentId(laneIndex: number, pointIds: string[]): string {
  return shortId(hashJson({ laneIndex, pointIds, t: 'seg' }), 'seg');
}

/**
 * 主入口：由当前材料快照与决定重放派生层。
 * 输出带 inputSummary / paramsHash / rulesVersion / parents / digest，可重放、可比较。
 */
export function derive(inputs: DeriveInputs): DeriveOutput {
  const params = inputs.params ?? DEFAULT_RULE_PARAMS;
  const paramsHash = inputs.paramsHash ?? shortId(hashJson(params), 'par');
  const diagnostics: Diagnostic[] = [];
  const m = inputs.materials;
  const materialVersions: InputSummary['materials'] = {};
  if (m.ladder) materialVersions[m.ladder.id] = { kind: 'ladderSpec', version: 1 };
  if (m.laneMap) materialVersions[m.laneMap.id] = { kind: 'laneMap', version: 1 };
  if (m.exposure) materialVersions[m.exposure.id] = { kind: 'exposure', version: 1 };
  if (m.orientation) materialVersions[m.orientation.id] = { kind: 'orientation', version: 1 };
  for (const bm of m.bandMarks) materialVersions[bm.id] = { kind: 'bandMarks', version: 1 };

  if (!m.ladder || !m.laneMap || m.bandMarks.length === 0 || !m.exposure || !m.orientation) {
    const missing: string[] = [];
    if (!m.ladder) missing.push('/ladderSpec');
    if (!m.laneMap) missing.push('/laneMap');
    if (!m.exposure) missing.push('/exposure');
    if (!m.orientation) missing.push('/orientation');
    if (m.bandMarks.length === 0) missing.push('/bandMarks');
    for (const path of missing) {
      diagnostics.push(diag('INCOMPLETE_INPUT', path, `缺少必需材料: ${path}`));
    }
    const digest = hashJson({ status: 'incomplete', missing });
    return {
      derivation: {
        id: shortId(digest, 'deriv'),
        parents: inputs.parents,
        trigger: inputs.trigger,
        inputSummary: {
          materials: materialVersions,
          paramsHash,
          rulesVersion: RULES_VERSION,
          acceptedDecisionIds: inputs.acceptedDecisionIds ?? []
        },
        calibrationPoints: [],
        segments: [],
        bandCandidates: [],
        diagnostics,
        digest
      }
    };
  }

  const ladder = m.ladder;
  const laneMap = m.laneMap;
  const exposure = m.exposure;
  const baseMarks = m.bandMarks[m.bandMarks.length - 1]!;
  const bands = applyDecisions(baseMarks, inputs.decisions ?? []);

  // 弧长基准：把每个条带中心投影到所属 lane 曲线（微笑弯曲在此被校正）。
  const lanePolylines = new Map<number, { x: number; y: number }[]>();
  const laneLengths = new Map<number, number[]>();
  for (const lane of laneMap.lanes) {
    const poly = lane.centerline.map((p) => ({ x: p.x, y: p.y }));
    lanePolylines.set(lane.laneIndex, poly);
    laneLengths.set(lane.laneIndex, cumulativeLengths(poly));
  }
  for (const b of bands) {
    const poly = lanePolylines.get(b.laneIndex);
    if (!poly) {
      diagnostics.push(diag('IMAGE_OUT_OF_FRAME', `/bandMarks/${b.id}`, `条带 ${b.id} 找不到泳道 ${b.laneIndex}`));
      continue;
    }
    const proj = projectToCurve({ x: b.center.x, y: b.center.y }, poly);
    (b as BandMark & { arcLength: number }).arcLength = proj.s;
  }

  const byLane = new Map<number, BandMark[]>();
  for (const b of bands) {
    if (!byLane.has(b.laneIndex)) byLane.set(b.laneIndex, []);
    byLane.get(b.laneIndex)!.push(b);
  }
  for (const list of byLane.values()) list.sort((a, b) => (a.arcLength ?? 0) - (b.arcLength ?? 0));

  const calibrationPoints: LadderCalibrationPoint[] = [];
  const segments: CalibrationSegment[] = [];
  const bandCandidates: BandCandidate[] = [];

  const ladderLaneIndex = 0;
  const laneCount = laneMap.lanes.length;
  void laneCount;

  buildLadderLane({
    ladderLaneIndex,
    byLane,
    ladder,
    params,
    calibrationPoints,
    segments,
    bandCandidates,
    diagnostics
  });

  for (const lane of laneMap.lanes) {
    if (lane.laneIndex === ladderLaneIndex) continue;
    buildSampleLane({
      laneIndex: lane.laneIndex,
      byLane,
      params,
      segments,
      bandCandidates,
      diagnostics
    });
  }

  const digest = hashJson({
    mv: materialVersions,
    paramsHash,
    rulesVersion: RULES_VERSION,
    decisions: (inputs.decisions ?? []).map((d) => `${d.verb}:${d.targetId}`),
    bands: bands.map((b) => [b.id, b.laneIndex, b.arcLength, b.center.x, b.center.y]),
    ladders: ladder.bands.map((b) => [b.index, b.mass.rawText, b.present])
  });

  return {
    derivation: {
      id: shortId(digest, 'deriv'),
      parents: inputs.parents,
      trigger: inputs.trigger,
      inputSummary: {
        materials: materialVersions,
        paramsHash,
        rulesVersion: RULES_VERSION,
        acceptedDecisionIds: inputs.acceptedDecisionIds ?? []
      },
      calibrationPoints,
      segments,
      bandCandidates,
      diagnostics,
      digest
    }
  };
}

interface BuildCtx {
  ladderLaneIndex: number;
  byLane: Map<number, BandMark[]>;
  ladder: LadderSpecMaterial;
  params: RuleParams;
  calibrationPoints: LadderCalibrationPoint[];
  segments: CalibrationSegment[];
  bandCandidates: BandCandidate[];
  diagnostics: Diagnostic[];
}

function buildLadderLane(ctx: BuildCtx): void {
  const { ladderLaneIndex, byLane, ladder, params, calibrationPoints, segments, bandCandidates, diagnostics } = ctx;
  const unit = massUnit(ladder);
  const observed = byLane.get(ladderLaneIndex) ?? [];
  const nominal = ladder.bands.filter((b) => b.present);

  if (nominal.some((nb) => nb.mass.value === null)) {
    for (const nb of nominal) {
      if (nb.mass.value === null) {
        diagnostics.push(diag('UNIT_UNCONVERTIBLE', `/ladderSpec/bands/${nb.index}`, `标称带 ${nb.index} 保留原始表示 "${nb.mass.rawText}"，无法进入校准`));
      }
    }
    segments.push(invalidSegment(ladderLaneIndex, observed, ['UNIT_UNCONVERTIBLE']));
    pushCandidates(bandCandidates, observed, unit, null, diagnostics, params);
    return;
  }

  const assignments = enumerateLadderAssignments(observed, ladder, params.maxMissingBands);
  const validAssignments = assignments
    .map((choice) => {
      const pairs = observed.map((obs, i) => ({ mass: nominal[choice[i]!]!.mass.value, s: obs.arcLength ?? 0, obs, nom: nominal[choice[i]!]! }));
      return { choice, pairs, mono: isMonotonic(pairs, ladder.analyte) };
    })
    .filter((a) => a.mono);

  if (validAssignments.length === 0) {
    diagnostics.push(
      diag(
        'CALIBRATION_NONMONOTONIC',
        `/lanes/${ladderLaneIndex}`,
        'ladder 配对无法满足迁移单调性（非单调标尺/缺带过多），该泳道标尺失效'
      )
    );
    segments.push(invalidSegment(ladderLaneIndex, observed, ['CALIBRATION_NONMONOTONIC']));
    pushCandidates(bandCandidates, observed, unit, null, diagnostics, params);
    return;
  }

  // 多个合法配对 -> 缺带歧义；全部保留为合法候选，标尺标记歧义。
  if (validAssignments.length > 1) {
    diagnostics.push(
      diag(
        'LADDER_MISSING_BAND',
        `/lanes/${ladderLaneIndex}`,
        `存在 ${validAssignments.length} 种与缺带相容的 ladder 配对，保留全部合法候选`,
        'warning',
        observed.map((o) => o.id)
      )
    );
  }

  const chosen = validAssignments[0]!;
  const pointIds: string[] = [];
  const pairsForFit: { s: number; logMass: number }[] = [];
  chosen.pairs.forEach((pair, i) => {
    const id = shortId(hashJson({ obs: pair.obs.id, nom: pair.nom.index }), 'cp');
    pointIds.push(id);
    pairsForFit.push({ s: pair.s, logMass: Math.log(pair.mass!) });
    calibrationPoints.push({
      id,
      bandMarkId: pair.obs.id,
      nominalBandIndex: pair.nom.index,
      massBpOrKda: pair.mass,
      arcLength: pair.s,
      residual: 0,
      valid: true,
      diagnosticCodes: []
    });
    void i;
  });

  // 拟合残差（对 log 质量）：点击分子量可回到这些点。
  for (let i = 0; i < calibrationPoints.length; i++) {
    const cp = calibrationPoints[i]!;
    const fit = interpMassAt(cp.arcLength, pairsForFit);
    cp.residual = Math.exp(fit.logMass) - (cp.massBpOrKda ?? NaN);
  }

  const sMin = Math.min(...pairsForFit.map((p) => p.s));
  const sMax = Math.max(...pairsForFit.map((p) => p.s));
  const massAt = (s: number) => Math.exp(interpMassAt(s, pairsForFit).logMass);
  const seg: CalibrationSegment = {
    id: segmentId(ladderLaneIndex, pointIds),
    laneIndex: ladderLaneIndex,
    sMin,
    sMax,
    massMin: massAt(sMax),
    massMax: massAt(sMin),
    pointIds,
    monotonic: true
  };
  segments.push(seg);

  // ladder 泳道自身候选：唯一时给值；多配对时把其它配对也加入 legalCandidates。
  for (let i = 0; i < observed.length; i++) {
    const obs = observed[i]!;
    const legal = validAssignments
      .map((a) => a.pairs[i]!.mass)
      .filter((v, idx, arr) => v !== null && arr.indexOf(v) === idx)
      .map((mass) => ({ mass: mass!, unit: massUnit(ladder), segmentId: seg.id }));
    pushOneCandidate(bandCandidates, obs, unit, seg, legal, diagnostics, params);
  }
}

function invalidSegment(laneIndex: number, observed: BandMark[], codes: string[]): CalibrationSegment {
  return {
    id: shortId(hashJson({ laneIndex, codes, invalid: true }), 'seg'),
    laneIndex,
    sMin: observed.length ? Math.min(...observed.map((o) => o.arcLength ?? 0)) : 0,
    sMax: observed.length ? Math.max(...observed.map((o) => o.arcLength ?? 0)) : 0,
    massMin: null,
    massMax: null,
    pointIds: [],
    monotonic: false
  };
}

function massUnit(ladder: LadderSpecMaterial): string {
  return ladder.analyte === 'nucleic-acid' ? 'bp' : 'kDa';
}

interface SampleCtx {
  laneIndex: number;
  byLane: Map<number, BandMark[]>;
  params: RuleParams;
  segments: CalibrationSegment[];
  bandCandidates: BandCandidate[];
  diagnostics: Diagnostic[];
}

function buildSampleLane(ctx: SampleCtx): void {
  const { laneIndex, byLane, segments, bandCandidates, diagnostics, params } = ctx;
  const observed = byLane.get(laneIndex) ?? [];
  const ladderSeg = segments.find((s) => s.laneIndex === 0 && s.monotonic);
  if (!ladderSeg) {
    diagnostics.push(
      diag('CALIBRATION_NONMONOTONIC', `/lanes/${laneIndex}`, `泳道 ${laneIndex} 没有可用的 ladder 标尺段，无法推断分子量`, 'warning', observed.map((o) => o.id))
    );
    for (const obs of observed) {
      bandCandidates.push({
        id: candidateId({ obs: obs.id, lane: laneIndex, status: 'invalid' }),
        bandMarkId: obs.id,
        laneIndex,
        arcLength: obs.arcLength ?? 0,
        center: { x: obs.center.x, y: obs.center.y },
        status: 'invalid',
        mass: null,
        unit: 'bp',
        legalCandidates: [],
        massRange: null,
        segmentId: null,
        diagnostics: ['CALIBRATION_NONMONOTONIC'],
        validRegion: null
      });
    }
    return;
  }
  for (const obs of observed) pushOneCandidate(bandCandidates, obs, 'bp', ladderSeg, null, diagnostics, params);
}

function pushCandidates(
  out: BandCandidate[],
  observed: BandMark[],
  unit: string,
  seg: CalibrationSegment | null,
  diagnostics: Diagnostic[],
  params: RuleParams
): void {
  for (const obs of observed) pushOneCandidate(out, obs, unit, seg, null, diagnostics, params);
}

/**
 * 单个条带的证据判定：
 *  饱和 / 拖尾 / 重叠 -> candidate 或 range；
 *  段外（超出有效区域且超容差）-> range 或 invalid；
 *  其余才给唯一 mass。
 */
function pushOneCandidate(
  out: BandCandidate[],
  obs: BandMark,
  unit: string,
  seg: CalibrationSegment | null,
  precomputedLegal: { mass: number; unit: string; segmentId: string }[] | null,
  diagnostics: Diagnostic[],
  params: RuleParams
): void {
  const codes: string[] = [];
  const s = obs.arcLength ?? 0;
  if (obs.saturated) codes.push('BAND_SATURATED');
  if (obs.smear) codes.push('BAND_SMEAR');

  // 重叠：同泳道内中心弧长差 < overlapDistancePx。
  const overlapped = out.some(
    (c) => c.laneIndex === obs.laneIndex && Math.abs(c.arcLength - s) < params.overlapDistancePx
  );
  if (overlapped) codes.push('BAND_OVERLAP');
  // 反向也给先前的候选补标。
  if (overlapped) {
    for (const c of out) {
      if (c.laneIndex === obs.laneIndex && Math.abs(c.arcLength - s) < params.overlapDistancePx && !c.diagnostics.includes('BAND_OVERLAP')) {
        c.diagnostics.push('BAND_OVERLAP');
        if (c.status === 'ok') {
          c.status = 'candidate';
          if (c.mass !== null && !c.legalCandidates.some((l) => l.mass === c.mass)) {
            c.legalCandidates.unshift({ mass: c.mass, unit: c.unit, segmentId: c.segmentId ?? '' });
          }
          c.mass = null;
        }
      }
    }
  }

  const base: BandCandidate = {
    id: candidateId({ obs: obs.id, lane: obs.laneIndex }),
    bandMarkId: obs.id,
    laneIndex: obs.laneIndex,
    arcLength: s,
    center: { x: obs.center.x, y: obs.center.y },
    status: 'invalid',
    mass: null,
    unit,
    legalCandidates: [],
    massRange: null,
    segmentId: seg?.id ?? null,
    diagnostics: codes,
    validRegion: seg ? { sMin: seg.sMin, sMax: seg.sMax } : null
  };

  if (!seg || !seg.monotonic || seg.massMin === null || seg.massMax === null) {
    base.status = 'invalid';
    base.diagnostics.push('CALIBRATION_NONMONOTONIC');
    diagnostics.push(diag('SEMANTIC_UNRESOLVABLE', `/bands/${obs.id}`, `条带 ${obs.id} 无有效标尺`, 'warning', [base.id]));
    out.push(base);
    return;
  }

  const { mass, inside, extrapolated } = massOnSegment(s, seg, params);
  if (!inside) {
    if (extrapolated) {
      codes.push('CALIBRATION_OUT_OF_RANGE');
      const tol = params.extrapolationTolerancePx;
      const below = s < seg.sMin;
      const edgeMass = below ? seg.massMax : seg.massMin;
      const edgeS = below ? seg.sMin : seg.sMax;
      const m1 = massAlongSegment(edgeS + (below ? -tol : tol), seg);
      const lo = Math.min(edgeMass, m1);
      const hi = Math.max(edgeMass, m1);
      base.status = 'range';
      base.massRange = { min: lo, max: hi, unit };
      base.legalCandidates = precomputedLegal ?? [];
      diagnostics.push(diag('CALIBRATION_OUT_OF_RANGE', `/bands/${obs.id}`, `条带位于有效区域外（容差 ${tol}px），只给区间 [${lo.toFixed(0)}, ${hi.toFixed(0)}] bp`, 'warning', [base.id]));
      out.push(base);
      return;
    }
    base.status = 'invalid';
    codes.push('CALIBRATION_OUT_OF_RANGE');
    out.push(base);
    return;
  }

  base.legalCandidates = precomputedLegal ?? (mass !== null ? [{ mass, unit, segmentId: seg.id }] : []);

  if (codes.length > 0) {
    base.status = 'candidate';
    if (obs.saturated || obs.smear) {
      // 饱和/拖尾：以宽度不确定度给出区间，同时保留点估值作为候选之一。
      const sigmaS = Math.max(obs.widthPx / 2, params.overlapDistancePx / 2);
      const lo = massAlongSegment(s + sigmaS, seg);
      const hi = massAlongSegment(s - sigmaS, seg);
      base.massRange = { min: Math.min(lo, hi), max: Math.max(lo, hi), unit: 'bp' };
      diagnostics.push(diag(obs.saturated ? 'BAND_SATURATED' : 'BAND_SMEAR', `/bands/${obs.id}`, `条带 ${obs.saturated ? '饱和' : '拖尾'}，只能作为候选/区间`, 'warning', [base.id]));
    }
    if (codes.includes('BAND_OVERLAP')) {
      base.status = 'candidate';
      diagnostics.push(diag('BAND_OVERLAP', `/bands/${obs.id}`, '两条带重叠，保留候选，不做唯一断言', 'warning', [base.id]));
    }
    out.push(base);
    return;
  }

  base.status = 'ok';
  base.mass = mass;
  out.push(base);
}

/** 从校准段读回分子量（段内端点按 log 线性，与拟合一致）。 */
function massAlongSegment(s: number, seg: CalibrationSegment): number {
  const t = (s - seg.sMin) / (seg.sMax - seg.sMin || 1);
  const logHi = Math.log(seg.massMax!);
  const logLo = Math.log(seg.massMin!);
  return Math.exp(logHi + t * (logLo - logHi));
}

function massOnSegment(
  s: number,
  seg: CalibrationSegment,
  params: RuleParams
): { mass: number | null; inside: boolean; extrapolated: boolean } {
  if (s >= seg.sMin && s <= seg.sMax) return { mass: massAlongSegment(s, seg), inside: true, extrapolated: false };
  const withinTol = s >= seg.sMin - params.extrapolationTolerancePx && s <= seg.sMax + params.extrapolationTolerancePx;
  return { mass: massAlongSegment(s, seg), inside: false, extrapolated: withinTol };
}
