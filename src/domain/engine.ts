import { Store } from '../storage/store';
import { PARAM_V1, PARAM_V2, type CalcParams } from './params';
import { canonical, contentId } from './ids';
import { buildMaterialsFromCase, bandMaterial } from './material-factory';
import { detectLaneBands } from './detection';
import { calibrateLadder, type LadderAlignment } from './calibration';
import { inferLane } from './inference';
import { polylineLength, projectionArcLength, rotatePointCW } from './geometry';
import type {
  BandCenterMaterial,
  DecisionEvent,
  DerivedRecord,
  Diagnostic,
  InputSummary,
  LadderNominalMaterial,
  LaneTraceMaterial,
  Material,
} from './types';

export interface EngineContext {
  store: Store;
}

export interface AutoAnalysisResult {
  event: DecisionEvent;
  derived: DerivedRecord[];
  diagnostics: Diagnostic[];
}

/**
 * 领域引擎：所有业务规则在服务端/存储层执行，测试可直接调用。
 * 事件 append-only；派生结果记录输入摘要、参数版本、父依赖。
 */
export class GelEngine {
  constructor(readonly store: Store) {}

  createProject(name: string, kind: string, spec: Record<string, unknown> = {}) {
    return this.store.createProject(name, kind, spec);
  }

  /** 导入一个案例材料集（原图/方向/曝光/ladder/lane 真值曲线），保留像素级来源 */
  importCaseMaterials(projectId: string, pngBuffer: Buffer, buildArgs: Parameters<typeof buildMaterialsFromCase>[0]): {
    event: DecisionEvent;
    materials: Material[];
  } {
    const blobSha = this.store.putBlob(pngBuffer, 'png');
    const mats = buildMaterialsFromCase({ ...buildArgs, projectId, blobSha256: blobSha });
    const all: Material[] = [mats.image, mats.orientation, mats.exposure, mats.ladder, ...mats.lanes];
    const payload = {
      image: mats.image.id,
      orientation: mats.orientation.id,
      exposure: mats.exposure.id,
      ladder: mats.ladder.id,
      lanes: mats.lanes.map((l) => l.id),
      pixelSources: {
        image: mats.image.provenance,
        orientation: mats.orientation.provenance,
        exposure: mats.exposure.provenance,
        lanes: mats.lanes.map((l) => ({ lane: l.id, provenance: l.provenance })),
      },
    };
    const event = this.store.appendEvent(
      projectId,
      this.store.getHead(projectId, 'main').headEventId,
      'main',
      'material_imported',
      payload,
      'system',
      { immutableLayer: true, blobSha256: blobSha }
    );
    for (const m of all) this.store.putMaterial(m, 'main', event.id, m.id, m.createdAtLogical);
    return { event, materials: all };
  }

  private currentMaterials(projectId: string): Material[] {
    const head = this.store.getHead(projectId, 'main').headEventId;
    return head ? this.store.materialsAtEvent(projectId, head) : this.store.listMaterialsCurrent(projectId);
  }

  private paramVersionOf(projectId: string): string {
    const evs = this.store.listEvents(projectId, 'main');
    const rev = [...evs].reverse().find((e) => e.type === 'parameter_revision');
    return (rev?.payload.paramVersion as string) ?? PARAM_V1.version;
  }

  /**
   * 自动分析：检测 ladder + 样本条带、校准、推断分子量。
   * 返回检测/校准/推断三类派生记录与全部诊断。
   */
  runAutoAnalysis(projectId: string, opts: { acceptedAlignment?: number; branch?: string } = {}): AutoAnalysisResult {
    const branch = opts.branch ?? 'main';
    const params = this.resolveParams(this.paramVersionOf(projectId));
    const head = this.store.getHead(projectId, branch).headEventId;
    const mats = head ? this.store.materialsAtEvent(projectId, head) : [];
    const image = mats.find((m) => m.type === 'image') as Extract<Material, { type: 'image' }> | undefined;
    const exposure = mats.find((m) => m.type === 'exposure') as Extract<Material, { type: 'exposure' }> | undefined;
    const ladder = mats.find((m) => m.type === 'ladder_nominal') as LadderNominalMaterial | undefined;
    const lanes = mats.filter((m) => m.type === 'lane_trace') as LaneTraceMaterial[];
    const priorBands = mats.filter((m) => m.type === 'band_center') as BandCenterMaterial[];
    const diagnostics: Diagnostic[] = [];
    if (!image || !exposure || !ladder) {
      return {
        event: this.store.appendEvent(projectId, head, branch, 'auto_analysis', { failed: true }, 'auto', {
          diagnostics: [{ code: 'INCOMPLETE_INPUT' }],
        }),
        derived: [],
        diagnostics: [
          {
            code: 'INCOMPLETE_INPUT',
            severity: 'error',
            message: '自动分析缺少图像/曝光/ladder 材料',
            location: { materialId: image?.id ?? ladder?.id },
          },
        ],
      };
    }
    const blob = this.store.getBlob(image.blobSha256);
    const derived: DerivedRecord[] = [];
    const newBands: BandCenterMaterial[] = [];
    const detectionByLane = new Map<string, { bandIds: string[]; recordId: string }>();

    for (const lane of lanes) {
      const existing = priorBands.filter((b) => b.laneId === lane.id && b.frameId === lane.frameId);
      let bands: BandCenterMaterial[] = [];
      if (existing.length > 0) {
        bands = existing;
      } else if (blob) {
        const out = detectLaneBands(image, blob.bytes, exposure, lane, params, this.inputSummary(mats, params, []), image.createdAtLogical);
        if ('diagnostics' in out) {
          diagnostics.push(...out.diagnostics);
          continue;
        }
        bands = out.bands;
        for (const b of bands) this.store.putMaterial(b, branch, null, b.id, b.createdAtLogical);
        newBands.push(...bands);
        diagnostics.push(...out.record.diagnostics);
        const det: DerivedRecord = {
          id: out.record.id,
          projectId,
          kind: 'detection',
          branch,
          atEventId: '__pending__',
          subjectId: lane.id,
          state: out.record.state,
          inputSummary: this.inputSummary(mats, params, []),
          paramVersion: params.version,
          parentDerivedIds: [],
          value: out.record.value,
          diagnostics: out.record.diagnostics,
          logicalClock: this.store.nextLogicalClock(),
        };
        derived.push(det);
        detectionByLane.set(lane.id, { bandIds: bands.map((b) => b.id), recordId: det.id });
      }
      if (existing.length > 0) {
        detectionByLane.set(lane.id, {
          bandIds: bands.map((b) => b.id),
          recordId: contentId('der_detection_existing', { lane: lane.id, bands: bands.map((b) => b.id) }),
        });
      }
    }

    // 校准 ladder
    const ladderLane = lanes.find((l) => l.role === 'ladder');
    let chosenAlignment: LadderAlignment | undefined;
    let calibrationRecord: DerivedRecord | undefined;
    if (ladderLane) {
      const obs = (head ? this.store.materialsAtEvent(projectId, head) : []).filter(
        (m): m is BandCenterMaterial => m.type === 'band_center' && m.laneId === ladderLane.id
      );
      const active = obs.filter((b) => b.status !== 'rejected' && b.status !== 'superseded');
      const cal = calibrateLadder(ladder, ladderLane, active, params, this.inputSummary(mats, params, []));
      calibrationRecord = {
        id: cal.id,
        projectId,
        kind: 'calibration',
        branch,
        atEventId: '__pending__',
        subjectId: ladderLane.id,
        state: cal.state,
        inputSummary: this.inputSummary(mats, params, []),
        paramVersion: params.version,
        parentDerivedIds: [],
        value: {
          alignments: cal.alignments.map((a, i) => ({
            index: i,
            mapping: a.mapping,
            residualRatio: a.residualRatio,
            segments: a.segments,
            spanNorm: a.spanNorm,
            totalLengthPx: a.totalLengthPx,
          })),
          acceptedAlignmentIndex: opts.acceptedAlignment ?? (cal.alignments.length > 1 ? undefined : 0),
          smile: this.smileDiagnostics(lanes),
        },
        diagnostics: cal.diagnostics,
        logicalClock: this.store.nextLogicalClock(),
      };
      derived.push(calibrationRecord);
      diagnostics.push(...cal.diagnostics);
      const idx = opts.acceptedAlignment ?? (cal.alignments.length === 1 ? 0 : undefined);
      if (idx !== undefined) chosenAlignment = cal.alignments[idx];
    }

    // 推断样本
    if (ladderLane && chosenAlignment && calibrationRecord) {
      for (const lane of lanes.filter((l) => l.role === 'sample')) {
        const bandsNow = (head ? this.store.materialsAtEvent(projectId, head) : []).filter(
          (m): m is BandCenterMaterial => m.type === 'band_center' && m.laneId === lane.id
        );
        const inf = inferLane(lane, bandsNow, chosenAlignment, calibrationRecord.id, params, this.inputSummary(mats, params, [calibrationRecord.id]));
        derived.push({
          id: inf.id,
          projectId,
          kind: 'inference',
          branch,
          atEventId: '__pending__',
          subjectId: lane.id,
          state: inf.state,
          inputSummary: this.inputSummary(mats, params, [calibrationRecord.id]),
          paramVersion: params.version,
          parentDerivedIds: inf.parentDerivedIds,
          value: inf.value,
          diagnostics: inf.diagnostics,
          logicalClock: this.store.nextLogicalClock(),
        });
        diagnostics.push(...inf.diagnostics);
      }
    }

    const event = this.store.appendEvent(
      projectId,
      head,
      branch,
      'auto_analysis',
      {
        detections: [...detectionByLane.entries()].map(([lane, v]) => ({ lane, ...v })),
        calibration: calibrationRecord?.id ?? null,
        acceptedAlignment: opts.acceptedAlignment ?? null,
        newBands: newBands.map((b) => b.id),
      },
      'auto',
      { diagnostics: diagnostics.map((d) => d.code) }
    );
    for (const d of derived) {
      d.atEventId = event.id;
      this.store.putDerived(d);
    }
    this.store.attachCreatedEvent(projectId, newBands.map((b) => b.id), event.id);
    return { event, derived, diagnostics };
  }

  private smileDiagnostics(lanes: LaneTraceMaterial[]): Diagnostic[] {
    const out: Diagnostic[] = [];
    for (const lane of lanes) {
      const xs = lane.centerline.map((p) => p.x);
      const spread = Math.max(...xs) - Math.min(...xs);
      if (spread > 6) {
        out.push({
          code: 'SMILE_LOCAL_SCALE',
          severity: 'warning',
          message: `lane ${lane.laneIndex} 中心线弯曲 ${spread.toFixed(1)}px：同一高度不等于同一分子量，标尺限定在该 lane 弧长有效区域内`,
          location: { laneId: lane.id },
        });
      }
    }
    return out;
  }

  private resolveParams(version: string): CalcParams {
    return version === PARAM_V2.version ? PARAM_V2 : PARAM_V1;
  }

  private inputSummary(mats: Material[], params: CalcParams, parents: string[]): InputSummary {
    const hashes: Record<string, string> = {};
    for (const m of mats) hashes[m.id] = contentId('h', { id: m.id, type: m.type, raw: m.raw }).replace('h_', '');
    return {
      materialIds: mats.map((m) => m.id).sort(),
      eventIds: [],
      paramVersion: params.version,
      parentDerivedIds: parents,
      materialHashes: hashes,
    };
  }
/** 参数修订：生成新版本事件，依赖参数的派生结果重算但历史保留 */

  reviseParameters(projectId: string, version: string, note: string): DecisionEvent {
    const head = this.store.getHead(projectId, 'main').headEventId;
    const ev = this.store.appendEvent(
      projectId,
      head,
      'main',
      'parameter_revision',
      { previous: this.paramVersionOf(projectId), paramVersion: version, note },
      'human',
      { rule: 'derived-not-overwritten', recomputeScope: 'params-dependent' }
    );
    return ev;
  }

  /** 接受一个候选 band（自动 -> 采纳）。在指定对齐上接受则携带对齐选择。 */
  acceptCandidate(projectId: string, bandId: string, alignmentIndex?: number): DecisionEvent {
    const head = this.store.getHead(projectId, 'main').headEventId;
    const mats = this.currentMaterials(projectId);
    const band = mats.find((m) => m.id === bandId || (m.type === 'band_center' && m.id === bandId)) as
      | BandCenterMaterial
      | undefined;
    const uncertain = band ? band.saturated || band.tailing || !!band.overlapWith : false;
    return this.store.appendEvent(
      projectId,
      head,
      'main',
      'accept_candidate',
      {
        bandId,
        acceptedAs: uncertain ? 'candidate-or-interval' : 'point-estimate',
        alignmentIndex: alignmentIndex ?? null,
      },
      'human',
      { evidence: ['profile', 'lane-curve', 'calibration-segment'] }
    );
  }

  rejectCandidate(projectId: string, bandId: string, reason: string): DecisionEvent {
    const head = this.store.getHead(projectId, 'main').headEventId;
    return this.store.appendEvent(
      projectId,
      head,
      'main',
      'reject_candidate',
      { bandId, reason },
      'human',
      { machineReadable: { reject: true, reason } }
    );
  }

  /** 人工修订条带中心（像素坐标 + 坐标基准），生成新的 manual band 版本材料 */
  manualEditBand(
    projectId: string,
    logicalBandId: string,
    newCenter: { x: number; y: number },
    frameId: string
  ): { event: DecisionEvent; band: BandCenterMaterial } {
    const head = this.store.getHead(projectId, 'main').headEventId;
    const mats = this.currentMaterials(projectId);
    const old = mats.find((m) => m.type === 'band_center' && m.id === logicalBandId) as BandCenterMaterial;
    const lane = mats.find((m) => m.type === 'lane_trace' && m.id === old.laneId) as LaneTraceMaterial;
    const exposure = mats.find((m) => m.type === 'exposure') as Extract<Material, { type: 'exposure' }>;
    const image = mats.find((m) => m.type === 'image') as Extract<Material, { type: 'image' }>;
    const s = projectionArcLength(lane.centerline, newCenter).s;
    const band = bandMaterial(
      projectId,
      frameId,
      lane.id,
      newCenter,
      [{ s, intensity: 0 }],
      old.widthPx,
      { saturated: false, tailing: false },
      'manual',
      'human',
      image.id,
      exposure.id
    );
    const event = this.store.appendEvent(
      projectId,
      head,
      'main',
      'manual_edit',
      { logicalBandId, oldBandId: old.id, newBandId: band.id, from: old.center, to: newCenter, basis: 'pixel,top-left' },
      'human',
      { preserveProvenance: true }
    );
    this.store.putMaterial(band, 'main', event.id, logicalBandId, band.createdAtLogical);
    this.store.supersedeMaterial(projectId, old.id, band.id, event.id);
    return { event, band };
  }

  /**
   * 互相冲突的人工决定：同一 band 已接受 A，再否定/改为 B。
   * 不覆盖历史：记录 conflicting_decision，并在新分支上保存第二个决定。
   */
  conflictingDecision(projectId: string, bandId: string, secondAction: 'reject' | 'accept-interval', branchName = 'human-alt'): {
    mainEvent: DecisionEvent;
    branchEvent: DecisionEvent;
  } {
    const headMain = this.store.getHead(projectId, 'main').headEventId;
    const mainEvent = this.store.appendEvent(
      projectId,
      headMain,
      'main',
      'conflicting_decision',
      { bandId, first: 'accepted-point', second: secondAction, resolution: 'forked-not-overwritten' },
      'human',
      { code: 'CONFLICTING_DECISIONS' }
    );
    // 新分支从主头分叉，保留两个互相冲突的决定
    if (!this.store.listBranches(projectId).includes(branchName)) {
      this.store.setHead(projectId, branchName, mainEvent.id, mainEvent.seq);
    }
    const headAlt = this.store.getHead(projectId, branchName).headEventId;
    const payload =
      secondAction === 'reject'
        ? { bandId, decision: 'rejected', conflictsWithEvent: mainEvent.id }
        : { bandId, decision: 'accepted-interval', conflictsWithEvent: mainEvent.id };
    const branchEvent = this.store.appendEvent(projectId, headAlt, branchName, 'reject_candidate', payload, 'human', {
      forkedFrom: mainEvent.id,
      code: 'CONFLICTING_DECISIONS',
    });
    return { mainEvent, branchEvent };
  }

  /**
   * 只改动一个直接来源（lane 曲线 / ladder 标称 / 图像帧）。
   * 仅使依赖该来源的派生结果本地失效，其它 lane 与 ladder 结果不受影响。
   */
  replaceSingleSource(args: {
    projectId: string;
    kind: 'lane_trace' | 'ladder_nominal' | 'image';
    logicalId: string;
    newMaterial: Material;
    reason: string;
    affectedSubjects: string[];
  }): DecisionEvent {
    const { projectId, kind, logicalId, newMaterial, reason, affectedSubjects } = args;
    const head = this.store.getHead(projectId, 'main').headEventId;
    const event = this.store.appendEvent(
      projectId,
      head,
      'main',
      'source_replaced',
      {
        kind,
        logicalId,
        oldMaterialId: this.currentMaterials(projectId).find((m) => m.id === logicalId)?.id ?? logicalId,
        newMaterialId: newMaterial.id,
        affectedScope: affectedSubjects,
        singleSource: true,
      },
      'human',
      { blastRadius: 'local-dependents-only', reason }
    );
    this.store.putMaterial(newMaterial, 'main', event.id, logicalId, newMaterial.createdAtLogical);
    this.store.supersedeMaterial(projectId, logicalId, newMaterial.id, event.id);
    if (kind === 'lane_trace') this.store.supersedeBandsOfLane(projectId, logicalId, event.id);

    // 标记受影响的派生结果本地失效（只标 subject 在 affectedScope 内的）
    const oldDerived = this.store.listDerivedAt(projectId, head!);
    for (const d of oldDerived) {
      const depends =
        affectedSubjects.includes(d.subjectId) ||
        (d.kind === 'calibration' && affectedSubjects.some((s) => d.value?.alignments));
      if (!depends) continue;
      const code = d.kind === 'calibration' ? 'NON_MONOTONIC_SCALE' : 'LOCAL_DEPENDENCY_INVALID';
      this.store.markDerivedInvalid(projectId, d.id, {
        sourceMaterialId: logicalId,
        reason: kind === 'ladder_nominal' ? 'NON_MONOTONIC_SCALE' : 'LOCAL_DEPENDENCY_INVALID',
      });
      void code;
    }
    return event;
  }

  /** 偏移一条 lane 曲线（局部失效场景的便捷构造） */
  shiftLaneTrace(projectId: string, logicalLaneId: string, shift: { x?: number; y?: number }): LaneTraceMaterial {
    const mats = this.currentMaterials(projectId);
    const lane = mats.find((m) => m.type === 'lane_trace' && m.id === logicalLaneId) as LaneTraceMaterial;
    const moved: LaneTraceMaterial = {
      ...lane,
      centerline: lane.centerline.map((p) => ({ x: round1(p.x + (shift.x ?? 0)), y: round1(p.y + (shift.y ?? 0)) })),
      boundaryLeft: lane.boundaryLeft.map((p) => ({ x: round1(p.x + (shift.x ?? 0)), y: round1(p.y + (shift.y ?? 0)) })),
      boundaryRight: lane.boundaryRight.map((p) => ({ x: round1(p.x + (shift.x ?? 0)), y: round1(p.y + (shift.y ?? 0)) })),
      origin: { x: round1(lane.origin.x + (shift.x ?? 0)), y: round1(lane.origin.y + (shift.y ?? 0)) },
      raw: { ...lane.raw, shiftedBy: shift, revised: true },
      provenance: { ...lane.provenance, revision: 'human:post-acceptance-shift' },
      id: contentId('mat_lane_rev', { old: lane.id, shift }),
      createdAtLogical: lane.createdAtLogical + 1,
    };
    return moved;
  }

  /** 回到任意旧事件的只读视图（checkout 不产生覆盖，记录为视图事件） */
  checkoutView(projectId: string, eventIdVal: string): DecisionEvent {
    const head = this.store.getHead(projectId, 'main').headEventId;
    return this.store.appendEvent(
      projectId,
      head,
      'main',
      'checkout_view',
      { viewingEventId: eventIdVal },
      'human',
      { readOnly: true, restoresDependencyVersions: true }
    );
  }

  /** 在某分支上运行自动分析（冲突决定的第二分支重算） */
  runAutoAnalysisOnBranch(projectId: string, branch: string, acceptedAlignment?: number): AutoAnalysisResult {
    const heads = this.store.listBranches(projectId);
    if (!heads.includes(branch)) throw new Error(`UNKNOWN_BRANCH:${branch}`);
    return this.runAutoAnalysis(projectId, { branch, acceptedAlignment });
  }
}

function round1(v: number) {
  return Math.round(v * 10) / 10;

}
