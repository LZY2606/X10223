import {
  buildRuler,
  correctMigration,
  fitLinear,
  frontLevel,
  inferMwAt,
  validRegion,
} from '../shared/calibration';
import type {
  BandCentersPayload,
  BandInference,
  Budget,
  Decision,
  Diagnostic,
  EngineParams,
  ImagePayload,
  LadderPayload,
  LanePayload,
  Material,
  MwResult,
  PipelineResult,
} from '../shared/types';
import { computationId, sha256 } from './digest';

// 计算引擎：纯函数管线，业务规则不依赖浏览器，可被测试直接调用。
// 每个计算结果记录输入摘要、参数版本与父级依赖（由调用方写入事件）。

export interface ResolvedInputs {
  image: Material | null;
  ladder: Material | null;
  lanes: Material[];
  bandCenters: Material[];
}

export function resolveInputs(materials: Material[]): ResolvedInputs {
  return {
    image: materials.find((m) => m.kind === 'image') ?? null,
    ladder: materials.find((m) => m.kind === 'ladder') ?? null,
    lanes: materials.filter((m) => m.kind === 'lane'),
    bandCenters: materials.filter((m) => m.kind === 'band-centers'),
  };
}

export function inputDigestOf(materials: Material[]): string {
  const parts = materials.map((m) => `${m.id}:${m.digest}`).sort();
  return sha256(parts.join('|'));
}

// 拍摄方向归一化：把传感器帧像素映射回标准凝胶朝向（迁移方向为 +y）。
// 仅在坐标映射层生效；材料中的像素来源保持原始基准不变。
export function normalizePoint(
  x: number,
  y: number,
  capture: { orientationDeg: number; flipHorizontal: boolean },
  width: number,
  height: number,
): { x: number; y: number } {
  let nx = x;
  let ny = y;
  if (capture.orientationDeg === 90) {
    nx = y;
    ny = width - 1 - x;
  } else if (capture.orientationDeg === 180) {
    nx = width - 1 - x;
    ny = height - 1 - y;
  } else if (capture.orientationDeg === 270) {
    nx = height - 1 - y;
    ny = x;
  }
  if (capture.flipHorizontal) nx = (capture.orientationDeg % 180 === 0 ? width : height) - 1 - nx;
  return { x: nx, y: ny };
}

function failResult(
  status: PipelineResult['status'],
  materials: Material[],
  params: EngineParams,
  diagnostics: Diagnostic[],
): PipelineResult {
  return {
    status,
    computationId: computationId('mw-inference', params.paramVersion, materials.map((m) => m.id)),
    inputDigest: inputDigestOf(materials),
    paramVersion: params.paramVersion,
    materialIds: materials.map((m) => m.id).sort(),
    imageId: null,
    capture: null,
    unit: 'bp',
    ruler: null,
    bands: [],
    diagnostics,
  };
}

export function runPipeline(
  materials: Material[],
  params: EngineParams,
  budget: Budget,
): PipelineResult {
  const inputs = resolveInputs(materials);
  const diagnostics: Diagnostic[] = [];

  // 输入完整性：缺失即返回带位置的诊断，绝不用空值/默认值伪装成功
  if (!inputs.image) {
    diagnostics.push({
      severity: 'error',
      code: 'MISSING_IMAGE',
      message: '缺少原始凝胶图像材料',
      position: {},
    });
  }
  if (!inputs.ladder) {
    diagnostics.push({
      severity: 'error',
      code: 'MISSING_LADDER',
      message: '缺少 ladder 标称值材料',
      position: {},
    });
  }
  if (inputs.lanes.length === 0) {
    diagnostics.push({
      severity: 'error',
      code: 'MISSING_LANES',
      message: '缺少 lane 边界材料',
      position: {},
    });
  }
  for (const lane of inputs.lanes) {
    const laneId = (lane.payload as LanePayload).laneId;
    if (!inputs.bandCenters.some((b) => (b.payload as BandCentersPayload).laneId === laneId)) {
      diagnostics.push({
        severity: 'error',
        code: 'MISSING_BAND_CENTERS',
        message: `泳道 ${laneId} 缺少条带中心材料`,
        position: { materialId: lane.id, laneId },
      });
    }
  }
  if (diagnostics.some((d) => d.severity === 'error')) {
    return failResult('incomplete_input', materials, params, diagnostics);
  }

  const image = inputs.image!;
  const ladder = inputs.ladder!;
  const imagePayload = image.payload as ImagePayload;
  const ladderPayload = ladder.payload as LadderPayload;

  // 资源预算：耗尽是独立的结果类型
  if (ladderPayload.nominals.length > budget.maxLadderPoints) {
    return failResult('budget_exhausted', materials, params, [
      {
        severity: 'error',
        code: 'BUDGET_EXHAUSTED',
        message: `ladder 标称点 ${ladderPayload.nominals.length} 超过预算 ${budget.maxLadderPoints}`,
        position: { materialId: ladder.id },
      },
    ]);
  }
  const totalBands = inputs.bandCenters.reduce(
    (s, b) => s + (b.payload as BandCentersPayload).bands.length,
    0,
  );
  if (totalBands > budget.maxBands) {
    return failResult('budget_exhausted', materials, params, [
      {
        severity: 'error',
        code: 'BUDGET_EXHAUSTED',
        message: `条带总数 ${totalBands} 超过预算 ${budget.maxBands}`,
        position: {},
      },
    ]);
  }

  if (imagePayload.capture.orientationDeg !== 0 || imagePayload.capture.flipHorizontal) {
    diagnostics.push({
      severity: 'info',
      code: 'ROTATION_NORMALIZED',
      message: `拍摄方向 ${imagePayload.capture.orientationDeg}° 已在坐标映射层归一化，像素来源仍保留原始基准`,
      position: { materialId: image.id },
    });
  }

  const capture = imagePayload.capture;
  const norm = (p: { x: number; y: number }) =>
    normalizePoint(p.x, p.y, capture, imagePayload.width, imagePayload.height);
  const normCurve = (curve: { x: number; y: number }[]) =>
    curve.map((p) => {
      const q = norm(p);
      return { x: q.x, y: q.y, basis: 'image-pixel' as const };
    });

  const laneById = new Map(inputs.lanes.map((l) => [(l.payload as LanePayload).laneId, l]));
  const ladderLane = laneById.get(ladderPayload.laneId);
  if (!ladderLane) {
    return failResult('incomplete_input', materials, params, [
      {
        severity: 'error',
        code: 'LADDER_LANE_NOT_FOUND',
        message: `ladder 引用的泳道 ${ladderPayload.laneId} 不存在`,
        position: { materialId: ladder.id, laneId: ladderPayload.laneId },
      },
    ]);
  }
  const ladderLanePayload = ladderLane.payload as LanePayload;
  const ladderCurve = normCurve(ladderLanePayload.centerCurve);
  const referenceLevel = frontLevel(ladderCurve); // ladder 参考前沿：局部标尺的共同基准
  const ladderBands = inputs.bandCenters.find(
    (b) => (b.payload as BandCentersPayload).laneId === ladderPayload.laneId,
  )!;
  const ladderCenters: Record<string, { x: number; y: number; basis: 'image-pixel' }> = {};
  for (const band of (ladderBands.payload as BandCentersPayload).bands) {
    // ladder 点同样做泳道弯曲校正，与样品泳道共用同一迁移坐标轴
    const p = norm(band.center);
    const corrected = correctMigration(p.y, p.x, ladderCurve, referenceLevel);
    ladderCenters[band.key] = { x: p.x, y: corrected, basis: 'image-pixel' };
  }

  const build = buildRuler(ladderPayload.nominals, ladderCenters, ladderPayload.laneId);
  diagnostics.push(...build.diagnostics);
  const fit = fitLinear(build.points);
  const region = build.runs.length === 1 ? validRegion(build.runs[0]) : null;

  const bands: BandInference[] = [];
  for (const bcMaterial of inputs.bandCenters) {
    const bc = bcMaterial.payload as BandCentersPayload;
    const lane = laneById.get(bc.laneId);
    if (!lane) continue;
    const lanePayload = lane.payload as LanePayload;
    if (bc.laneId === ladderPayload.laneId) continue; // ladder 自身不做样品推断
    const laneCurve = normCurve(lanePayload.centerCurve);
    for (const band of bc.bands) {
      const p = norm(band.center);
      const correctedY = correctMigration(p.y, p.x, laneCurve, referenceLevel);
      const bandDiagnostics: Diagnostic[] = [];
      let result: MwResult;
      if (band.saturated || band.trailing) {
        // 饱和/拖尾：中心不确定，只能给区间
        const tol = params.saturationTolerancePx;
        const loRes = inferMwAt(correctedY + tol, build, { method: params.method, fit, unit: ladderPayload.unit });
        const hiRes = inferMwAt(correctedY - tol, build, { method: params.method, fit, unit: ladderPayload.unit });
        const lo = loRes.kind === 'value' ? loRes.mw : loRes.kind === 'interval' ? loRes.lo : null;
        const hi = hiRes.kind === 'value' ? hiRes.mw : hiRes.kind === 'interval' ? hiRes.hi : null;
        const reason = band.saturated ? 'saturated-center-uncertain' : 'trailing-band-smear';
        result = { kind: 'interval', lo, hi, unit: ladderPayload.unit, reason };
        bandDiagnostics.push({
          severity: 'warning',
          code: band.saturated ? 'SATURATED_CANDIDATE_ONLY' : 'TRAILING_CANDIDATE_ONLY',
          message: `条带 ${band.key} ${band.saturated ? '饱和' : '拖尾'}，中心不确定 ±${tol} px，只能标为区间`,
          position: { materialId: bcMaterial.id, laneId: bc.laneId, bandKey: band.key, pixel: band.center },
        });
      } else if (band.overlapsWith && band.overlapsWith.length > 0) {
        // 重叠：无法唯一决定，保留全部合法候选
        const options = [correctedY - 1.5, correctedY + 1.5].map((y, i) => {
          const r = inferMwAt(y, build, { method: params.method, fit, unit: ladderPayload.unit });
          return {
            mw: r.kind === 'value' ? r.mw : NaN,
            unit: ladderPayload.unit,
            note: i === 0 ? 'deconvolution-upper' : 'deconvolution-lower',
          };
        });
        result = { kind: 'candidates', options, reason: 'overlap-ambiguous' };
        bandDiagnostics.push({
          severity: 'warning',
          code: 'OVERLAP_CANDIDATES_KEPT',
          message: `条带 ${band.key} 与 ${band.overlapsWith.join(',')} 重叠，保留全部合法候选，等待人工决定`,
          position: { materialId: bcMaterial.id, laneId: bc.laneId, bandKey: band.key, pixel: band.center },
        });
      } else {
        result = inferMwAt(correctedY, build, { method: params.method, fit, unit: ladderPayload.unit });
      }
      bands.push({
        id: '', // 由 finalize 填充（依赖 computationId）
        laneId: bc.laneId,
        bandKey: band.key,
        pixel: band.center,
        correctedY,
        saturated: band.saturated,
        autoResult: result,
        result,
        diagnostics: bandDiagnostics,
      });
    }
  }

  const status: PipelineResult['status'] =
    build.status === 'semantic_unsolvable' ? 'semantic_unsolvable' : 'ok';
  const compId = computationId(
    'mw-inference',
    params.paramVersion,
    materials.map((m) => m.id),
  );
  for (const band of bands) band.id = `${compId}:${band.laneId}:${band.bandKey}`;

  return {
    status,
    computationId: compId,
    inputDigest: inputDigestOf(materials),
    paramVersion: params.paramVersion,
    materialIds: materials.map((m) => m.id).sort(),
    imageId: image.id,
    capture: imagePayload.capture,
    unit: ladderPayload.unit,
    ruler: {
      points: build.points,
      fit: fit ? { a: fit.a, b: fit.b } : null,
      residuals: fit?.residuals ?? [],
      validRegion: region,
      runCount: build.runs.length,
    },
    bands,
    diagnostics,
  };
}

// 应用人工决定：自动候选始终保留在 autoResult，决定只改可见结论。
// 冲突决定（不同分支）全部保留，由界面并列展示。
export function applyDecisions(result: PipelineResult, decisions: Decision[]): PipelineResult {
  if (decisions.length === 0) return result;
  const bands = result.bands.map((band) => {
    const relevant = decisions.filter(
      (d) => d.laneId === band.laneId && d.bandKey === band.bandKey,
    );
    if (relevant.length === 0) return band;
    const accepted = relevant.filter((d) => d.kind === 'accept-candidate' && d.optionMw != null);
    const rejected = relevant.filter((d) => d.kind === 'reject-candidate');
    let next = band.result;
    if (accepted.length > 0 && band.autoResult.kind === 'candidates') {
      const remaining = band.autoResult.options.filter(
        (opt) => !rejected.some((d) => d.optionMw === opt.mw),
      );
      if (accepted.length === 1) {
        next = {
          kind: 'value',
          mw: accepted[0].optionMw!,
          unit: band.autoResult.options[0]?.unit ?? result.unit,
          segment:
            band.autoResult.options.length > 0 && band.result.kind === 'value'
              ? band.result.segment
              : { lo: { key: 'manual', mw: 0, y: 0 }, hi: { key: 'manual', mw: 0, y: 0 } },
          validRegion: result.ruler?.validRegion ?? [band.correctedY, band.correctedY],
          decidedBy: 'manual',
        };
      } else {
        next = {
          kind: 'candidates',
          options: remaining,
          reason: `conflicting-manual-decisions:${accepted.map((d) => d.branch).join('|')}`,
        };
      }
    }
    return { ...band, result: next };
  });
  return { ...result, bands };
}
