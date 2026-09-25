import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type {
  BandMaterial,
  ExposureMaterial,
  ImageMaterial,
  LaneMaterial,
  LadderSpecMaterial,
  Material,
  OrientationMaterial,
  ProjectState
} from "../shared/domain.js";
import { contentId, sha256Hex } from "../shared/ids.js";
import { parseQty } from "../shared/quantities.js";
import { DEFAULT_PARAMS, reviseParams, type ParamPack } from "../shared/params.js";
import { rotatePointCw, rotatedDimensions } from "../shared/geometry.js";
import { decodePng, detectGel, rotateCw, encodePng } from "./image.js";
import { buildCasePack, CASE_PACK_FORMAT, type CasePackManifest, type CasePackScenarioSpec } from "./casepack-gen.js";
import type { Store } from "./store.js";

export interface ScenarioResult {
  scenarioId: string;
  ok: boolean;
  status: "applied" | "asserted" | "already-applied" | "failed";
  inputFragment: unknown;
  evidenceFound: string[];
  evidenceMissing: string[];
  affectedObjectIds: string[];
  changedFitLaneOrdinals: number[];
  unchangedFitLaneOrdinals: number[];
  message: string;
}

export interface ReplayReport {
  projectId: string;
  results: ScenarioResult[];
  finalState: ProjectState;
}

const DETECTOR_VERSION = "gel-detect-1.0.0";

function materialId(kind: string, payload: unknown): string {
  return contentId("mat", { kind, payload });
}

export class CasePackService {
  readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
    if (!existsSync(path.join(dir, "gel-case-pack.json")) || !existsSync(path.join(dir, "gel-case-pack.png"))) {
      buildCasePack(dir);
    }
  }

  loadPack(): { manifest: CasePackManifest; png: Buffer } {
    const jsonPath = path.join(this.dir, "gel-case-pack.json");
    const pngPath = path.join(this.dir, "gel-case-pack.png");
    const raw = readFileSync(jsonPath, "utf8");
    const manifest = JSON.parse(raw) as CasePackManifest;
    if (manifest.format !== CASE_PACK_FORMAT) throw new Error(`未知案例包格式：${manifest.format}`);
    const png = readFileSync(pngPath);
    if (sha256Hex(png) !== manifest.image.sha256) throw new Error("案例包图像 sha256 校验失败");
    return { manifest, png };
  }

  info(): { id: string; title: string; narrative: string; scenarios: { id: string; title: string; description: string; kind: string }[] } {
    const { manifest } = this.loadPack();
    return {
      id: manifest.id,
      title: manifest.title,
      narrative: manifest.narrative,
      scenarios: manifest.scenarios.map((s) => ({ id: s.id, title: s.title, description: s.description, kind: s.kind }))
    };
  }

  materialize(store: Store): { projectId: string; state: ProjectState } {
    const { manifest, png } = this.loadPack();
    const projectId = store.createProject(manifest.title, DEFAULT_PARAMS);
    const blobId = store.putBlob(png, "image/png");

    const image: ImageMaterial = {
      kind: "image",
      id: materialId("image", { sha: manifest.image.sha256, frame: "raw" }),
      frame: "raw",
      mediaType: "image/png",
      blobId,
      width: manifest.image.width,
      height: manifest.image.height,
      sha256: manifest.image.sha256,
      capturedAt: manifest.image.capturedAt,
      derivedFromImageId: null,
      transform: null
    };
    const orientation: OrientationMaterial = {
      kind: "orientation",
      id: materialId("orientation", { image: image.id, deg: manifest.orientation.clockwiseDegrees }),
      imageId: image.id,
      frame: "raw",
      clockwiseDegrees: parseQty(manifest.orientation.clockwiseDegrees),
      timeBase: manifest.orientation.timeBase
    };
    const exposure: ExposureMaterial = {
      kind: "exposure",
      id: materialId("exposure", { image: image.id }),
      imageId: image.id,
      frame: "raw",
      exposureDuration: parseQty(manifest.exposure.exposureDuration),
      gainRaw: manifest.exposure.gainRaw,
      maxIntensity: 255,
      saturationLevelRaw: manifest.exposure.saturationLevelRaw,
      pixelValueRange: manifest.exposure.pixelValueRange,
      coordinateBasis: manifest.exposure.coordinateBasis
    };
    const ladderSpec: LadderSpecMaterial = {
      kind: "ladder-spec",
      id: materialId("ladder-spec", { name: manifest.ladderSpec.name, bands: manifest.ladderSpec.bands }),
      name: manifest.ladderSpec.name,
      dimension: manifest.ladderSpec.dimension,
      bands: manifest.ladderSpec.bands.map((b) => ({ ordinal: b.ordinal, present: b.present, nominal: parseQty(b.nominal) })),
      rawPreservationNote: "标称值以原始字符串保存，派生层才做单位规范化；无法转换的值保留在原位置并附诊断"
    };

    const lanes: LaneMaterial[] = manifest.groundTruth.lanes.map((l) => ({
      kind: "lane",
      id: materialId("lane", { image: image.id, ordinal: l.ordinal, polyline: l.polyline }),
      imageId: image.id,
      frame: "raw",
      laneOrdinal: l.ordinal,
      role: l.role,
      ladderSpecId: l.role === "ladder" ? ladderSpec.id : null,
      polyline: l.polyline,
      widthPx: l.halfWidth * 2,
      provenance: { frame: "raw", origin: "manual", detectorVersion: null, sourceImageId: image.id, pixelUncertainty: 0.5 },
      baseLaneId: null
    }));

    const img = decodePng(png);
    const detection = detectGel(img, DEFAULT_PARAMS);
    const laneBySeed = (seedX: number) => lanes.reduce((best, l) => Math.abs(l.polyline[0]!.x - seedX) < Math.abs(best.polyline[0]!.x - seedX) ? l : best, lanes[0]!);
    const autoBands: BandMaterial[] = [];
    detection.lanes.forEach((dl, li) => {
      const lane = laneBySeed(dl.seedX);
      for (const db of detection.bands[li] ?? []) {
        autoBands.push({
          kind: "band",
          id: materialId("band", { lane: lane.id, center: db.center, origin: "auto" }),
          laneId: lane.id,
          imageId: image.id,
          frame: "raw",
          center: { x: Math.round(db.center.x * 100) / 100, y: Math.round(db.center.y * 100) / 100 },
          centerUncertaintyPx: DEFAULT_PARAMS.centerUncertaintyPx,
          widthPx: db.widthPx,
          heightPx: Math.round(db.heightPx * 100) / 100,
          peakIntensity: db.peakIntensity,
          saturated: db.saturated,
          tailing: db.tailing,
          overlapGroupId: db.overlapGroupKey ? contentId("ovg", { key: db.overlapGroupKey }) : null,
          provenance: { frame: "raw", origin: "auto", detectorVersion: DETECTOR_VERSION, sourceImageId: image.id, pixelUncertainty: 1.5 }
        });
      }
    });

    const manualBands: BandMaterial[] = [];
    const retractedAuto: string[] = [];
    for (const rev of manifest.manualRevisions) {
      const lane = lanes.find((l) => l.laneOrdinal === rev.laneOrdinal);
      if (!lane) continue;
      if (rev.type === "revise-center") {
        const target = autoBands
          .filter((b) => b.laneId === lane.id)
          .sort((a, b) => Math.hypot(a.center.x - rev.at.x, a.center.y - rev.at.y) - Math.hypot(b.center.x - rev.at.x, b.center.y - rev.at.y))[0];
        if (!target) continue;
        retractedAuto.push(target.id);
        manualBands.push({
          ...target,
          id: materialId("band", { lane: lane.id, center: rev.center, origin: "manual" }),
          center: rev.center,
          provenance: { frame: "raw", origin: "manual", detectorVersion: null, sourceImageId: image.id, pixelUncertainty: 0.5 }
        });
      } else {
        manualBands.push({
          kind: "band",
          id: materialId("band", { lane: lane.id, center: rev.center, origin: "manual" }),
          laneId: lane.id,
          imageId: image.id,
          frame: "raw",
          center: rev.center,
          centerUncertaintyPx: 1,
          widthPx: rev.widthPx,
          heightPx: rev.heightPx,
          peakIntensity: 74,
          saturated: false,
          tailing: "none",
          overlapGroupId: null,
          provenance: { frame: "raw", origin: "manual", detectorVersion: null, sourceImageId: image.id, pixelUncertainty: 1 }
        });
      }
    }

    const materials: Material[] = [image, orientation, exposure, ladderSpec, ...lanes, ...autoBands, ...manualBands];
    store.addMaterials(projectId, materials);

    if (retractedAuto.length > 0 || manualBands.length > 0) {
      const existing = store.getState(projectId);
      const already = existing.events.some((e) => e.kind === "retraction" && (e as { reason?: string }).reason?.includes("人工修订基线"));
      if (!already) {
        store.appendEvent(projectId, "main", {
          kind: "retraction",
          at: "2026-09-19T10:05:00+09:00",
          retractedMaterialIds: retractedAuto,
          replacementMaterialIds: manualBands.map((b) => b.id),
          reason: "人工修订基线：自动候选与人工修订同时保留，未采纳的自动候选不删除",
          author: "case-pack"
        });
      }
    }
    return { projectId, state: store.getState(projectId) };
  }

  private gtCenter(manifest: CasePackManifest, laneOrdinal: number, nominal: string): { x: number; y: number } | null {
    const gt = manifest.groundTruth.bands.find((b) => b.laneOrdinal === laneOrdinal && b.nominal === nominal);
    return gt ? gt.center : null;
  }

  private activeBandNear(state: ProjectState, laneOrdinal: number, point: { x: number; y: number }): BandMaterial | null {
    const lanes = Object.values(state.materials).filter((m): m is LaneMaterial => m.kind === "lane" && m.frame === state.activeFrame && m.laneOrdinal === laneOrdinal);
    const lane = lanes[0];
    if (!lane) return null;
    const bands = Object.values(state.materials).filter((m): m is BandMaterial => m.kind === "band" && m.laneId === lane.id && m.frame === state.activeFrame);
    return bands.sort((a, b) => Math.hypot(a.center.x - point.x, a.center.y - point.y) - Math.hypot(b.center.x - point.x, b.center.y - point.y))[0] ?? null;
  }

  private fitIds(state: ProjectState): Map<number, string> {
    const map = new Map<number, string>();
    for (const fit of state.computation?.fits ?? []) {
      const lane = state.materials[fit.ladderLaneId];
      if (lane && lane.kind === "lane") map.set(lane.laneOrdinal, fit.id);
    }
    return map;
  }

  private evidenceCodes(state: ProjectState): Set<string> {
    return new Set((state.computation?.diagnostics ?? []).map((d) => d.code));
  }

  private evaluateExpect(scenario: CasePackScenarioSpec, before: ProjectState, after: ProjectState, affected: string[]): ScenarioResult {
    const codes = this.evidenceCodes(after);
    const expected = scenario.expect.evidenceCodes ?? [];
    const missing = expected.filter((c) => !codes.has(c));
    const beforeFits = this.fitIds(before);
    const afterFits = this.fitIds(after);
    const changedExpected = scenario.expect.changedFitLaneOrdinals ?? [];
    const unchangedExpected = scenario.expect.unchangedFitLaneOrdinals ?? [];
    const changedOk = changedExpected.every((o) => beforeFits.get(o) !== undefined && afterFits.get(o) !== undefined && beforeFits.get(o) !== afterFits.get(o));
    const unchangedOk = unchangedExpected.every((o) => beforeFits.get(o) !== undefined && afterFits.get(o) !== undefined && beforeFits.get(o) === afterFits.get(o));
    const ok = missing.length === 0 && changedOk && unchangedOk;
    return {
      scenarioId: scenario.id,
      ok,
      status: ok ? (scenario.kind === "assert" ? "asserted" : "applied") : "failed",
      inputFragment: scenario.mutate,
      evidenceFound: expected.filter((c) => codes.has(c)),
      evidenceMissing: missing,
      affectedObjectIds: affected,
      changedFitLaneOrdinals: changedExpected.filter((o) => beforeFits.get(o) !== afterFits.get(o)),
      unchangedFitLaneOrdinals: unchangedExpected.filter((o) => beforeFits.get(o) === afterFits.get(o)),
      message: ok ? "满足预期" : `缺少证据 ${missing.join(", ")} 或局部失效范围不符`
    };
  }

  applyScenario(store: Store, projectId: string, scenarioId: string): { result: ScenarioResult; state: ProjectState } {
    const { manifest, png } = this.loadPack();
    const scenario = manifest.scenarios.find((s) => s.id === scenarioId);
    if (!scenario) throw new Error(`未知场景：${scenarioId}`);
    const before = store.getState(projectId);
    const affected: string[] = [];

    if (scenario.kind === "assert" || !scenario.mutate) {
      const result = this.evaluateExpect(scenario, before, before, affected);
      return { result, state: before };
    }

    const mutate = scenario.mutate;
    const now = "2026-09-19T10:20:00+09:00";

    if (mutate.type === "param-revision") {
      const key = Object.keys(mutate.patch)[0] as keyof ParamPack;
      if (before.params[key] === mutate.patch[key as keyof typeof mutate.patch]) {
        const result = this.evaluateExpect(scenario, before, before, affected);
        result.status = "already-applied";
        return { result, state: before };
      }
      const next = reviseParams(before.params, mutate.patch as Partial<ParamPack>);
      store.appendEvent(projectId, "main", {
        kind: "param-revision",
        at: now,
        fromParamsVersion: before.paramsVersion,
        toParamsVersion: next.version,
        patch: mutate.patch,
        rationale: scenario.description,
        author: "case-pack"
      });
      affected.push(next.version);
    }

    if (mutate.type === "rotate") {
      if (before.activeFrame === "rotated") {
        const result = this.evaluateExpect(scenario, before, before, affected);
        result.status = "already-applied";
        return { result, state: before };
      }
      const rawImage = Object.values(before.materials).find((m): m is ImageMaterial => m.kind === "image" && m.frame === "raw");
      if (!rawImage) throw new Error("缺少原始图像材料");
      const blob = store.getBlob(rawImage.blobId);
      if (!blob) throw new Error("缺少图像 blob");
      const rotated = rotateCw(decodePng(blob.data), mutate.clockwiseDegrees);
      const rotatedPng = encodePng(rotated);
      const rotatedBlobId = store.putBlob(rotatedPng, "image/png");
      const [rw, rh] = rotatedDimensions(rawImage.width, rawImage.height, mutate.clockwiseDegrees);
      const rotatedImage: ImageMaterial = {
        kind: "image",
        id: materialId("image", { sha: sha256Hex(rotatedPng), frame: "rotated" }),
        frame: "rotated",
        mediaType: "image/png",
        blobId: rotatedBlobId,
        width: rw,
        height: rh,
        sha256: sha256Hex(rotatedPng),
        capturedAt: rawImage.capturedAt,
        derivedFromImageId: rawImage.id,
        transform: { type: "rotate", clockwiseDegrees: mutate.clockwiseDegrees }
      };
      const rotatedOrientation: OrientationMaterial = {
        kind: "orientation",
        id: materialId("orientation", { image: rotatedImage.id, deg: mutate.clockwiseDegrees }),
        imageId: rotatedImage.id,
        frame: "rotated",
        clockwiseDegrees: parseQty(`${mutate.clockwiseDegrees} deg`),
        timeBase: "拍摄时钟 Asia/Tokyo；旋转为派生帧，原图保留"
      };
      const rotatedMaterials: Material[] = [rotatedImage, rotatedOrientation];
      const retracted: string[] = [];
      const replacements: string[] = [];
      const laneIdMap = new Map<string, string>();
      for (const m of Object.values(before.materials)) {
        if (m.kind === "lane" && m.frame === "raw") {
          const polyline = m
            .polyline.map((p) => rotatePointCw(p, mutate.clockwiseDegrees, rawImage.width, rawImage.height))
            .reverse();
          const nl: LaneMaterial = {
            ...m,
            id: materialId("lane", { base: m.id, frame: "rotated" }),
            imageId: rotatedImage.id,
            frame: "rotated",
            polyline,
            provenance: { ...m.provenance, frame: "rotated", sourceImageId: rotatedImage.id },
            baseLaneId: m.id
          };
          rotatedMaterials.push(nl);
          laneIdMap.set(m.id, nl.id);
          retracted.push(m.id);
          replacements.push(nl.id);
        }
      }
      for (const m of Object.values(before.materials)) {
        if (m.kind === "band" && m.frame === "raw") {
          const center = rotatePointCw(m.center, mutate.clockwiseDegrees, rawImage.width, rawImage.height);
          const nb: BandMaterial = {
            ...m,
            id: materialId("band", { base: m.id, frame: "rotated" }),
            laneId: laneIdMap.get(m.laneId) ?? m.laneId,
            imageId: rotatedImage.id,
            frame: "rotated",
            center,
            provenance: { ...m.provenance, frame: "rotated", sourceImageId: rotatedImage.id }
          };
          rotatedMaterials.push(nb);
          retracted.push(m.id);
          replacements.push(nb.id);
        }
      }
      store.addMaterials(projectId, rotatedMaterials);
      store.appendEvent(projectId, "main", {
        kind: "retraction",
        at: now,
        retractedMaterialIds: retracted,
        replacementMaterialIds: replacements,
        reason: `rotate:${mutate.clockwiseDegrees} 只改动拍摄方向来源，派生旋转帧材料，原图保留`,
        author: "case-pack"
      });
      affected.push(rotatedImage.id);
    }

    if (mutate.type === "missing-band") {
      const gt = this.gtCenter(manifest, mutate.ladderLaneOrdinal, mutate.nominal);
      if (!gt) throw new Error(`案例包缺少标称 ${mutate.nominal}`);
      const point = before.activeFrame === "rotated"
        ? rotatePointCw(gt, 90, manifest.image.width, manifest.image.height)
        : gt;
      const band = this.activeBandNear(before, mutate.ladderLaneOrdinal, point);
      if (!band) {
        const result = this.evaluateExpect(scenario, before, before, affected);
        result.status = "already-applied";
        return { result, state: before };
      }
      store.appendEvent(projectId, "main", {
        kind: "retraction",
        at: now,
        retractedMaterialIds: [band.id],
        replacementMaterialIds: [],
        reason: `missing-band:${mutate.nominal} 只撤回一条 ladder 直接来源，其余材料不变`,
        author: "case-pack"
      });
      affected.push(band.id);
    }

    if (mutate.type === "nonmonotonic-spec") {
      const spec = Object.values(before.materials).find((m): m is LadderSpecMaterial => m.kind === "ladder-spec");
      if (!spec) throw new Error("缺少 ladder 标称规格");
      const lane3Check = Object.values(before.materials).find((m): m is LaneMaterial => m.kind === "lane" && m.role === "ladder" && m.frame === before.activeFrame && m.laneOrdinal === 3);
      const alreadyOverride = lane3Check && before.events.some((e) => e.kind === "decision" && (e as { targetKind?: string; targetId?: string }).targetKind === "calibration" && (e as { targetId?: string }).targetId === lane3Check.id);
      if (alreadyOverride) {
        const result = this.evaluateExpect(scenario, before, before, affected);
        result.status = "already-applied";
        return { result, state: before };
      }
      const newSpec: LadderSpecMaterial = {
        ...spec,
        id: materialId("ladder-spec", { name: `${spec.name}#conflict-${mutate.badNominal}`, bands: spec.bands.map((b) => (b.ordinal === mutate.badOrdinal ? mutate.badNominal : b.nominal.raw)) }),
        name: `${spec.name}#冲突规格`,
        bands: spec.bands.map((b) => (b.ordinal === mutate.badOrdinal ? { ...b, nominal: parseQty(mutate.badNominal) } : b))
      };
      store.addMaterials(projectId, [newSpec]);
      const lane3 = Object.values(before.materials).find((m): m is LaneMaterial => m.kind === "lane" && m.role === "ladder" && m.frame === before.activeFrame && m.laneOrdinal === 3);
      if (!lane3) throw new Error("未找到 ladder#3");
      store.appendEvent(projectId, "main", {
        kind: "decision",
        at: now,
        verb: "revise",
        targetKind: "calibration",
        targetId: lane3.id,
        valueRaw: newSpec.id,
        rationale: `ladder#3 改用冲突标称规格 ${newSpec.id}（第 ${mutate.badOrdinal} 档 ${mutate.badNominal}），原规格保留给 ladder#0`,
        author: "case-pack",
        paramsVersion: before.paramsVersion,
        derivedFromComputationId: before.computation?.id ?? null
      });
      affected.push(newSpec.id);
    }

    if (mutate.type === "local-revision") {
      const gt = this.gtCenter(manifest, mutate.ladderLaneOrdinal, mutate.nominal);
      if (!gt) throw new Error(`案例包缺少标称 ${mutate.nominal}`);
      const rawShifted = { x: gt.x, y: gt.y + mutate.shiftArcPx };
      const point = before.activeFrame === "rotated"
        ? rotatePointCw(rawShifted, 90, manifest.image.width, manifest.image.height)
        : rawShifted;
      const findPoint = before.activeFrame === "rotated"
        ? rotatePointCw(gt, 90, manifest.image.width, manifest.image.height)
        : gt;
      const band = this.activeBandNear(before, mutate.ladderLaneOrdinal, findPoint);
      if (!band) throw new Error("未找到要修订的 ladder 条带");
      const already = before.events.some((e) => e.kind === "retraction" && (e as { reason?: string }).reason?.includes(`local-revision:${mutate.nominal}`));
      if (already) {
        const result = this.evaluateExpect(scenario, before, before, affected);
        result.status = "already-applied";
        return { result, state: before };
      }
      const revised: BandMaterial = {
        ...band,
        id: materialId("band", { base: band.id, revisedCenter: point }),
        center: { x: Math.round(point.x * 100) / 100, y: Math.round(point.y * 100) / 100 },
        provenance: { ...band.provenance, origin: "manual", detectorVersion: null }
      };
      store.addMaterials(projectId, [revised]);
      store.appendEvent(projectId, "main", {
        kind: "retraction",
        at: now,
        retractedMaterialIds: [band.id],
        replacementMaterialIds: [revised.id],
        reason: `local-revision:${mutate.nominal} 人工修订 ladder 条带中心 +${mutate.shiftArcPx}px，仅局部派生失效`,
        author: "case-pack"
      });
      affected.push(band.id, revised.id);
    }

    if (mutate.type === "conflict") {
      if (before.branches[mutate.branch] !== undefined) {
        const result = this.evaluateExpect(scenario, before, before, affected);
        result.status = "already-applied";
        return { result, state: before };
      }
      const gt = manifest.groundTruth.bands.find((b) => b.kind === "overlap-a");
      if (!gt) throw new Error("案例包缺少重叠双峰");
      const point = before.activeFrame === "rotated"
        ? rotatePointCw(gt.center, 90, manifest.image.width, manifest.image.height)
        : gt.center;
      const band = this.activeBandNear(before, gt.laneOrdinal, point);
      if (!band) throw new Error("未找到重叠条带");
      const inference = (before.computation?.bandInferences ?? []).find((bi) => bi.bandId === band.id);
      if (!inference) throw new Error("未找到重叠条带的推断");
      const headId = before.atEventId;
      store.appendEvent(projectId, "main", {
        kind: "decision",
        at: now,
        verb: "accept",
        targetKind: "band-mw",
        targetId: inference.id,
        valueRaw: inference.candidates[0]?.raw ?? inference.estimate?.raw ?? null,
        rationale: "main 分支：接受重叠候选中的第一个值",
        author: "reviewer-a",
        paramsVersion: before.paramsVersion,
        derivedFromComputationId: before.computation?.id ?? null
      });
      store.appendEvent(projectId, "main", {
        kind: "branch",
        at: now,
        newBranch: mutate.branch,
        fromEventId: headId ?? "genesis",
        author: "case-pack"
      });
      store.appendEvent(projectId, mutate.branch, {
        kind: "decision",
        at: now,
        verb: "reject",
        targetKind: "band-mw",
        targetId: inference.id,
        valueRaw: null,
        rationale: "reviewer-b 分支：否定该候选，认为重叠未解卷积不应定值",
        author: "reviewer-b",
        paramsVersion: before.paramsVersion,
        derivedFromComputationId: before.computation?.id ?? null
      });
      affected.push(inference.id);
    }

    const after = store.getState(projectId);
    const result = this.evaluateExpect(scenario, before, after, affected);
    return { result, state: after };
  }

  replay(store: Store): ReplayReport {
    const { manifest } = this.loadPack();
    const existing = store.listProjects().find((p) => p.name === manifest.title);
    if (existing) store.deleteProject(existing.id);
    const { projectId } = this.materialize(store);
    const results: ScenarioResult[] = [];
    for (const scenario of manifest.scenarios) {
      const { result } = this.applyScenario(store, projectId, scenario.id);
      results.push(result);
    }
    return { projectId, results, finalState: store.getState(projectId) };
  }
}
