// 领域引擎：事件溯源投影 + 检测/校准/推断重放。浏览器与服务端均可直接调用。
import type {
  BandMaterial,
  Diagnostic,
  Event,
  ExposureMaterial,
  GelParams,
  ImageMaterial,
  LadderAssignmentMaterial,
  LadderSpecMaterial,
  LaneMaterial,
  Material,
  OrientationMaterial,
  Outcome,
  Quantity,
  Vec2
} from "./types";
import { defaultParams, PARAMS_V1 } from "./defaults";
import { canonicalJson } from "./canonical";
import { sha256Text } from "./hash";
import { detectBands, type DetectedBand } from "./detector";
import { calibrateLane, type CalibrationCore } from "./calibration";
import { estimateMw, type EstimateCore } from "./estimator";
import type {
  BandEstimate,
  CalibrationResult,
  DetectionArtifact,
  DetectedBandView,
  InputSummary
} from "./artifacts";
import { buildCurve, projectPoint } from "./curveMath";
import { interpretedFrame, toInterpreted } from "./transforms";
import { rasterDigest } from "./canonical";

export interface CaseMeta {
  caseId: string;
  title: string;
  scenario: string;
  note: string;
  createdAt: string;
}

interface Effective {
  image?: ImageMaterial;
  orientation?: OrientationMaterial;
  exposure?: ExposureMaterial;
  ladders: Map<string, LadderSpecMaterial>;
  assignments: Map<string, LadderAssignmentMaterial>; // laneId -> assignment
  lanes: LaneMaterial[];
  bands: BandMaterial[];
}

export interface DecisionView {
  bandLogicalId: string;
  decision: "accept" | "reject" | "interval" | "resolve";
  chosenMw?: Quantity;
  intervalLow?: Quantity;
  intervalHigh?: Quantity;
  reason: string;
  at: string;
  eventId: string;
}

export interface LaneComputation {
  lane: LaneMaterial;
  detection: DetectionArtifact | null;
  calibration: (CalibrationResult & { transferred: boolean; sourceLaneIds: string[] }) | null;
  estimates: Map<string, BandEstimateView>;
  diagnostics: Diagnostic[];
}

export interface BandEstimateView extends EstimateCore {
  id: string;
  bandId: string;
  laneId: string;
  calibrationId: string;
  paramsVersion: string;
  adopted: boolean;
  inputSummary: InputSummary;
  parentIds: string[];
  decision?: DecisionView;
}

export interface StateView {
  meta: CaseMeta;
  headEventId: string;
  branch: string;
  params: GelParams;
  paramsVersion: string;
  effective: Effective;
  lanes: LaneComputation[];
  decisions: DecisionView[];
  events: Event[];
  conflict: { logicalId: string; decisions: DecisionView[] }[];
  diagnostics: Diagnostic[];
  opsUsed: number;
  budgetMax: number;
}

export type ComputeOutcome =
  | { kind: "ok"; state: StateView }
  | { kind: "incomplete"; state: StateView; diagnostics: Diagnostic[] }
  | { kind: "budget"; diagnostics: Diagnostic[]; opsUsed: number; state: StateView };

export function initialParams(): GelParams {
  return defaultParams();
}

export function materialId(material: Material): string {
  return `mat_${sha256Text(canonicalJson(stripId(material))).slice(0, 16)}`;
}

function stripId(material: Material): unknown {
  const copy = { ...(material as unknown as Record<string, unknown>) };
  return copy;
}

function shortHash(value: unknown, length = 12): string {
  return sha256Text(canonicalJson(value)).slice(0, length);
}

export class EventProjection {
  meta!: CaseMeta;
  params = initialParams();
  paramsVersion = PARAMS_V1;
  image?: ImageMaterial;
  orientation?: OrientationMaterial;
  exposure?: ExposureMaterial;
  ladders = new Map<string, LadderSpecMaterial>();
  assignmentsByLane = new Map<string, LadderAssignmentMaterial>();
  lanesByLogical = new Map<string, LaneMaterial>();
  bandsByLogical = new Map<string, BandMaterial>();
  materialLogical = new Map<string, string>();
  decisionsByBand = new Map<string, DecisionView[]>();
  events: Event[] = [];
  branch = "main";
  headEventId: string | null = null;
  seqMax = 0;

  apply(event: Event): void {
    this.events.push(event);
    this.headEventId = event.id;
    this.branch = event.branch;
    this.seqMax = Math.max(this.seqMax, event.seq);
    switch (event.type) {
      case "case_created":
        this.meta = {
          caseId: event.caseId,
          title: event.payload.title,
          scenario: event.payload.scenario,
          note: event.payload.note,
          createdAt: event.at
        };
        break;
      case "params_revised":
        this.params = event.payload.params;
        this.paramsVersion = event.payload.params.version;
        break;
      case "material_added":
      case "material_revised":
        this.ingest(event.payload.material);
        break;
      case "band_decided": {
        const d = event.payload.decision;
        const list = this.decisionsByBand.get(d.bandId) ?? [];
        list.push({
          bandLogicalId: d.bandId,
          decision: d.decision,
          chosenMw: d.chosenMw,
          intervalLow: d.interval?.low,
          intervalHigh: d.interval?.high,
          reason: d.reason,
          at: event.at,
          eventId: event.id
        });
        this.decisionsByBand.set(d.bandId, list);
        break;
      }
    }
  }

  private ingest(material: Material): void {
    switch (material.kind) {
      case "image":
        this.image = material;
        break;
      case "orientation":
        this.orientation = material;
        break;
      case "exposure":
        this.exposure = material;
        break;
      case "ladderSpec":
        this.ladders.set(material.id, material);
        break;
      case "ladderAssignment":
        // lane 修订会更换 lane 材料 id，但 lane.logicalId 稳定；以 logicalId 关联
        this.assignmentsByLane.set(material.laneId, material);
        break;
      case "lane":
        this.lanesByLogical.set(material.logicalId, material);
        this.materialLogical.set(material.id, material.logicalId);
        break;
      case "band":
        this.bandsByLogical.set(material.logicalId, material);
        this.materialLogical.set(material.id, material.logicalId);
        break;
    }
  }
}

export function replay(events: Event[]): EventProjection {
  const projection = new EventProjection();
  const ordered = [...events].sort((a, b) => a.seq - b.seq || (a.id < b.id ? -1 : 1));
  for (const event of ordered) projection.apply(event);
  return projection;
}

// ---------- 计算视图（可在任意旧事件上重放，历史不被最新结果覆盖） ----------

export function computeViewAt(events: Event[], headEventId: string | null, budgetOverride?: number): ComputeOutcome {
  const prefix = eventsOnPath(events, headEventId);
  const projection = replay(prefix);
  const diagnostics: Diagnostic[] = [];
  let ops = 0;
  const budgetMax = budgetOverride ?? projection.params.budget.maxOps;

  if (!projection.meta) {
    return {
      kind: "incomplete",
      state: emptyView(projection, [], 0, budgetMax),
      diagnostics: [{ code: "case-not-created", message: "缺少 case_created 事件", severity: "error" }]
    };
  }
  if (!projection.image) {
    diagnostics.push({ code: "missing-image", message: "缺少原始图像材料", severity: "error" });
  }

  const image = projection.image;
  const rotation = projection.orientation?.rotationQuarterTurns ?? 0;
  const mirrored = projection.orientation?.mirrored ?? false;
  if (!projection.orientation) {
    diagnostics.push({ code: "missing-orientation", message: "缺少拍摄方向材料，坐标基准不完整", severity: "error" });
  }
  if (!projection.exposure) {
    diagnostics.push({
      code: "missing-exposure",
      message: "缺少曝光材料（曝光时间/增益/饱和值未知）",
      severity: "warning"
    });
  }

  const lanes = [...projection.lanesByLogical.values()].sort((a, b) => a.index - b.index || (a.id < b.id ? -1 : 1));
  const bands = [...projection.bandsByLogical.values()].sort(
    (a, b) => a.laneId.localeCompare(b.laneId) || a.center.y - b.center.y || (a.id < b.id ? -1 : 1)
  );

  const effective: Effective = {
    image,
    orientation: projection.orientation,
    exposure: projection.exposure,
    ladders: projection.ladders,
    assignments: projection.assignmentsByLane,
    lanes,
    bands
  };

  const imageDigest = image ? rasterDigest(image.raster) : { width: 0, height: 0, digest: "missing", saturated: false };
  const laneComputations: LaneComputation[] = [];

  const frame = image
    ? interpretedFrame(
        { frameId: "original", origin: "top-left", rotationQuarterTurns: 0, mirrored: false, width: image.width, height: image.height, unit: { kind: "pixels", label: "px" } },
        rotation,
        mirrored
      )
    : null;

  for (const lane of lanes) {
    const laneDiag: Diagnostic[] = [];
    let detection: DetectionArtifact | null = null;
    let calibration: LaneComputation["calibration"] = null;

    if (image && frame) {
      // lane 中心点是解释帧坐标；检测在解释帧光栅上进行
      const interpreted = ensureOrientedRaster(image, rotation, mirrored);
      ops += interpreted.width * interpreted.height;
      if (ops > budgetMax) {
        return {
          kind: "budget",
          opsUsed: ops,
          diagnostics: [{ code: "budget-exceeded", message: `资源预算耗尽：ops=${ops} > ${budgetMax}`, severity: "error" }],
          state: emptyView(projection, diagnostics, ops, budgetMax)
        };
      }
      const result = detectBands(interpreted, lane.center, lane.halfWidth, projection.params);
      ops += result.opsUsed;
      if (ops > budgetMax) {
        return {
          kind: "budget",
          opsUsed: ops,
          diagnostics: [{ code: "budget-exceeded", message: `资源预算耗尽：ops=${ops} > ${budgetMax}`, severity: "error" }],
          state: emptyView(projection, diagnostics, ops, budgetMax)
        };
      }
      const inputSummary: InputSummary = { image: imageDigest, laneId: lane.id };
      const detId = `det_${shortHash({ lane: lane.id, image: imageDigest, params: projection.paramsVersion })}`;
      const detectedViews: DetectedBandView[] = result.bands.map((b, i) => ({
        id: `${detId}_b${i}`,
        s: b.s,
        center: b.center,
        contour: b.contour,
        peakIntensity: b.peakIntensity,
        widthS: b.widthS,
        issues: b.issues,
        saturated: b.issues.includes("saturated") || b.peakIntensity >= 254
      }));
      detection = {
        id: detId,
        kind: "detection",
        paramsVersion: projection.paramsVersion,
        inputSummary,
        parentIds: [image.id, lane.id],
        adopted: true,
        laneId: lane.id,
        bands: detectedViews,
        noiseLevel: result.noiseLevel,
        profile: [],
        opsUsed: result.opsUsed
      };

      const assignment = findAssignment(projection, lane);
      if (assignment) {
        const spec = projection.ladders.get(assignment.ladderSpecId);
        if (!spec) {
          laneDiag.push({ code: "missing-ladder-spec", message: "ladder 指派引用了不存在的标称表", severity: "error", location: { kind: "material", id: assignment.id } });
        } else {
          const curve = buildCurve(lane.center);
          const arc = curve.cumulative[curve.cumulative.length - 1];
          const observed = result.bands.map((b) => ({ s: b.s, saturated: b.issues.includes("saturated") || b.peakIntensity >= 254 }));
          const core = calibrateLane({
            laneId: lane.id,
            ladderSpecId: spec.id,
            rungs: spec.rungs,
            observed,
            arcLength: arc,
            params: projection.params
          });
          const calId = `cal_${shortHash({ lane: lane.id, spec: spec.id, det: detId, params: projection.paramsVersion })}`;
          calibration = { ...core, id: calId, inputSummary, parentIds: [detId, spec.id, assignment.id], adopted: true, transferred: false, sourceLaneIds: [] };
        }
      } else if (lane.role === "ladder") {
        laneDiag.push({ code: "unassigned-ladder-lane", message: "ladder 泳道缺少标称指派", severity: "warning" });
      } else {
        calibration = transferCalibration(lane, lanes, projection, result.bands, imageDigest, projection.params);
        if (calibration?.diagnostics.length) laneDiag.push(...calibration.diagnostics);
      }
    } else {
      laneDiag.push({ code: "lane-without-image", message: "无法在缺少图像的情况下检测条带", severity: "error", location: { kind: "material", id: lane.id } });
    }

    laneComputations.push({ lane, detection, calibration, estimates: new Map(), diagnostics: laneDiag });
  }

  // ---------- 推断（人工材料 + 自动候选都保留） ----------
  const indexByLane = new Map(laneComputations.map((c) => [c.lane.logicalId, c]));
  for (const comp of laneComputations) {
    const manualBands = bands.filter((b) => b.laneId === comp.lane.id);
    for (const band of manualBands) {
      const curve = buildCurve(comp.lane.center);
      const proj = projectPoint(band.center, curve);
      const widthS = medianSpacing(comp.detection);
      const coreInput = {
        s: proj.s,
        widthS,
        issues: band.issues,
        overlapPartners: collectOverlapPartners(band, manualBands, comp.lane.center)
      };
      if (comp.calibration?.valid) {
        const core = estimateMw(coreInput, stripTransfer(comp.calibration));
        const est = finalizeEstimate(core, band, comp, projection, imageDigest);
        applyDecision(est, projection);
        comp.estimates.set(band.logicalId, est);
      } else {
        const est: BandEstimateView = {
          id: `est_${shortHash({ band: band.id, lane: comp.lane.id })}`,
          bandId: band.id,
          laneId: comp.lane.id,
          calibrationId: comp.calibration?.id ?? "none",
          paramsVersion: projection.paramsVersion,
          adopted: false,
          inputSummary: { image: imageDigest, laneId: comp.lane.id, bandCenterCount: 1 },
          parentIds: [band.id, comp.detection?.id ?? comp.lane.id, comp.calibration?.id ?? "none"].filter(Boolean),
          s: proj.s,
          candidates: [],
          status: "invalid",
          issues: band.issues,
          diagnostics: comp.calibration?.diagnostics ?? [{ code: "no-calibration", message: "该泳道没有可用局部标尺", severity: "error" }],
          evidence: { rungOrders: [], s: proj.s }
        };
        applyDecision(est, projection);
        comp.estimates.set(band.logicalId, est);
      }
    }

    // 自动候选：即使没有人工 band 材料，也呈现为可对比、可接受的候选
    if (comp.detection && !manualBands.length) {
      for (const db of comp.detection.bands) {
        const autoLogical = `auto:${comp.lane.logicalId}:${Math.round(db.s)}:${shortHash(db.center, 6)}`;
        if (comp.calibration?.valid) {
          const partners = db.issues.includes("overlap")
            ? comp.detection.bands.filter((o) => o.id !== db.id).map((o) => ({ bandId: o.id, s: o.s }))
            : undefined;
          const core = estimateMw(
            { s: db.s, widthS: db.widthS, issues: db.issues, overlapPartners: partners },
            stripTransfer(comp.calibration)
          );
          const est = finalizeEstimate(core, { ...db, logicalId: autoLogical, id: autoLogical, laneId: comp.lane.id, imageId: image?.id ?? "", origin: "auto", provenance: { sourceImageId: image?.id ?? "", originalPixel: db.center } } as unknown as BandMaterial, comp, projection, imageDigest, autoLogical);
          applyDecision(est, projection);
          comp.estimates.set(autoLogical, est);
        }
      }
    }
  }

  const allDiagnostics = [...diagnostics, ...laneComputations.flatMap((c) => [
    ...c.diagnostics,
    ...(c.calibration?.diagnostics ?? []),
    ...[...c.estimates.values()].flatMap((e) => e.diagnostics)
  ])];

  const decisions = [...projection.decisionsByBand.values()].flat();
  const conflict = detectConflicts(decisions);

  const state: StateView = {
    meta: projection.meta,
    headEventId: projection.headEventId ?? "",
    branch: projection.branch,
    params: projection.params,
    paramsVersion: projection.paramsVersion,
    effective,
    lanes: laneComputations,
    decisions,
    events: projection.events,
    conflict,
    diagnostics: allDiagnostics,
    opsUsed: ops,
    budgetMax
  };

  const errors = allDiagnostics.filter((d) => d.severity === "error");
  if (errors.length) return { kind: "incomplete", state, diagnostics: allDiagnostics };
  return { kind: "ok", state };
}

function eventsOnPath(events: Event[], headEventId: string | null): Event[] {
  if (!headEventId) return [...events].sort((a, b) => a.seq - b.seq);
  const byId = new Map(events.map((e) => [e.id, e]));
  const path: Event[] = [];
  let cur = byId.get(headEventId);
  const guard = new Set<string>();
  while (cur) {
    if (guard.has(cur.id)) break;
    guard.add(cur.id);
    path.push(cur);
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return path.sort((a, b) => a.seq - b.seq || (a.id < b.id ? -1 : 1));
}

function emptyView(projection: EventProjection, diagnostics: Diagnostic[], opsUsed: number, budgetMax: number): StateView {
  const lanes = [...projection.lanesByLogical.values()].sort((a, b) => a.index - b.index);
  const bands = [...projection.bandsByLogical.values()];
  return {
    meta: projection.meta ?? { caseId: "", title: "", scenario: "", note: "", createdAt: "" },
    headEventId: projection.headEventId ?? "",
    branch: projection.branch,
    params: projection.params,
    paramsVersion: projection.paramsVersion,
    effective: {
      image: projection.image,
      orientation: projection.orientation,
      exposure: projection.exposure,
      ladders: projection.ladders,
      assignments: projection.assignmentsByLane,
      lanes,
      bands
    },
    lanes: lanes.map((lane) => ({ lane, detection: null, calibration: null, estimates: new Map(), diagnostics: [] })),
    decisions: [...projection.decisionsByBand.values()].flat(),
    events: projection.events,
    conflict: [],
    diagnostics,
    opsUsed,
    budgetMax
  };
}

const rasterCache = new Map<string, ReturnType<typeof rotateRasterIntoPlace>>();
function ensureOrientedRaster(image: ImageMaterial, rotation: 0 | 1 | 2 | 3, mirrored: boolean) {
  const key = `${image.id}:${rotation}:${mirrored}`;
  const cached = rasterCache.get(key);
  if (cached) return cached;
  const out = rotateRasterIntoPlace(image, rotation, mirrored);
  rasterCache.set(key, out);
  return out;
}

function rotateRasterIntoPlace(image: ImageMaterial, rotation: 0 | 1 | 2 | 3, mirrored: boolean) {
  const src = image.raster;
  let working = src.grayscale;
  let w = src.width;
  let h = src.height;
  if (mirrored) {
    const dst = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) dst[y * w + (w - 1 - x)] = working[y * w + x];
    working = dst;
  }
  if (rotation === 0) {
    return { width: w, height: h, grayscale: working, saturated: src.saturated };
  }
  const swap = rotation % 2 === 1;
  const ow = swap ? h : w;
  const oh = swap ? w : h;
  const dst = new Uint8Array(ow * oh);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let nx = x;
      let ny = y;
      if (rotation === 1) {
        nx = h - 1 - y;
        ny = x;
      } else if (rotation === 2) {
        nx = w - 1 - x;
        ny = h - 1 - y;
      } else {
        nx = y;
        ny = w - 1 - x;
      }
      dst[ny * ow + nx] = working[y * w + x];
    }
  }
  return { width: ow, height: oh, grayscale: dst, saturated: src.saturated };
}

function findAssignment(projection: EventProjection, lane: LaneMaterial): LadderAssignmentMaterial | undefined {
  const direct = projection.assignmentsByLane.get(lane.id);
  if (direct) return direct;
  // lane 修订换 id 后，旧指派指向旧 lane；按 logicalId 找回
  for (const assignment of projection.assignmentsByLane.values()) {
    const referencedLane = projection.lanesByLogical.get(assignment.laneId) ?? lookupByLogical(projection, assignment.laneId);
    if (referencedLane && referencedLane.logicalId === lane.logicalId) return assignment;
  }
  return undefined;
}

function lookupByLogical(projection: EventProjection, id: string): LaneMaterial | undefined {
  for (const lane of projection.lanesByLogical.values()) if (lane.id === id || lane.logicalId === id) return lane;
  return undefined;
}

function medianSpacing(detection: DetectionArtifact | null): number {
  if (!detection || detection.bands.length < 2) return 4;
  const ss = detection.bands.map((b) => b.s).sort((a, b) => a - b);
  const gaps = ss.slice(1).map((s, i) => s - ss[i]);
  gaps.sort((a, b) => a - b);
  return gaps[Math.floor(gaps.length / 2)] / 2 || 4;
}

function collectOverlapPartners(band: BandMaterial, allBands: BandMaterial[], center: Vec2[]) {
  if (!band.overlapGroupId) return undefined;
  const curve = buildCurve(center);
  return allBands
    .filter((b) => b.overlapGroupId === band.overlapGroupId && b.logicalId !== band.logicalId)
    .map((b) => ({ bandId: b.id, s: projectPoint(b.center, curve).s }));
}

function stripTransfer(cal: NonNullable<LaneComputation["calibration"]>): CalibrationCore {
  const { id: _id, adopted: _a, inputSummary: _i, parentIds: _p, transferred: _t, sourceLaneIds: _s, ...core } = cal;
  return core;
}

function finalizeEstimate(
  core: EstimateCore,
  band: BandMaterial,
  comp: LaneComputation,
  projection: EventProjection,
  imageDigest: ReturnType<typeof rasterDigest>,
  logicalOverride?: string
): BandEstimateView {
  const logicalId = logicalOverride ?? band.logicalId;
  const calId = comp.calibration?.id ?? "none";
  const id = `est_${shortHash({ band: band.id, lane: comp.lane.id, cal: calId, params: projection.paramsVersion })}`;
  const adoptedByDefault = core.status === "unique" || core.status === "interval";
  const est: BandEstimateView = {
    ...core,
    id,
    bandId: band.id,
    laneId: comp.lane.id,
    calibrationId: calId,
    paramsVersion: projection.paramsVersion,
    adopted: adoptedByDefault,
    inputSummary: { image: imageDigest, laneId: comp.lane.id, bandCenterCount: 1 },
    parentIds: [band.id, comp.detection?.id ?? comp.lane.id, calId].filter((x) => x && x !== "none")
  };
  void logicalId;
  return est;
}

function applyDecision(est: BandEstimateView, projection: EventProjection): void {
  const history = projection.decisionsByBand.get(bandLogicalKey(est, projection)) ?? [];
  const latest = history[history.length - 1];
  if (!latest) {
    if (est.status === "candidate") est.adopted = false;
    return;
  }
  est.decision = latest;
  if (latest.decision === "reject") {
    est.adopted = false;
    est.status = "invalid";
  } else if (latest.decision === "accept") {
    est.adopted = true;
    if (latest.chosenMw) {
      est.point = { nominal: latest.chosenMw, da: latest.chosenMw.value ?? est.point?.da ?? 0, segmentIndex: est.evidence.segmentIndex ?? -1, inValidRange: true, method: "localPiecewise" };
      est.candidates = est.candidates.length ? est.candidates : est.point ? [est.point] : [];
      est.status = "unique";
    }
  } else if (latest.decision === "interval") {
    est.adopted = true;
    est.status = "interval";
  }
}

function bandLogicalKey(est: BandEstimateView, projection: EventProjection): string {
  if (est.bandId.startsWith("auto:")) return est.bandId;
  return projection.materialLogical.get(est.bandId) ?? est.bandId;
}

function detectConflicts(decisions: DecisionView[]): StateView["conflict"] {
  const byBand = new Map<string, DecisionView[]>();
  for (const d of decisions) {
    const list = byBand.get(d.bandLogicalId) ?? [];
    list.push(d);
    byBand.set(d.bandLogicalId, list);
  }
  const conflict: StateView["conflict"] = [];
  for (const [logicalId, list] of byBand) {
    const kinds = new Set(list.map((d) => d.decision));
    if (kinds.has("accept") && kinds.has("reject")) conflict.push({ logicalId, decisions: list });
  }
  return conflict;
}

// 微笑泳道：同一像素高度不是同一分子量。样道自身无 ladder 时，
// 用左右相邻 ladder 各自的局部标尺夹逼，并显式标注来源与有效区域。
function transferCalibration(
  targetLane: LaneMaterial,
  allLanes: LaneMaterial[],
  projection: EventProjection,
  _targetBands: DetectedBand[],
  imageDigest: ReturnType<typeof rasterDigest>,
  params: GelParams
): LaneComputation["calibration"] {
  if (!projection.image || !projection.orientation) return null;
  const raster = ensureOrientedRaster(
    projection.image,
    projection.orientation.rotationQuarterTurns,
    projection.orientation.mirrored
  );

  const neighbors = allLanes
    .map((lane) => {
      const assignment = findAssignment(projection, lane);
      const spec = assignment ? projection.ladders.get(assignment.ladderSpecId) : undefined;
      return lane.role === "ladder" && assignment && spec ? { lane, assignment, spec } : null;
    })
    .filter((x): x is { lane: LaneMaterial; assignment: LadderAssignmentMaterial; spec: LadderSpecMaterial } => !!x);

  if (neighbors.length === 0) {
    return {
      id: `cal_transfer_${shortHash({ lane: targetLane.id, none: true })}`,
      kind: "calibration",
      paramsVersion: params.version,
      inputSummary: { image: imageDigest, laneId: targetLane.id },
      parentIds: [targetLane.id],
      adopted: false,
      laneId: targetLane.id,
      ladderSpecId: "",
      valid: false,
      rungs: [],
      segments: [],
      validRange: null,
      residuals: [],
      globalFit: { slope: 0, intercept: 0, r2: 0 },
      diagnostics: [
        {
          code: "no-local-ruler",
          message: "样道没有自身 ladder，且找不到可夹逼的相邻 ladder；局部标尺缺失",
          severity: "error",
          location: { kind: "material", id: targetLane.id }
        }
      ],
      transferred: true,
      sourceLaneIds: []
    };
  }

  // 对每个相邻 ladder 重新检测并校准，再把目标 lane 的 s 与源 lane 几何位置配对
  const sources = neighbors.map(({ lane, spec }) => {
    const detection = detectBands(raster, lane.center, lane.halfWidth, params);
    const curve = buildCurve(lane.center);
    const arc = curve.cumulative[curve.cumulative.length - 1];
    const core = calibrateLane({
      laneId: lane.id,
      ladderSpecId: spec.id,
      rungs: spec.rungs,
      observed: detection.bands.map((b) => ({ s: b.s, saturated: b.issues.includes("saturated") })),
      arcLength: arc,
      params
    });
    const laneX = lane.center[Math.floor(lane.center.length / 2)].x;
    return { lane, spec, core, laneX };
  });

  const targetX = targetLane.center[Math.floor(targetLane.center.length / 2)].x;
  sources.sort((a, b) => Math.abs(a.laneX - targetX) - Math.abs(b.laneX - targetX));
  const chosen = sources.slice(0, 2);

  // 目标 lane 弧长区间（取所有源的公共有效区间），微笑导致边界略不同
  let sMin = -Infinity;
  let sMax = Infinity;
  for (const src of chosen) {
    if (!src.core.validRange) continue;
    sMin = Math.max(sMin, src.core.validRange.sMin);
    sMax = Math.min(sMax, src.core.validRange.sMax);
  }
  const validRange = Number.isFinite(sMin) && Number.isFinite(sMax) && sMin < sMax ? { sMin, sMax } : null;

  // 用最贴近的源标尺作为分段结构（同一张胶 ladder 规格一致时成立）
  const ref = chosen[0];
  const inputSummary: InputSummary = { image: imageDigest, laneId: targetLane.id };
  const calId = `cal_transfer_${shortHash({ lane: targetLane.id, sources: chosen.map((s) => s.lane.id), params: params.version })}`;
  return {
    id: calId,
    kind: "calibration",
    paramsVersion: params.version,
    inputSummary,
    parentIds: [targetLane.id, ...chosen.map((s) => s.lane.id)],
    adopted: true,
    laneId: targetLane.id,
    ladderSpecId: ref.spec.id,
    valid: !!validRange,
    rungs: ref.core.rungs,
    segments: ref.core.segments,
    validRange,
    residuals: ref.core.residuals,
    globalFit: ref.core.globalFit,
    diagnostics: validRange
      ? [
          {
            code: "ruler-transferred-smile",
            message: `标尺由相邻 ladder 泳道 ${chosen.map((s) => s.lane.label).join("/")} 夹逼转移：有效区域仅为公共区间，同高度不等于同分子量`,
            severity: "warning"
          }
        ]
      : [
          {
            code: "transfer-no-common-range",
            message: "相邻 ladder 的局部标尺没有公共有效区域，微笑弯曲下无法转移",
            severity: "error"
          }
        ],
    transferred: true,
    sourceLaneIds: chosen.map((s) => s.lane.id)
  };
}

export function computeView(events: Event[], budgetOverride?: number): ComputeOutcome {
  const head = [...events].sort((a, b) => b.seq - a.seq)[0]?.id ?? null;
  return computeViewAt(events, head, budgetOverride);
}
