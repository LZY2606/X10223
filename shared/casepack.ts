// 离线领域案例包（非通用表格）：主叙事 + 七类反例，每个值携带单位/坐标基准。
import type {
  BandMaterial,
  ExposureMaterial,
  Event,
  GelParams,
  ImageMaterial,
  LadderAssignmentMaterial,
  LadderSpecMaterial,
  LaneMaterial,
  Material,
  OrientationMaterial,
  Provenance,
  Vec2
} from "./types";
import { EventBuilder } from "./events";
import { defaultParams } from "./defaults";
import { generateGel, laneCenterPoints, usableLength, type GelGenSpec, type GenLane } from "./gelgen";
import { molecularMassUnit, parseQuantity, pixelUnit, timeUnit } from "./units";
import { sha256Text } from "./hash";
import { canonicalJson, rasterDigest } from "./canonical";
import { detectBands } from "./detector";
import { buildCurve, interpAt } from "./curveMath";

export interface CasePack {
  caseId: string;
  title: string;
  scenario: string;
  events: Event[];
  /** 哪些事件属于分支 */
  branches: { name: string; fromEventId: string | null; headEventId: string }[];
  tags: string[];
}

const LADDER_LABELS = ["250", "150", "100", "75", "50", "37", "25", "20", "15", "10"];

export function standardLadder(id: string, name = "GSB-10 蛋白 ladder"): LadderSpecMaterial {
  return {
    kind: "ladderSpec",
    id,
    name,
    rungs: LADDER_LABELS.map((label, order) => ({
      label: `${label} kDa`,
      order,
      nominal: parseQuantity(`${label} kDa`, "molecularMass")
    }))
  };
}

export interface PackOptions {
  caseId: string;
  title: string;
  scenario: string;
  tags: string[];
  spec: GelGenSpec;
  /** 哪些 lane 是 ladder */
  ladderLaneIndexes: number[];
  ladderSpec?: LadderSpecMaterial;
  /** 初始方向（与 spec.preRotate 配合：相机倒拍 90° 时审阅者给 1） */
  orientationTurns?: 0 | 1 | 2 | 3;
  mirrored?: boolean;
  /** 修订动作 */
  parameterRevision?: { params: GelParams; reason: string };
  /** 源数据局部改动（在主干末端） */
  sourceRevision?: { kind: "lane" | "band" | "ladderAssignment" | "orientation"; mutate: (ctx: PackBuildContext) => { changedField: string; from: unknown; to: unknown; material: import("./types").Material } };
  /** 分支（基于修订后状态分叉） */
  forks?: ForkSpec[];
  manualBandLanes?: Record<number, { sFrac: number; label: string; issue?: "saturated" | "tailing" }[]>;
  /** 额外材料（例如在旋转解释帧中数字化的 lane/band） */
  extraMaterials?: Material[];
  /** 预构造的 lane 材料（跳过按 spec 自动生成），imageId 会被绑定为实际图像 */
  explicitLanes?: LaneMaterial[];
}

export interface ForkSpec {
  name: string;
  build: (ctx: PackBuildContext) => Event[];
}

export interface PackBuildContext {
  builder: EventBuilder;
  image: ImageMaterial;
  lanes: LaneMaterial[];
  ladderSpec: LadderSpecMaterial;
  params: GelParams;
  materials: {
    orientation: OrientationMaterial;
    exposure: ExposureMaterial;
    assignments: LadderAssignmentMaterial[];
  };
}

function idFor(prefix: string, content: unknown): string {
  return `${prefix}_${sha256Text(canonicalJson(content)).slice(0, 14)}`;
}

function imageMaterial(caseId: string, spec: GelGenSpec): ImageMaterial {
  const raster = generateGel(spec);
  const id = idFor("img", { caseId, ...rasterDigest(raster) });
  return {
    kind: "image",
    id,
    filename: `${caseId}_gel.png`,
    mediaType: "image/png",
    width: raster.width,
    height: raster.height,
    raster,
    capturedAt: "2026-09-25T09:00:00+09:00",
    generator: "shared/gelgen:v1"
  };
}

function orientationMaterial(imageId: string, turns: 0 | 1 | 2 | 3, mirrored: boolean): OrientationMaterial {
  return {
    kind: "orientation",
    id: idFor("ori", { imageId, turns, mirrored }),
    imageId,
    rotationQuarterTurns: turns,
    mirrored,
    migrationDirection: "down"
  };
}

function exposureMaterial(imageId: string): ExposureMaterial {
  return {
    kind: "exposure",
    id: idFor("exp", { imageId }),
    imageId,
    exposureTime: { raw: "120 ms", value: 120, unit: timeUnit("ms"), scaleToBase: 1 },
    gain: { raw: "1.4x", value: 1.4, unit: { kind: "unitless", label: "x" } },
    gamma: 2.2,
    sensorMax: 255
  };
}

export function laneMaterials(imageId: string, spec: GelGenSpec): LaneMaterial[] {
  return spec.lanes.map((genLane, i) => {
    const center = laneCenterPoints(spec, i);
    const lane: LaneMaterial = {
      kind: "lane",
      id: idFor("lane", { imageId, i, center: center.slice(0, 6) }),
      logicalId: `lane-${i}`,
      imageId,
      index: i,
      role: genLane.role,
      center,
      halfWidth: spec.laneHalfWidth,
      label: genLane.label,
      provenance: center
        .filter((_, k) => k % 8 === 0)
        .map<Provenance>((p) => ({ sourceImageId: imageId, originalPixel: p, interpretedPixel: p }))
    };
    return lane;
  });
}

export function detectedManualBands(image: ImageMaterial, lane: LaneMaterial, params: GelParams, specs?: { sFrac: number; label: string; issue?: "saturated" | "tailing" }[]): BandMaterial[] {
  if (!specs) return [];
  const detection = detectBands(image.raster, lane.center, lane.halfWidth, params);
  const usable = image.height - 40 - 24;
  return specs.map((specItem, idx) => {
    const wantS = specItem.sFrac * usable;
    const nearest = detection.bands.reduce<(typeof detection.bands)[number] | null>(
      (best, b) => (!best || Math.abs(b.s - wantS) < Math.abs(best.s - wantS) ? b : best),
      null
    );
    const center: Vec2 = nearest ? nearest.center : pointOnCurve(lane, wantS);
    const issues: BandMaterial["issues"] = [];
    if (nearest?.issues.includes("saturated") || specItem.issue === "saturated") issues.push("saturated");
    if (nearest?.issues.includes("tailing") || specItem.issue === "tailing") issues.push("tailing");
    if (nearest?.issues.includes("overlap")) issues.push("overlap");
    const prov: Provenance = {
      sourceImageId: image.id,
      originalPixel: center,
      interpretedPixel: center,
      note: `manual center ${specItem.label}`
    };
    const band: BandMaterial = {
      kind: "band",
      id: idFor("band", { lane: lane.id, center, origin: "manual", idx }),
      logicalId: `${lane.logicalId}-band-manual-${idx}`,
      laneId: lane.id,
      imageId: image.id,
      center,
      contour: nearest?.contour ?? [center],
      status: "candidate",
      origin: "manual",
      issues,
      provenance: prov,
      peakIntensity: nearest?.peakIntensity
    };
    return band;
  });
}

function pointOnCurve(lane: LaneMaterial, s: number): Vec2 {
  const curve = buildCurve(lane.center);
  const total = curve.cumulative[curve.cumulative.length - 1];
  return interpAt(curve, Math.max(0, Math.min(total, s)));
}

export function buildCasePack(options: PackOptions): CasePack {
  const builder = new EventBuilder(options.caseId);
  builder.createCase(options.title, options.scenario, "基线材料：原图/方向/曝光/ladder标称/lane边界/band中心全部保留像素级来源");

  const image = imageMaterial(options.caseId, options.spec);
  builder.add(image);

  const orientation = orientationMaterial(image.id, options.orientationTurns ?? 0, options.mirrored ?? false);
  builder.add(orientation);
  const exposure = exposureMaterial(image.id);
  builder.add(exposure);

  const ladderSpec = options.ladderSpec ?? standardLadder(`ladder-${options.caseId}`);
  builder.add(ladderSpec);

  const autoLanes = laneMaterials(image.id, options.spec);
  const lanes = (options.explicitLanes
    ? options.explicitLanes.map((lane, i) => ({
        ...lane,
        id: autoLanes[i]?.id ?? lane.id,
        imageId: image.id,
        provenance: lane.provenance.map((pr) => ({ ...pr, sourceImageId: image.id }))
      }))
    : autoLanes);
  const assignments: LadderAssignmentMaterial[] = [];
  for (const lane of lanes) builder.add(lane);
  for (const idx of options.ladderLaneIndexes) {
    const assignment: LadderAssignmentMaterial = {
      kind: "ladderAssignment",
      id: idFor("assign", { lane: lanes[idx].id, spec: ladderSpec.id }),
      logicalId: `assign-${idx}`,
      laneId: lanes[idx].id,
      ladderSpecId: ladderSpec.id
    };
    assignments.push(assignment);
    builder.add(assignment);
  }

  for (const extra of options.extraMaterials ?? []) builder.add(extra);

  let params = defaultParams();
  const manualSpecs = options.manualBandLanes ?? {};
  for (const [laneIdxStr, specs] of Object.entries(manualSpecs)) {
    const lane = lanes[Number(laneIdxStr)];
    for (const band of detectedManualBands(image, lane, params, specs)) builder.add(band);
  }

  const ctx: PackBuildContext = {
    builder,
    image,
    lanes,
    ladderSpec,
    params,
    materials: { orientation, exposure, assignments }
  };

  const branches: CasePack["branches"] = [
    { name: "main", fromEventId: null, headEventId: builder.events[builder.events.length - 1].id }
  ];
  const allBuilders: EventBuilder[] = [builder];

  if (options.parameterRevision) {
    params = options.parameterRevision.params;
    builder.reviseParams(params.version, options.parameterRevision.params, options.parameterRevision.reason);
    ctx.params = params;
  }

  if (options.sourceRevision) {
    const revision = options.sourceRevision.mutate(ctx);
    builder.revise(options.sourceRevision.kind, revision.material.id, revision.changedField, revision.from, revision.to, revision.material);
  }
  branches[0].headEventId = builder.events[builder.events.length - 1].id;

  for (const forkSpec of options.forks ?? []) {
    const fork = builder.fork(forkSpec.name);
    const forkCtx: PackBuildContext = { ...ctx, builder: fork };
    const made = forkSpec.build(forkCtx);
    const headEvent = made[made.length - 1] ?? fork.events[fork.events.length - 1];
    branches.push({ name: forkSpec.name, fromEventId: builder.head(), headEventId: headEvent.id });
    allBuilders.push(fork);
  }

  const seen = new Set<string>();
  const allEvents: Event[] = [];
  for (const b of allBuilders) {
    for (const e of b.events) {
      if (!seen.has(e.id)) {
        seen.add(e.id);
        allEvents.push(e);
      }
    }
  }
  return { caseId: options.caseId, title: options.title, scenario: options.scenario, events: allEvents.sort((a, b) => a.seq - b.seq || (a.id < b.id ? -1 : 1)), branches, tags: options.tags };
}

export { molecularMassUnit, pixelUnit, usableLength };
export type { GenLane, GelGenSpec };
