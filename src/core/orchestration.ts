import { buildLaneGeoms, detectLane } from "./detection.js";
import { buildAllRulerPieces } from "./calibration.js";
import { inferLane } from "./inference.js";
import { stableId } from "./hash.js";
import {
  type AutoBand,
  type BandMwResult,
  type ComputeOptions,
  type Derivation,
  type InputDigest,
  type RulerResult,
} from "./kernel-types.js";
import type {
  Diagnostic,
  ImageMaterial,
  SemanticNoSolutionError,
} from "./types.js";
import { SemanticNoSolutionError as _S } from "./types.js";
import type { EffectiveState } from "./state.js";
import type { GrayImage } from "./png.js";

export const DEFAULT_DETECT = {
  peakWindowPx: 9,
  zThreshold: 3.0,
  halfWidthPx: 7,
};

export const DEFAULT_FIT = {
  model: "piecewise-log" as const,
  allowExtrapolation: false,
};

function digestOf(state: EffectiveState): InputDigest {
  return {
    imageSha: state.image?.sha256 ?? null,
    orientationId: state.orientation?.id ?? null,
    exposureId: state.exposure?.id ?? null,
    laneIds: state.laneBoundaries.map((l) => l.id).sort(),
    bandCenterIds: state.bandCenters.map((b) => b.id).sort(),
    ladderNominalIds: state.ladderNominals.map((n) => n.id).sort(),
  };
}

/** 输入完整性校验：不完整时返回带位置的诊断，不用空值/默认伪装成功 */
export function validateInputs(state: EffectiveState): Diagnostic[] {
  const diags: Diagnostic[] = [];
  if (!state.image) {
    diags.push({
      code: "MISSING_IMAGE",
      severity: "error",
      message: "缺少原始凝胶图像",
      subjectIds: [state.project.id],
    });
  }
  if (!state.orientation) {
    diags.push({
      code: "ORIENTATION_UNSET",
      severity: "error",
      message: "拍摄方向未确认（加样孔位置未知），无法定义迁移基准",
      subjectIds: [state.project.id],
    });
  }
  if (state.laneBoundaries.length === 0) {
    diags.push({ code: "NO_SOLUTION", severity: "error", message: "尚未标注任何 lane 边界", subjectIds: [state.project.id] });
  }
  if (!state.laneBoundaries.some((l) => l.role === "ladder")) {
    diags.push({ code: "NO_SOLUTION", severity: "error", message: "缺少 ladder 泳道，无法建立分子量标尺", subjectIds: [state.project.id] });
  }
  return diags;
}

export interface DerivedBundle {
  derivation: Derivation;
  /** 按结果 id 索引，供 UI 回溯 */
  profiles: Record<string, { laneId: string; s: number; intensity: number; saturated: boolean }[]>;
}

/**
 * 运行全部派生计算。所有结果携带：
 *  - inputDigest（输入摘要哈希）
 *  - paramVersion（参数版本 id）
 *  - parentIds（父级依赖）
 *  - kernelVersion
 */
export function derive(state: EffectiveState, image: GrayImage | null, options: ComputeOptions = {}): DerivedBundle {
  const fatal = validateInputs(state);
  if (fatal.length) throw _makeSemantic(fatal);
  if (!image) throw _makeSemantic([{ code: "MISSING_IMAGE", severity: "error", message: "图像字节缺失", subjectIds: [state.project.id] }]);

  const ctx = {
    detect: state.params.detect?.detect ?? DEFAULT_DETECT,
    fit: state.params.fit?.fit ?? DEFAULT_FIT,
    opts: { maxSamplesPerLane: options.maxSamplesPerLane ?? 60_000 },
  };
  const detectParamId = state.params.detect?.id ?? stableId("params", { set: "detect-default", v: DEFAULT_DETECT });
  const fitParamId = state.params.fit?.id ?? stableId("params", { set: "fit-default", v: DEFAULT_FIT });
  const digest = digestOf(state);
  const saturationLevel = state.exposure?.saturationLevel ?? 250;

  const diagnostics: Diagnostic[] = [];
  const autoBands: AutoBand[] = [];
  const rulers: RulerResult[] = [];
  const bandMws: BandMwResult[] = [];
  const profiles: DerivedBundle["profiles"] = {};

  const ladderLanes = state.laneBoundaries.filter((l) => l.role === "ladder");
  const sampleLanes = state.laneBoundaries.filter((l) => l.role === "sample");

  const allLanes = [...ladderLanes, ...sampleLanes];
  for (const lane of allLanes) {
    const geoms = buildLaneGeoms(lane, state.image!, state.orientation!.orientation);
    const res = detectLane(
      image,
      state.orientation!.orientation,
      geoms,
      state.bandCenters,
      saturationLevel,
      ctx,
      digest,
      detectParamId,
    );
    profiles[lane.laneId] = res.profile.map((p) => ({
      laneId: lane.laneId,
      s: Math.round(p.s * 100) / 100,
      intensity: Math.round(p.intensity * 10) / 10,
      saturated: p.saturated,
    }));
    autoBands.push(...res.bands);
  }

  // ladder 标尺：保留全部合法对齐
  let primaryRuler: RulerResult | null = null;
  const pieceSetsByLadder: Record<string, { pairingId: number; pieces: ReturnType<typeof buildAllRulerPieces>["allPieces"][number]["pieces"] }[]> = {};
  for (const lane of ladderLanes) {
    const built = buildAllRulerPieces({
      lane,
      img: state.image!,
      orientation: state.orientation!.orientation,
      nominals: state.ladderNominals,
      bandCenters: state.bandCenters,
      ctx,
      digest,
      fitParamId,
      parentIds: [state.exposure?.id ?? "no-exposure"],
    });
    rulers.push(built.ruler);
    diagnostics.push(...built.ruler.diagnostics);
    pieceSetsByLadder[lane.laneId] = built.allPieces;
    if (!primaryRuler) primaryRuler = built.ruler;
  }

  // 样本泳道推断（使用第一条 ladder 的标尺；多 ladder 时各自独立）
  for (const lane of sampleLanes) {
    const ladderLane = nearestLadder(lane.laneId, ladderLanes.map((l) => l.laneId));
    const sets = pieceSetsByLadder[ladderLane] ?? [];
    const myBands = autoBands.filter((b) => b.laneId === lane.laneId);
    const mws = inferLane({
      lane,
      img: state.image!,
      orientation: state.orientation!.orientation,
      autoBands: myBands,
      pieceSets: sets,
      ladderLaneId: ladderLane,
      ctx,
      digest,
      fitParamId,
    });
    bandMws.push(...mws);
    for (const mw of mws) diagnostics.push(...mw.diagnostics);
  }

  // 稳定顺序：lane 标签 → 弧长
  const laneOrder = new Map(allLanes.map((l, i) => [l.laneId, i]));
  const bandOrder = (a: AutoBand, b: AutoBand) =>
    (laneOrder.get(a.laneId)! - laneOrder.get(b.laneId)!) || a.peakS - b.peakS;
  autoBands.sort(bandOrder);
  bandMws.sort(
    (a, b) =>
      (laneOrder.get(a.laneId)! - laneOrder.get(b.laneId)!) ||
      (autoBands.find((x) => x.id === a.autoBandId)?.peakS ?? 0) -
        (autoBands.find((x) => x.id === b.autoBandId)?.peakS ?? 0),
  );
  rulers.sort((a, b) => laneOrder.get(a.ladderLaneId)! - laneOrder.get(b.ladderLaneId)!);

  const order = [
    ...rulers.map((r) => r.id),
    ...autoBands.map((b) => b.id),
    ...bandMws.map((m) => m.id),
  ];

  return {
    derivation: { autoBands, rulers, bandMws, diagnostics, order },
    profiles,
  };
}

function nearestLadder(laneId: string, ladderLaneIds: string[]): string {
  void laneId;
  return ladderLaneIds[0]!;
}

function _makeSemantic(diagnostics: Diagnostic[]): SemanticNoSolutionError {
  return new _S("输入不完整或语义无解", diagnostics);
}
