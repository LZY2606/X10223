/**
 * 把场景材料装配成完整项目：
 * 不可变材料（原图/方向/曝光/ladder 标称） + 可修改决定（lane/band 修订） + 事件链。
 * 身份全局稳定；几何坐标全部带 frame（= 当前图像身份），保留像素级来源。
 */
import type {
  BandCenterRevision,
  EventRecord,
  LaneGeometryRevision,
  Material,
  ParentRef,
  RawImageMaterial
} from '../types.js';
import { encodePng, rotate90 } from '../raster.js';
import { sha256Bytes } from '../hash.js';
import { laneCenterline } from './gelgen.js';
import { buildScenario, GEL_H, GEL_W, LANE_BOTTOM, LANE_TOP, SAMPLE_LANES, type ScenarioKind } from './scenarios.js';
import { quantity } from '../units.js';

export interface ProjectBlueprint {
  projectId: string;
  name: string;
  mainBranchId: string;
  events: EventRecord[];
  materials: Material[];
  lanes: LaneGeometryRevision[];
  bands: BandCenterRevision[];
  /** blobId -> png bytes */
  blobs: Map<string, Uint8Array>;
  currentImageIdentity: string;
  ladderLaneIdentity: string;
  laneLabels: { identity: string; label: string; isLadder: boolean }[];
}

let seqCounter = 0;

function event(
  projectId: string,
  branchId: string,
  parentEventId: string | null,
  type: EventRecord['type'],
  actor: EventRecord['actor'],
  payload: unknown,
  parents: ParentRef[] = [],
  resultId: string | null = null
): { ev: EventRecord; seq: number } {
  seqCounter += 1;
  const seq = seqCounter;
  return {
    seq,
    ev: {
      id: `ev-${String(seq).padStart(6, '0')}`,
      seq,
      projectId,
      branchId,
      parentEventId,
      type,
      actor,
      payload,
      inputSummary: {},
      paramVersion: 'gel-rules-1.0.0',
      parents,
      resultId
    }
  };
}

export function buildBlueprint(
  projectId: string,
  kind: ScenarioKind,
  startSeq = 0
): ProjectBlueprint {
  seqCounter = startSeq;
  const branchId = 'br-main';
  const built = buildScenario(kind);
  const { spec, gel, ladderNominals } = built;

  // ---- 图像字节（先画基线朝向，再按场景旋转；帧身份随角度变化） ----
  const baseBytes = encodePng(gel.raster);
  const baseSha = sha256Bytes(baseBytes);
  let frameRaster = gel.raster;
  let angle = 0;
  if (spec.rotateQuarters > 0) {
    frameRaster = rotate90(gel.raster, spec.rotateQuarters);
    angle = spec.rotateQuarters * 90;
  }
  const frameBytes = encodePng(frameRaster);
  const frameSha = sha256Bytes(frameBytes);

  const rotated = spec.rotateQuarters > 0;
  const rawIdentity = 'img-gel-original';
  const frameIdentity = rotated ? 'img-gel-rotated' : rawIdentity;

  const rawMaterial: RawImageMaterial = {
    identity: rawIdentity,
    kind: 'rawImage',
    revision: 1,
    blobId: `blob-${baseSha.slice(0, 12)}`,
    sha256: baseSha,
    mediaType: 'image/png',
    width: GEL_W,
    height: GEL_H,
    bitDepth: 8,
    channels: 1,
    provenance: {
      capturedAt: '2026-09-19T03:12:00+09:00',
      device: 'GelDoc-Mini (synthetic case pack)',
      originalFilename: `gel-${kind}-16bit-downsample.png`,
      note: '合成案例材料：灰度真值与像素坐标由生成器确定性产出'
    }
  };
  const materials: Material[] = [rawMaterial];
  const blobs = new Map<string, Uint8Array>([[rawMaterial.blobId, baseBytes]]);
  if (rotated) {
    materials.push({
      identity: frameIdentity,
      kind: 'derivedImage',
      revision: 1,
      blobId: `blob-${frameSha.slice(0, 12)}`,
      sha256: frameSha,
      mediaType: 'image/png',
      width: frameRaster.width,
      height: frameRaster.height,
      bitDepth: 8,
      channels: 1,
      provenance: {
        capturedAt: rawMaterial.provenance.capturedAt,
        device: rawMaterial.provenance.device,
        originalFilename: rawMaterial.provenance.originalFilename,
        note: `顺时针旋转 ${angle}° 后的派生帧`
      },
      transform: { type: 'rotate', angleDeg: angle, parentBlobSha: baseSha }
    });
    blobs.set(`blob-${frameSha.slice(0, 12)}`, frameBytes);
  }

  // ---- 拍摄方向（保留原始表示） ----
  materials.push({
    identity: 'mat-orientation',
    kind: 'orientation',
    revision: 1,
    angleDeg: quantity('angle', angle, 'deg'),
    flipH: false,
    flipV: false,
    rawRepresentation: `orientation=${angle}deg;flip=none`,
    source: 'casepack/scenarios.ts'
  });

  // ---- 曝光 ----
  materials.push({
    identity: 'mat-exposure',
    kind: 'exposure',
    revision: 1,
    time: quantity('exposureTime', '1200', 'ms'),
    gain: quantity('intensity', '1.0', 'fiu'),
    saturationLevel: 254,
    rawRepresentation: 'exposure=1200ms;gain=1.0;saturation>=254',
    source: 'casepack/scenarios.ts'
  });

  // ---- ladder 标称（保留原始表示，例如 "500 bp"） ----
  const ladderLaneIdentity = 'lane-ladder';
  materials.push({
    identity: 'mat-ladder-spec',
    kind: 'ladderSpec',
    revision: 1,
    laneIdentity: ladderLaneIdentity,
    supplier: 'CasePack dsDNA 10-band',
    lot: 'CP-1194',
    rawRepresentation:
      '1500,1000,750,500,400,300,200,150,100,50 bp (#5 missing in ladder-missing)' +
      (kind === 'nonmonotonic' ? ';swap#4#5' : ''),
    bands: ladderNominals.map((n) => ({
      identity: `ld-b${n.ordinal}`,
      mw: quantity('molecularWeight', n.mw === null ? '' : String(n.mw), 'bp'),
      ordinal: n.ordinal,
      observed: n.observed,
      rawRepresentation: n.mw === null ? `#${n.ordinal}: MISSING` : `${n.mw} bp`
    }))
  });

  // ---- lane 边界（像素折线，随弯曲变化；旋转后按新帧坐标重算） ----
  const laneLabels: ProjectBlueprint['laneLabels'] = [];
  const lanes: LaneGeometryRevision[] = [];
  const bands: BandCenterRevision[] = [];

  const laneDefs = [
    { id: ladderLaneIdentity, label: 'Ladder', xCenter: 64, isLadder: true, smile: spec.ladderSmile },
    ...SAMPLE_LANES.map((s) => ({ id: s.id, label: s.label, xCenter: s.xCenter, isLadder: false, smile: spec.sampleSmile }))
  ];

  for (const ld of laneDefs) {
    const clSyn = laneCenterline(
      { id: ld.id, label: ld.label, xCenter: ld.xCenter, halfWidth: 16, smile: ld.smile, bands: [] },
      LANE_TOP,
      LANE_BOTTOM,
      40
    );
    const tf = (p: { x: number; y: number }) =>
      rotated ? rotatePointPx(p.x, p.y, GEL_W, GEL_H, spec.rotateQuarters) : [p.x, p.y] as [number, number];
    const left = clSyn.map((p) => {
      const [x, y] = tf({ x: p.x - 16, y: p.y });
      return { x, y, frame: frameIdentity };
    });
    const right = clSyn.map((p) => {
      const [x, y] = tf({ x: p.x + 16, y: p.y });
      return { x, y, frame: frameIdentity };
    });
    lanes.push({
      identity: ld.id,
      revision: 1,
      label: ld.label,
      frame: frameIdentity,
      isLadderLane: ld.isLadder,
      left,
      right,
      source: 'auto',
      confidence: 0.97
    });
    laneLabels.push({ identity: ld.id, label: ld.label, isLadder: ld.isLadder });
  }

  // ---- 条带中心（像素级来源；ladder band 与标称 ordinal 对应） ----
  const truth = gel.bandTruth;
  for (const ld of laneDefs) {
    const pts = truth[ld.id] ?? [];
    pts.forEach((t, idx) => {
      let x = t.x;
      let y = t.y;
      // 修订后局部失效：只移动 lane-s2 第 3 条带（且仅该分支）
      if (spec.movedBand && ld.id === 'lane-s2' && idx + 1 === spec.movedBand.ordinal) {
        y += spec.movedBand.dY;
      }
      const [rx, ry] = rotated ? rotatePointPx(x, y, GEL_W, GEL_H, spec.rotateQuarters) : [x, y];
      bands.push({
        identity: `${ld.id}-b${idx + 1}`,
        revision: 1,
        laneIdentity: ld.id,
        center: { x: Number(rx.toFixed(2)), y: Number(ry.toFixed(2)), frame: frameIdentity },
        window: {
          x0: Math.max(0, Math.round(rx) - 16),
          y0: Math.max(0, Math.round(ry) - 6),
          x1: Math.min(rotated ? GEL_H : GEL_W, Math.round(rx) + 16),
          y1: Math.min(rotated ? GEL_W : GEL_H, Math.round(ry) + 6),
          frame: frameIdentity
        },
        source: 'auto',
        confidence: 0.95
      });
    });
  }

  // ---- 事件链 ----
  const events: EventRecord[] = [];
  const push = (e: EventRecord) => {
    events.push(e);
    return e;
  };
  const created = push(
    event(projectId, branchId, null, 'project.created', 'system', {
      name: `胶道标尺工作台 · ${spec.title}`,
      mainBranchId: branchId
    }).ev
  );
  let parent: EventRecord = created;
  const reg = (type: EventRecord['type'], actor: EventRecord['actor'], payload: unknown) => {
    const { ev } = event(projectId, branchId, parent.id, type, actor, payload);
    push(ev);
    parent = ev;
  };
  for (const m of materials) {
    reg('material.registered', 'system', { material: m });
  }
  reg('auto.detected', 'auto', { lanes });
  reg('auto.detected', 'auto', { bands });

  return {
    projectId,
    name: `胶道标尺工作台 · ${spec.title}`,
    mainBranchId: branchId,
    events,
    materials,
    lanes,
    bands,
    blobs,
    currentImageIdentity: frameIdentity,
    ladderLaneIdentity,
    laneLabels
  };
}

function rotatePointPx(x: number, y: number, w: number, h: number, q: number): [number, number] {
  const qq = ((q % 4) + 4) % 4;
  if (qq === 1) return [h - 1 - y, x];
  if (qq === 2) return [w - 1 - x, h - 1 - y];
  if (qq === 3) return [y, w - 1 - x];
  return [x, y];
}
