import { createHash } from 'node:crypto';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { GelStore } from './db.js';
import { generateCase, type GeneratedCase } from './cases/generate.js';
import { DEFAULT_PARAMS } from '../shared/engine.js';
import { compute, type RasterLoader } from '../shared/engine.js';
import { decodePng } from '../shared/png.js';
import { q } from '../shared/geometry.js';
import { randomId, stableId } from '../shared/hash.js';
import type {
  BandCenterMaterial,
  BandResult,
  CalibrationParams,
  ComputeOutput,
  Event,
  EventType,
  ExposureMaterial,
  LaneBoundaryMaterial,
  LadderNominalMaterial,
  Material,
  OrientationMaterial,
  RawImageMaterial,
  ScenarioKind,
} from '../shared/types.js';

export const SCENARIOS: ScenarioKind[] = [
  'rotation',
  'smile-warp',
  'ladder-missing-band',
  'saturation',
  'overlap',
  'nonmonotonic-ruler',
  'revision-local-failure',
];

export interface ProjectView {
  id: string;
  name: string;
  branches: string[];
  events: Event[];
  heads: Record<string, string>;
}

interface ExportBundle {
  format: 'gel-ruler-bundle';
  bundleVersion: 1;
  exportedAt: string;
  project: { id: string; name: string; createdAt: string };
  blobs: { id: string; sha256: string; pngBase64: string }[];
  events: EventRowExport[];
  results: { eventId: string; output: ComputeOutput; materials: Material[] }[];
}

interface EventRowExport {
  id: string;
  seq: number;
  branch: string;
  parentEventId: string | null;
  type: EventType;
  at: string;
  actor: Event['actor'];
  message: string;
  upserts: Material[];
  retires: string[];
  params?: CalibrationParams;
  scenario?: ScenarioKind;
  target?: string;
  payload?: Record<string, unknown>;
}

let clock = 0;
function timestamp(): string {
  clock += 1;
  // 案例包使用确定性时间基准（导入重放仍稳定；仅事件排序）
  return new Date(Date.UTC(2026, 8, 23, 0, 0, clock)).toISOString();
}

export class GelService {
  constructor(private store: GelStore) {}

  private rasterLoader(): RasterLoader {
    return (blobId) => decodePng(this.store.getBlob(blobId)!.bytes);
  }

  // ---------- 案例装载 ----------

  buildBaselineMaterials(generated: GeneratedCase): Material[] {
    const imageId = 'img-baseline';
    const blobId = 'blob-baseline';
    const image: RawImageMaterial = {
      id: imageId,
      type: 'rawImage',
      version: 1,
      blobId,
      width: generated.width,
      height: generated.height,
      channels: 1,
      bitDepth: 8,
      sha256: generated.sha256,
      capturedAt: '2026-09-23T00:00:00Z',
      origin: 'import',
    };
    const orientation: OrientationMaterial = {
      id: 'orient-1',
      type: 'orientation',
      version: 1,
      imageId,
      rotationCw: q(0, 'deg', '拍摄原始方向', '0 deg'),
      flipped: false,
      calibrated: true,
      raw: { rotation: '0 deg' },
    };
    const exposure: ExposureMaterial = {
      id: 'exposure-1',
      type: 'exposure',
      version: 1,
      imageId,
      timeS: q(1.5, 's', '成像曝光时长', '1.5 s'),
      gain: q(1.0, 'ratio', '传感器增益', '1.0x'),
      saturationLevel: 255,
      raw: { time: '1.5 s', gain: '1.0x' },
    };
    const materials: Material[] = [image, orientation, exposure];
    for (const lane of generated.lanes) {
      const boundary: LaneBoundaryMaterial = {
        id: stableId('lane-boundary', [imageId, lane.laneId]),
        type: 'laneBoundary',
        version: 1,
        imageId,
        laneId: lane.laneId,
        label: lane.label,
        role: lane.role,
        left: lane.left,
        right: lane.right,
        kind: lane.kind,
        source: 'manual',
      };
      materials.push(boundary);
    }
    const nominal: LadderNominalMaterial = {
      id: 'ladder-nominal-1',
      type: 'ladderNominal',
      version: 1,
      laneId: 'lane-1',
      bands: generated.ladderNominal.map((n) => ({
        id: n.id,
        mw: q(n.mwBp, 'bp', '厂商 ladder 标称', n.raw),
        raw: n.raw,
      })),
      unit: 'bp',
      source: 'vendor-sheet',
    };
    materials.push(nominal);
    for (const [i, band] of generated.bands.entries()) {
      const bandMaterial: BandCenterMaterial = {
        id: stableId('band', [imageId, band.laneId, band.at.x, band.at.y, i]),
        type: 'bandCenter',
        version: 1,
        imageId,
        laneId: band.laneId,
        at: band.at,
        source: 'auto',
        saturated: band.saturated,
        smeared: band.smeared,
        overlapWith: band.overlap ? 'neighbor' : undefined,
      };
      materials.push(bandMaterial);
    }
    return materials;
  }

  seedSampleProject(): string {
    const existing = this.store.listProjects();
    if (existing.some((p) => p.id === 'sample')) return 'sample';
    const generated = generateCase('baseline');
    this.store.insertBlob({
      id: 'blob-baseline',
      sha256: generated.sha256,
      bytes: generated.png,
    });
    const materials = this.buildBaselineMaterials(generated);

    const projectId = 'sample';
    this.store.upsertProject({
      id: projectId,
      name: '胶道标尺 · dsDNA ladder 离线案例',
      created_at: '2026-09-23T00:00:00Z',
      head_json: JSON.stringify({ main: '' }),
    });

    const importEvent = this.addEvent(projectId, 'main', null, {
      type: 'import',
      actor: 'system',
      message: '导入原始凝胶图像与像素级来源（方向/曝光/ladder 标称/lane 边界/条带中心）',
      upserts: materials,
    });
    this.computeAt(projectId, 'main', importEvent.id);

    // 自动候选
    const firstBand = materials.find((m) => m.type === 'bandCenter' && (m as BandCenterMaterial).laneId === 'lane-2') as BandCenterMaterial;
    const autoEvent = this.addEvent(projectId, 'main', importEvent.id, {
      type: 'decision-accept',
      actor: 'auto',
      message: '自动候选：接受 lane-2 首个条带分子量',
      target: firstBand.id,
      payload: { note: 'auto-candidate' },
    });
    this.computeAt(projectId, 'main', autoEvent.id);

    // 参数修订（cal-v1 → cal-v2）
    const paramsV2: CalibrationParams = { ...DEFAULT_PARAMS, paramVersion: 'cal-v2', model: 'global-linear-log' };
    const paramEvent = this.addEvent(projectId, 'main', autoEvent.id, {
      type: 'parameter-revision',
      actor: 'reviewer',
      message: '参数修订：改用全局 log-linear 校准 cal-v2',
      params: paramsV2,
    });
    this.computeAt(projectId, 'main', paramEvent.id);

    // 互相冲突的人工决定：同一目标两次相反决定
    const rejectEvent = this.addEvent(projectId, 'main', paramEvent.id, {
      type: 'decision-reject',
      actor: 'reviewer',
      message: '人工否定：判该条带为杂质',
      target: firstBand.id,
    });
    this.computeAt(projectId, 'main', rejectEvent.id);
    const acceptAgain = this.addEvent(projectId, 'main', rejectEvent.id, {
      type: 'decision-accept',
      actor: 'reviewer',
      message: '冲突人工决定：重新接受同一目标（前次否定仍保留）',
      target: firstBand.id,
      payload: { conflictsWith: rejectEvent.id },
    });
    this.addEvent(projectId, 'main', acceptAgain.id, {
      type: 'conflict',
      actor: 'system',
      message: '检测到同一目标互相冲突的人工决定，两者均保留待裁决',
      target: firstBand.id,
      payload: { events: [rejectEvent.id, acceptAgain.id] },
    });
    this.computeAt(projectId, 'main', acceptAgain.id);

    // 七个反例分支
    for (const scenario of SCENARIOS) {
      this.buildScenarioBranch(projectId, scenario, paramEvent.id);
    }

    const heads: Record<string, string> = { main: acceptAgain.id };
    const timeline = this.timeline(projectId);
    for (const [branch, head] of Object.entries(timeline.heads)) heads[branch] = head;
    this.store.setProjectHead(projectId, JSON.stringify(heads));
    return projectId;
  }

  // ---------- 事件追加与状态折叠 ----------

  private addEvent(
    projectId: string,
    branch: string,
    parentEventId: string | null,
    spec: {
      type: EventType;
      actor: Event['actor'];
      message: string;
      upserts?: Material[];
      retires?: string[];
      params?: CalibrationParams;
      scenario?: ScenarioKind;
      target?: string;
      payload?: Record<string, unknown>;
    },
  ): Event {
    const seq = this.store.listEvents(projectId).filter((e) => e.branch === branch).length + 1;
    const event: Event = {
      id: randomId('evt'),
      seq,
      projectId,
      branch,
      parentEventId,
      type: spec.type,
      at: timestamp(),
      actor: spec.actor,
      message: spec.message,
      upserts: spec.upserts,
      retires: spec.retires,
      params: spec.params,
      scenario: spec.scenario,
      target: spec.target,
      payload: spec.payload,
    };
    this.store.appendEvent({
      id: event.id,
      project_id: projectId,
      seq,
      branch,
      parent_event_id: parentEventId,
      type: event.type,
      at: event.at,
      actor: event.actor,
      message: event.message,
      payload_json: JSON.stringify(event),
    });
    return event;
  }

  /** 从分支起点按 seq 折叠材料版本；每次返回新数组，不就地修改历史。 */
  materialState(projectId: string, upToEventId: string): { materials: Material[]; event: Event; events: Event[] } {
    const events = this.branchEvents(projectId, upToEventId);
    const current = new Map<string, Material>();
    for (const event of events) {
      for (const material of event.upserts ?? []) current.set(material.id, material);
      for (const retired of event.retires ?? []) current.delete(retired);
    }
    return { materials: [...current.values()], event: events[events.length - 1], events };
  }

  private branchEvents(projectId: string, upToEventId: string): Event[] {
    const all = this.store.listEvents(projectId).map((r) => JSON.parse(r.payload_json) as Event);
    const target = all.find((e) => e.id === upToEventId);
    if (!target) throw new Error(`EVENT_NOT_FOUND ${upToEventId}`);
    const chain: Event[] = [];
    let cursor: Event | undefined = target;
    while (cursor) {
      chain.unshift(cursor);
      cursor = cursor.parentEventId ? all.find((e) => e.id === cursor!.parentEventId) : undefined;
      if (cursor && cursor.branch !== target.branch) break;
    }
    // 分支可能从 main 某事件 fork：把父链上同属主干的导入等基础事件包含进来
    const seen = new Set(chain.map((e) => e.id));
    let bridge: Event | undefined =
      target.parentEventId && !seen.has(target.parentEventId)
        ? all.find((e) => e.id === target.parentEventId)
        : undefined;
    while (bridge && !seen.has(bridge.id)) {
      chain.unshift(bridge);
      seen.add(bridge.id);
      bridge = bridge.parentEventId ? all.find((e) => e.id === bridge!.parentEventId) : undefined;
    }
    return chain;
  }

  private activeParams(events: Event[]): CalibrationParams {
    let params = DEFAULT_PARAMS;
    for (const event of events) if (event.params) params = event.params;
    return params;
  }

  private decisionMap(events: Event[]): Map<string, BandResult['decision']> {
    const decisions = new Map<string, BandResult['decision']>();
    for (const event of events) {
      if (!event.target) continue;
      if (event.type === 'decision-accept') {
        decisions.set(event.target, { by: event.actor, eventId: event.id, at: event.at, note: 'accepted' });
      } else if (event.type === 'decision-reject') {
        decisions.set(event.target, { by: event.actor, eventId: event.id, at: event.at, note: 'rejected' });
      } else if (event.type === 'decision-adjust') {
        decisions.set(event.target, { by: event.actor, eventId: event.id, at: event.at, note: 'adjusted' });
      }
    }
    return decisions;
  }

  /** 计算并持久化某事件的结论；回到任意旧事件读回该版本，不被最新结果覆盖。 */
  computeAt(
    projectId: string,
    branch: string,
    eventId: string,
    changedMaterialId?: string,
  ): ComputeOutput {
    const { materials, event, events } = this.materialState(projectId, eventId);
    const params = this.activeParams(events);
    const decisions = this.decisionMap(events);
    const priorResult =
      event.parentEventId && events.some((e) => e.id === event.parentEventId && e.branch === event.branch)
        ? this.store.getResult(event.parentEventId)
        : undefined;
    const prior = priorResult ? (JSON.parse(priorResult.output_json) as ComputeOutput) : null;
    const output = compute({
      eventId,
      parentEventId: event.parentEventId,
      materials,
      decisions,
      params,
      loadRaster: this.rasterLoader(),
      prior,
      changedMaterialId,
    });
    this.store.putResult(eventId, projectId, JSON.stringify(output), JSON.stringify(materials));
    return output;
  }

  snapshot(projectId: string, eventId: string) {
    const event = JSON.parse(
      this.store.listEvents(projectId).find((r) => r.id === eventId)!.payload_json,
    ) as Event;
    const { materials, events } = this.materialState(projectId, eventId);
    const stored = this.store.getResult(eventId);
    const output = stored ? (JSON.parse(stored.output_json) as ComputeOutput) : null;
    const params = this.activeParams(events);
    return { event, materials, output, params, events };
  }

  timeline(projectId: string): ProjectView {
    const rows = this.store.listEvents(projectId);
    const events = rows.map((r) => JSON.parse(r.payload_json) as Event);
    const branches = Array.from(new Set(events.map((e) => e.branch)));
    const heads: Record<string, string> = {};
    for (const branch of branches) {
      const branchEvents = events.filter((e) => e.branch === branch);
      heads[branch] = branchEvents[branchEvents.length - 1]?.id;
    }
    const project = this.store.getProject(projectId)!;
    return { id: projectId, name: project.name, branches, events, heads };
  }

  imagePng(projectId: string, blobId: string): Buffer {
    const blob = this.store.getBlob(blobId);
    if (!blob) throw new Error(`BLOB_NOT_FOUND ${blobId}`);
    return blob.bytes;
  }

  /** 审阅者从证据路径做出的接受/否定/参数调整都生成新事件。 */
  recordDecision(
    projectId: string,
    branch: string,
    kind: 'accept' | 'reject' | 'adjust',
    target: string,
    note?: string,
    params?: CalibrationParams,
  ): Event {
    const timeline = this.timeline(projectId);
    const head = timeline.heads[branch];
    if (!head) throw new Error(`BRANCH_NOT_FOUND ${branch}`);
    const type = (kind === 'accept'
      ? 'decision-accept'
      : kind === 'reject'
        ? 'decision-reject'
        : 'decision-adjust') as EventType;
    const event = this.addEvent(projectId, branch, head, {
      type,
      actor: 'reviewer',
      message:
        kind === 'accept'
          ? `接受 ${target}`
          : kind === 'reject'
            ? `否定 ${target}`
            : `参数调整影响 ${target}`,
      target,
      params: kind === 'adjust' ? params : undefined,
      payload: { note },
    });
    this.computeAt(projectId, branch, event.id);
    return event;
  }

  // ---------- 七个反例分支：每个只改动一个直接来源 ----------

  private buildScenarioBranch(
    projectId: string,
    scenario: ScenarioKind,
    forkFromEventId: string,
  ): void {
    const generated = generateCase(scenario);
    const blobId = stableId('blob', [scenario]);
    this.store.insertBlob({ id: blobId, sha256: generated.sha256, bytes: generated.png });

    const baselineMaterials = this.buildBaselineMaterials(generated);
    const imageId = (baselineMaterials.find((m) => m.type === 'rawImage') as RawImageMaterial).id;
    // 派生材料换成稳定身份，避免跨分支碰撞
    const remapped = baselineMaterials.map((m) => this.scenarioMaterial(m, scenario, blobId, imageId));

    const branch = scenario;
    const introduce = this.addEvent(projectId, branch, forkFromEventId, {
      type: 'scenario',
      actor: 'system',
      scenario,
      message: this.scenarioMessage(scenario),
      upserts: remapped,
      payload: { onlyOneDirectSource: true, blobId, warpAmp: generated.warpAmp, rotated: generated.rotated },
    });
    this.computeScenarioAt(projectId, branch, introduce.id, scenario);

    // 修订后局部失效：在 cal-v2 之后追加一次让某条带落到有效域外的决定
    if (scenario === 'revision-local-failure') {
      const outBand = remapped.find(
        (m) => m.type === 'bandCenter' && (m as BandCenterMaterial).laneId === 'lane-4',
      ) as BandCenterMaterial;
      const moved: BandCenterMaterial = {
        ...outBand,
        version: 2,
        at: { x: outBand.at.x, y: generated.height - 8 },
        source: 'manual',
      };
      const local = this.addEvent(projectId, branch, introduce.id, {
        type: 'source-change',
        actor: 'reviewer',
        message: '局部源改动：仅移动 lane-4 一个条带中心到 ladder 有效域之外',
        upserts: [moved],
        target: moved.id,
      });
      this.computeScenarioAt(projectId, branch, local.id, scenario, moved.id);
    }
  }

  private scenarioMessage(scenario: ScenarioKind): string {
    const map: Record<ScenarioKind, string> = {
      rotation: '旋转图像：物理旋转 90° 并重校拍摄方向',
      'smile-warp': '弯曲泳道：“微笑”使同高不等于同分子量',
      'ladder-missing-band': 'ladder 缺带：枚举全部合法配准候选',
      saturation: '饱和区：饱和条带只能标为候选',
      overlap: '两条带重叠：保留全部合法候选；拖尾标为区间',
      'nonmonotonic-ruler': '非单调标尺：拒绝校准并给语义无解诊断',
      'revision-local-failure': '修订后局部失效：局部标尺有效域外条带置 invalid',
    };
    return map[scenario];
  }

  private computeScenarioAt(
    projectId: string,
    branch: string,
    eventId: string,
    scenario: ScenarioKind,
    changedMaterialId?: string,
  ): ComputeOutput {
    // scenario 分支的父事件在 main；折叠器会沿 parent 链回溯基础材料
    const { materials, event, events } = this.materialState(projectId, eventId);
    const params = this.activeParams(events);
    const decisions = this.decisionMap(events);
    const prior = event.parentEventId
      ? (() => {
          const row = this.store.getResult(event.parentEventId);
          return row ? (JSON.parse(row.output_json) as ComputeOutput) : null;
        })()
      : null;
    const output = compute({
      eventId,
      parentEventId: event.parentEventId,
      materials,
      decisions,
      params,
      loadRaster: this.rasterLoader(),
      prior,
      changedMaterialId,
    });
    this.store.putResult(eventId, projectId, JSON.stringify(output), JSON.stringify(materials));
    return output;
  }

  private scenarioMaterial(
    material: Material,
    scenario: ScenarioKind,
    blobId: string,
    imageId: string,
  ): Material {
    if (material.id === 'img-baseline') {
      const raw = material as RawImageMaterial;
      return {
        ...raw,
        id: stableId('img', [scenario]),
        blobId,
        origin: scenario === 'rotation' ? 'derived-rotate' : scenario === 'smile-warp' ? 'derived-warp' : 'import',
        derivedFrom: { materialId: 'img-baseline', version: 1, frame: 'frame-img-baseline' },
      };
    }
    const withImage = material as Material & { imageId?: string };
    const clone: Material = {
      ...withImage,
      id: stableId(material.type, [scenario, withImage.id]),
    };
    if ((clone as { imageId?: string }).imageId) {
      (clone as { imageId: string }).imageId = imageId;
    }
    return clone;
  }

  // ---------- 导出 / 导入 / 半写恢复 ----------

  exportProject(projectId: string, outDir: string): string {
    const events = this.store.listEvents(projectId).map((r) => JSON.parse(r.payload_json) as Event);
    const blobIds = new Set<string>();
    for (const event of events) {
      for (const material of event.upserts ?? []) {
        if (material.type === 'rawImage') blobIds.add(material.blobId);
      }
    }
    const blobs = [...blobIds].map((id) => {
      const row = this.store.getBlob(id)!;
      return { id, sha256: row.sha256, pngBase64: Buffer.from(row.bytes).toString('base64') };
    });
    const results = events
      .map((event) => {
        const row = this.store.getResult(event.id);
        if (!row) return null;
        return {
          eventId: event.id,
          output: JSON.parse(row.output_json) as ComputeOutput,
          materials: JSON.parse(row.materials_json) as Material[],
        };
      })
      .filter(Boolean) as ExportBundle['results'];

    const project = this.store.getProject(projectId)!;
    const bundle: ExportBundle = {
      format: 'gel-ruler-bundle',
      bundleVersion: 1,
      exportedAt: new Date().toISOString(),
      project: { id: projectId, name: project.name, createdAt: project.created_at },
      blobs,
      events: events.map((e) => ({
        id: e.id,
        seq: e.seq,
        branch: e.branch,
        parentEventId: e.parentEventId,
        type: e.type,
        at: e.at,
        actor: e.actor,
        message: e.message,
        upserts: e.upserts ?? [],
        retires: e.retires ?? [],
        params: e.params,
        scenario: e.scenario,
        target: e.target,
        payload: e.payload,
      })),
      results,
    };
    const json = JSON.stringify(bundle, null, 2);
    const tmp = join(outDir, `${projectId}.gelruler.tmp`);
    const final = join(outDir, `${projectId}.gelruler.json`);
    writeFileSync(tmp, json, 'utf-8');
    renameSync(tmp, final); // 原子发布：半写只可能留下 .tmp
    return final;
  }

  /** 导入：保留稳定身份/顺序/来源；幂等。返回三类结果之一由调用方区分。 */
  importBundle(path: string, opts: { simulateHalfWrite?: boolean } = {}): {
    projectId: string;
    events: number;
    halfWriteRecovered: boolean;
  } {
    let bundle: ExportBundle;
    try {
      bundle = JSON.parse(readFileSync(path, 'utf-8')) as ExportBundle;
    } catch (error) {
      throw Object.assign(new Error('BUNDLE_FORMAT_CORRUPT'), {
        failureClass: 'FORMAT_CORRUPT',
        cause: String(error),
      });
    }
    if (bundle.format !== 'gel-ruler-bundle' || !Array.isArray(bundle.events)) {
      throw Object.assign(new Error('BUNDLE_FORMAT_UNRECOGNIZED'), {
        failureClass: 'FORMAT_CORRUPT',
      });
    }

    const projectId = bundle.project.id;
    const tmpMarker = `import-staging:${projectId}`;
    this.store.setKey(tmpMarker, JSON.stringify({ at: new Date().toISOString(), events: bundle.events.length }));

    this.store.runInTransaction(() => {
      this.store.upsertProject({
        id: projectId,
        name: bundle.project.name,
        created_at: bundle.project.createdAt,
        head_json: JSON.stringify({}),
      });
      for (const blob of bundle.blobs) {
        this.store.insertBlob({
          id: blob.id,
          sha256: blob.sha256,
          bytes: Buffer.from(blob.pngBase64, 'base64'),
        });
      }
      for (const event of bundle.events) {
        this.store.appendEvent({
          id: event.id,
          project_id: projectId,
          seq: event.seq,
          branch: event.branch,
          parent_event_id: event.parentEventId,
          type: event.type,
          at: event.at,
          actor: event.actor,
          message: event.message,
          payload_json: JSON.stringify(event),
        });
      }
      for (const result of bundle.results) {
        this.store.putResult(
          result.eventId,
          projectId,
          JSON.stringify(result.output),
          JSON.stringify(result.materials),
        );
      }
      if (opts.simulateHalfWrite) {
        throw Object.assign(new Error('SIMULATED_IMPORT_CRASH'), { simulated: true });
      }
    });

    if (opts.simulateHalfWrite) {
      // 事务已回滚：确认无残留
      this.store.setKey(tmpMarker, JSON.stringify({ recovered: 'rollback' }));
      return { projectId, events: 0, halfWriteRecovered: true };
    }

    const branches = Array.from(new Set(bundle.events.map((e) => e.branch)));
    const heads: Record<string, string> = {};
    for (const branch of branches) {
      const list = bundle.events.filter((e) => e.branch === branch);
      heads[branch] = list[list.length - 1].id;
    }
    const project = this.store.getProject(projectId)!;
    this.store.setProjectHead(projectId, JSON.stringify(heads));
    return { projectId, events: bundle.events.length, halfWriteRecovered: false };
  }

  /** 启动时清理上一轮半写导入：staging 标记存在但事件缺失即判定需要回滚清理。 */
  recoverHalfWrittenImports(): { projectId: string; outcome: 'rollback' | 'roll-forward' }[] {
    const rows = this.store.listProjects();
    const outcomes: { projectId: string; outcome: 'rollback' | 'roll-forward' }[] = [];
    for (const project of rows) {
      const events = this.store.listEvents(project.id);
      const hasStaging = this.store.getKey(`import-staging:${project.id}`);
      if (hasStaging && events.length === 0) {
        this.store.deleteProject(project.id);
        outcomes.push({ projectId: project.id, outcome: 'rollback' });
      }
    }
    return outcomes;
  }

  deleteLocalDatabaseProject(projectId: string): void {
    this.store.deleteProject(projectId);
  }

  listProjects() {
    return this.store.listProjects();
  }
}
