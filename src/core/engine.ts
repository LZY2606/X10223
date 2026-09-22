/**
 * 推断引擎：材料状态 -> 泳道轮廓 -> 峰证据 -> 局部标尺 -> 分子量候选。
 *
 * 所有结果记录：输入摘要、参数版本、父级依赖；结果按内容寻址，可重放。
 * 三种失败严格区分：resource-exhausted / format-corrupt / semantic-unsolvable。
 */
import {
  buildCalibration,
  projectToCenterline,
  RULE_VERSION,
  smileCurvature
} from './calibration.js';
import { DEFAULT_PEAK_PARAMS, detectPeaks, type PeakParams } from './profile.js';
import type {
  BandCenterRevision,
  BandInference,
  ComputeOutcome,
  ComputeResult,
  Diagnostic,
  LaneGeometryRevision,
  LaneInference,
  LadderSpecMaterial,
  MachineEvent,
  ParentRef,
  RawImageMaterial,
  ResourceBudget
} from './types.js';
import type { ProjectState } from './state.js';
import { latestBand, latestLane, latestMaterial } from './state.js';
import { centerlineFromBounds, decodePng, laneProfile, type Raster } from './raster.js';
import { inferMW } from './calibration.js';
import { sha256Of, sha256Bytes, stableStringify } from './hash.js';
import { candidateSortKey } from './ids.js';

export const DEFAULT_BUDGET: ResourceBudget = {
  maxPixels: 4_000_000,
  maxSegments: 200_000,
  maxOpSteps: 20_000_000
};

export interface EngineParams {
  peak: PeakParams;
  /** ladder 条带与标称值按 ordinal 关联时使用的 id 后缀规则 bN */
  profileHalfWidth: number;
  centerlineSamples: number;
}

export const DEFAULT_ENGINE_PARAMS: EngineParams = {
  peak: DEFAULT_PEAK_PARAMS,
  profileHalfWidth: 6,
  centerlineSamples: 120
};

export interface EngineInput {
  projectId: string;
  branchId: string;
  /** 像素帧：该分支当前使用的图像材料（通常是旋转后 derivedImage） */
  imageIdentity: string;
  /** 该帧字节（由存储层按 sha256 提供） */
  imageBytes: Uint8Array;
  state: ProjectState;
  ladderLaneIdentity: string;
  params?: Partial<EngineParams>;
  budget?: ResourceBudget;
}

export interface CorruptLike {
  failureClass?: string;
}

function diag(
  code: string,
  severity: Diagnostic['severity'],
  message: string,
  extra?: Partial<Diagnostic>
): Diagnostic {
  return { code, severity, message, ...extra };
}

/** 组装父级依赖与输入摘要（每个几何对象精确到修订号） */
function collectParents(
  state: ProjectState,
  image: RawImageMaterial,
  lanes: LaneGeometryRevision[],
  bands: BandCenterRevision[],
  ladderSpec: LadderSpecMaterial | undefined,
  params: EngineParams
): { parents: ParentRef[]; inputSummary: Record<string, string> } {
  const parents: ParentRef[] = [
    { kind: 'rule', identity: RULE_VERSION, revision: null },
    {
      kind: 'material',
      identity: image.identity,
      revision: image.revision,
      sha: image.sha256
    }
  ];
  if (ladderSpec) {
    parents.push({
      kind: 'material',
      identity: ladderSpec.identity,
      revision: ladderSpec.revision,
      sha: sha256Of(stableStringify(ladderSpec.bands.map((b) => [b.ordinal, b.rawRepresentation, b.observed])))
    });
  }
  for (const l of lanes) parents.push({ kind: 'lane', identity: l.identity, revision: l.revision });
  for (const b of bands) parents.push({ kind: 'band', identity: b.identity, revision: b.revision });

  const inputSummary: Record<string, string> = {
    image: `${image.identity}@r${image.revision}:${image.sha256.slice(0, 12)}`,
    imageSize: `${image.width}x${image.height}`,
    laneRevs: lanes.map((l) => `${l.identity}@r${l.revision}`).join(','),
    bandRevs: bands.map((b) => `${b.identity}@r${b.revision}`).join(','),
    ladderRev: ladderSpec ? `${ladderSpec.identity}@r${ladderSpec.revision}` : 'none',
    ruleVersion: RULE_VERSION,
    paramsHash: sha256Of(params).slice(0, 12)
  };
  return { parents, inputSummary };
}

/** 主入口：返回四种互斥结果之一 */
export function runInference(input: EngineInput): ComputeOutcome {
  const budget = input.budget ?? DEFAULT_BUDGET;
  const params: EngineParams = {
    ...DEFAULT_ENGINE_PARAMS,
    ...input.params,
    peak: { ...DEFAULT_PEAK_PARAMS, ...(input.params?.peak ?? {}) }
  };
  const machineEvents: MachineEvent[] = [];

  // 1) 解码（format-corrupt 与资源耗尽严格区分）
  const image = latestMaterial(input.state, input.imageIdentity) as RawImageMaterial | undefined;
  if (!image || (image.kind !== 'rawImage' && image.kind !== 'derivedImage')) {
    return {
      status: 'semantic-unsolvable',
      diagnostics: [
        diag('MISSING_IMAGE', 'error', '当前分支缺少图像材料', {
          location: { field: 'imageIdentity' },
          failureClass: 'semantic-unsolvable'
        })
      ]
    };
  }
  const sha = sha256Bytes(input.imageBytes);
  if (sha !== image.sha256) {
    return {
      status: 'format-corrupt',
      diagnostic: diag(
        'IMAGE_HASH_MISMATCH',
        'error',
        '图像字节与登记的 sha256 不一致，来源可能损坏',
        { location: { field: 'image.bytes' }, failureClass: 'format-corrupt' }
      )
    };
  }
  let raster: Raster;
  try {
    raster = decodePng(input.imageBytes);
    raster.frameId = image.identity;
  } catch (e) {
    if ((e as CorruptLike).failureClass === 'format-corrupt') {
      return {
        status: 'format-corrupt',
        diagnostic: diag('PNG_DECODE_FAILED', 'error', (e as Error).message, {
          location: { field: 'image.png' },
          failureClass: 'format-corrupt'
        })
      };
    }
    throw e;
  }
  const pixelCount = raster.width * raster.height;
  if (pixelCount > budget.maxPixels) {
    return {
      status: 'resource-exhausted',
      used: budget,
      diagnostic: diag(
        'BUDGET_PIXELS',
        'error',
        `图像 ${pixelCount} 像素超过预算 ${budget.maxPixels}`,
        { location: { field: 'image' }, failureClass: 'resource-exhausted' }
      )
    };
  }

  // 2) 取当前帧上的泳道/条带最新版本
  const frame = image.identity;
  const allLanes = [...input.state.lanes.values()]
    .filter((l) => l.frame === frame)
    .filter((l, _i, arr) => {
      const best = arr.filter((x) => x.identity === l.identity).sort((a, b) => b.revision - a.revision)[0];
      return best?.revision === l.revision;
    });
  const allBands = [...input.state.bands.values()]
    .filter((b) => b.center.frame === frame)
    .filter((b, _i, arr) => {
      const best = arr.filter((x) => x.identity === b.identity).sort((a, b2) => b2.revision - a.revision)[0];
      return best?.revision === b.revision;
    });

  if (allLanes.length === 0) {
    return {
      status: 'semantic-unsolvable',
      diagnostics: [
        diag('NO_LANES', 'error', `帧 ${frame} 上没有任何泳道几何来源`, {
          location: { frame, field: 'lanes' },
          failureClass: 'semantic-unsolvable'
        })
      ]
    };
  }

  const ladderLane = latestLane(input.state, input.ladderLaneIdentity);
  const ladderSpec = [...input.state.materials.values()]
    .filter((m): m is LadderSpecMaterial => m.kind === 'ladderSpec')
    .filter((m) => m.laneIdentity === input.ladderLaneIdentity)
    .sort((a, b) => b.revision - a.revision)[0];

  if (!ladderLane) {
    return {
      status: 'semantic-unsolvable',
      diagnostics: [
        diag('MISSING_LADDER_LANE', 'error', '缺少 ladder 泳道几何，无法建立标尺', {
          location: { laneId: input.ladderLaneIdentity },
          failureClass: 'semantic-unsolvable'
        })
      ]
    };
  }

  const diagnostics: Diagnostic[] = [];
  const lanesOut: LaneInference[] = [];
  const profiles: Record<string, number[]> = {};
  const residuals: Record<string, number[]> = {};
  let opSteps = 0;
  let semanticErrors = false;

  // 3) ladder 标尺（只建一次）
  let ladderModel: LaneInference['calibration'] = null;
  const ladderBands = allBands.filter((b) => b.laneIdentity === ladderLane.identity);
  if (!ladderSpec) {
    diagnostics.push(
      diag('MISSING_LADDER_SPEC', 'error', '缺少 ladder 标称值材料，分子量无法校准', {
        location: { laneId: ladderLane.identity },
        failureClass: 'semantic-unsolvable'
      })
    );
    semanticErrors = true;
  } else {
    const built = buildCalibration({
      laneId: ladderLane.identity,
      lane: ladderLane,
      ladderSpec,
      ladderBands
    });
    ladderModel = built.model;
    diagnostics.push(...built.diagnostics);
    for (const code of built.machineEventCodes) {
      machineEvents.push({
        code: code as MachineEvent['code'],
        objectRefs: [ladderLane.identity],
        data: { smileCurvaturePx: Number(built.model.smileCurvaturePx.toFixed(2)) },
        message:
          code === 'SMILE_HEIGHT_NOT_MW'
            ? '微笑弯曲：同一像素高度不对应同一分子量，沿中心线弧长标定并限定有效区域'
            : code === 'RULER_LOCAL_VALID_REGION'
              ? '局部标尺带有效区域，区域外禁止外推'
              : code === 'NON_MONOTONIC_RULER'
                ? '标尺非单调，禁止插值'
                : 'ladder 缺带，受影响插值段不可用'
      });
    }
    if (built.model.nonMonotonic) semanticErrors = true;
  }

  // 4) 每条泳道：轮廓 -> 峰证据 -> 沿自身中心线投影 -> 用局部标尺推断
  for (const lane of allLanes) {
    const cl = centerlineFromBounds(lane.left, lane.right, params.centerlineSamples);
    const profileSamples = laneProfile(raster, cl, params.profileHalfWidth);
    opSteps += profileSamples.length * params.profileHalfWidth * 2;
    if (opSteps > budget.maxOpSteps) {
      return {
        status: 'resource-exhausted',
        used: budget,
        diagnostic: diag('BUDGET_OPS', 'error', `运算步数超过预算 ${budget.maxOpSteps}`, {
          failureClass: 'resource-exhausted'
        })
      };
    }
    profiles[lane.identity] = profileSamples.map((p) => Number(p.intensity.toFixed(3)));
    const peakRun = detectPeaks(profileSamples, params.peak);
    diagnostics.push(
      ...peakRun.diagnostics.map((d) => ({ ...d, location: { ...d.location, laneId: lane.identity } }))
    );

    const bandsHere = allBands.filter((b) => b.laneIdentity === lane.identity);
    const bandsOut: BandInference[] = [];

    for (const band of bandsHere) {
      const proj = projectToCenterline(cl, band.center.x, band.center.y);
      const nearest = peakRun.peaks
        .map((p) => ({ p, d: Math.abs(p.u - proj.u) }))
        .sort((a, b) => a.d - b.d)[0];
      const peak = nearest && nearest.d < 12 ? nearest.p : undefined;

      const saturated = !!peak && peak.clippedFraction > 0.02;
      const tailed = !!peak && peak.asymmetry >= params.peak.tailAsymmetry;
      const overlap = !!peak && peak.resolvedPeaks > 1;
      const overlappedWith = overlap
        ? bandsHere
            .filter((b2) => b2.identity !== band.identity)
            .map((b2) => {
              const p2 = projectToCenterline(cl, b2.center.x, b2.center.y);
              return { id: b2.identity, d: Math.abs(p2.u - proj.u) };
            })
            .filter((x) => x.d < (peak?.fwhm ?? 8) * 1.5)
            .map((x) => x.id)
        : [];

      const bandDiags: Diagnostic[] = [];
      let inference: BandInference;
      if (lane.isLadderLane && lane.identity === ladderLane.identity) {
        inference = {
          bandId: band.identity,
          laneId: lane.identity,
          center: band.center,
          status: 'definite',
          mwCandidates: [],
          saturated,
          tailed,
          overlappedWith,
          evidence: {
            migrationNorm: proj.u,
            peakIntensity: peak?.height ?? 0,
            clippedFraction: peak?.clippedFraction ?? 0,
            asymmetry: peak?.asymmetry ?? 1,
            resolvedPeaks: peak?.resolvedPeaks ?? 1,
            residual: proj.residual,
            profileRef: `profile:${lane.identity}`
          },
          diagnostics: bandDiags
        };
      } else if (!ladderModel || ladderModel.nonMonotonic || !ladderModel.validRegion) {
        bandDiags.push(
          diag('MW_NO_RULER', 'error', 'ladder 标尺无效，样本带无法推断分子量', {
            location: { laneId: lane.identity, bandId: band.identity },
            failureClass: 'semantic-unsolvable'
          })
        );
        semanticErrors = true;
        inference = bandShell(band, lane.identity, proj.u, proj.residual, peak, 'invalid', [], bandDiags, saturated, tailed, overlappedWith);
      } else {
        const run = inferMW(ladderModel, proj.u, {
          overlap,
          saturated,
          tailed,
          peakSigmaU: peak?.fwhm ?? 4
        });
        bandDiags.push(...run.diagnostics);
        const outside = run.candidates.some((c) => !c.inValidRegion);
        const status = outside
          ? 'invalid'
          : overlap
            ? 'interval'
            : saturated || tailed
              ? 'candidate'
              : 'definite';
        inference = bandShell(band, lane.identity, proj.u, proj.residual, peak, status, run.candidates, bandDiags, saturated, tailed, overlappedWith);
        if (status === 'candidate') {
          machineEvents.push({
            code: saturated ? 'SATURATION_ONLY_CANDIDATE' : 'TAILING_ONLY_CANDIDATE',
            objectRefs: [band.identity],
            data: { clippedFraction: Number((peak?.clippedFraction ?? 0).toFixed(3)), asymmetry: Number((peak?.asymmetry ?? 1).toFixed(2)) },
            message: saturated ? '饱和条带只能标为候选/区间，不能给唯一分子量' : '拖尾条带只能标为候选/区间，不能给唯一分子量'
          });
        }
        if (status === 'interval') {
          machineEvents.push({
            code: 'OVERLAP_ONLY_INTERVAL',
            objectRefs: [band.identity, ...overlappedWith],
            data: { resolvedPeaks: peak?.resolvedPeaks ?? 2, fwhm: Number((peak?.fwhm ?? 0).toFixed(2)) },
            message: '重叠条带只能给出区间，并保留区间内全部合法候选'
          });
        }
        if ((status === 'interval' || status === 'candidate') && run.candidates.length > 0) {
          machineEvents.push({
            code: 'CANDIDATES_KEPT_AMBIGUOUS',
            objectRefs: [band.identity],
            data: { candidateCount: run.candidates.length },
            message: '无法唯一决定，保留全部合法候选'
          });
        }
      }
      residuals[band.identity] = [Number((proj.residual ?? 0).toFixed(3))];
      bandsOut.push(inference);
    }

    // 轮廓拟合残差（平滑曲线相对原始强度的偏差）
    residuals[lane.identity] = profileSamples.map((p, i) =>
      Number((p.intensity - peakRun.smoothed[i]!).toFixed(3))
    );

    const sortedBands = bandsOut.sort((a, b) =>
      candidateSortKey({
        bandId: a.bandId,
        mwNorm: a.mwCandidates[0]?.point ?? a.mwCandidates[0]?.lo ?? null,
        status: a.status
      }).localeCompare(
        candidateSortKey({
          bandId: b.bandId,
          mwNorm: b.mwCandidates[0]?.point ?? b.mwCandidates[0]?.lo ?? null,
          status: b.status
        })
      )
    );
    lanesOut.push({ laneId: lane.identity, calibration: lane.identity === ladderLane.identity ? ladderModel : ladderModel, bands: sortedBands });
  }

  const { parents, inputSummary } = collectParents(
    input.state,
    image,
    allLanes,
    allBands,
    ladderSpec,
    params
  );

  const resultCore = {
    ruleVersion: RULE_VERSION,
    inputSummary,
    params: params as unknown as Record<string, number | string | boolean>,
    parents,
    lanes: lanesOut,
    machineEvents: dedupeEvents(machineEvents),
    diagnostics: dedupeDiagnostics(diagnostics),
    profiles,
    fitResiduals: residuals
  };
  const resultId = `cr-${sha256Of(resultCore).slice(0, 20)}`;
  const result: ComputeResult = { id: resultId, ...resultCore };

  if (semanticErrors) {
    // 语义无解仍然产出结构化结果（含全部证据与候选），但状态显式区分
    return { status: 'semantic-unsolvable', diagnostics: result.diagnostics, result };
  }
  return { status: 'ok', result };
}

function bandShell(
  band: BandCenterRevision,
  laneId: string,
  u: number,
  residual: number,
  peak:
    | {
        height: number;
        clippedFraction: number;
        asymmetry: number;
        resolvedPeaks: number;
        fwhm: number;
      }
    | undefined,
  status: BandInference['status'],
  candidates: BandInference['mwCandidates'],
  bandDiags: Diagnostic[],
  saturated: boolean,
  tailed: boolean,
  overlappedWith: string[]
): BandInference {
  return {
    bandId: band.identity,
    laneId,
    center: band.center,
    status,
    mwCandidates: candidates,
    saturated,
    tailed,
    overlappedWith,
    evidence: {
      migrationNorm: u,
      peakIntensity: peak?.height ?? 0,
      clippedFraction: peak?.clippedFraction ?? 0,
      asymmetry: peak?.asymmetry ?? 1,
      resolvedPeaks: peak?.resolvedPeaks ?? 1,
      residual,
      profileRef: `profile:${laneId}`
    },
    diagnostics: bandDiags
  };
}

function dedupeEvents(events: MachineEvent[]): MachineEvent[] {
  const seen = new Set<string>();
  const out: MachineEvent[] = [];
  for (const e of events) {
    const key = `${e.code}|${e.objectRefs.join(',')}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out.sort((a, b) => a.code.localeCompare(b.code) || a.objectRefs.join(',').localeCompare(b.objectRefs.join(',')));
}

function dedupeDiagnostics(ds: Diagnostic[]): Diagnostic[] {
  const seen = new Set<string>();
  const out: Diagnostic[] = [];
  for (const d of ds) {
    const key = `${d.code}|${d.location?.laneId ?? ''}|${d.location?.bandId ?? ''}|${d.location?.field ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(d);
  }
 return out;
}
