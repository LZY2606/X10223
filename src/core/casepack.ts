import type {
  BandMaterial,
  DomainEvent,
  ImageMaterial,
  LadderBandNominal,
  LaneMaterial,
  LadderSpec,
  MassResult,
  CalibrationResult,
  Decision
} from './types';
import { PARAMS_BY_VERSION, PARAMS_V1, PARAMS_V2 } from './params';
import {
  arcPoint,
  bandId,
  computeCalibrationEvent,
  computeMassEvent,
  eventId,
  laneId,
  ladderSpecId,
  makeDecisionEvent,
  makeMaterialEvent,
  newProject,
  runAutoDetection,
  straightCenterline,
  type AutoLaneSpec
} from './engine';
import { detectBands } from './detector';
import { buildBranchDefs, GEL_DIMENSIONS, LANE_CENTERS, LADDER_BASE_NOMINAL, LADDER_LANE_INDEX, type BranchDef } from './casepack-variants';
import { generateGel, LANE_HALF_WIDTH, migrationY, rotate90CW, warpPoint } from './gelgen';
import type { GrayImage } from './png';
import { encodePng } from './png';
import { digestOf, sha256Hex, stableId } from '../shared/hash';
import { cumulativeLength, pointAtLength } from '../shared/geometry';
import { diag } from '../shared/diagnostics';
import { alignLadder, inferMass, buildCalibration } from './calibration';

export interface ProjectBundle {
  format: 'gel-ruler/project-bundle';
  bundleVersion: 1;
  projectId: string;
  events: DomainEvent[];
  blobs: { id: string; mediaType: string; bytesBase64: string }[];
  casepack: boolean;
  exportedAt: string;
}

export const PROJECT_ID = 'case-gel-ruler-001';
export const PROJECT_NAME = '胶道标尺：电泳条带、泳道弯曲与分子量校准工作台';

const LADDER_REF = 'catalog/DL-10k/ladder-nominal-v1';
const SEED_STAMP = 0;

function stamp(n: number) {
  return new Date(Date.UTC(2026, 8, 23, 2, n, 0)).toISOString();
}

function exposure(variantName: string) {
  return {
    timeMs: { value: variantName === 'saturated' ? 4200 : 1500, unit: 'millisecond' as const, raw: variantName === 'saturated' ? '4.2s' : '1500ms' },
    gain: { value: variantName === 'saturated' ? 2.2 : 1.0, unit: 'fraction' as const, raw: variantName === 'saturated' ? '2.2x' : '1.0x' },
    saturatedPixelValue: { value: PARAMS_V1.saturationThreshold, unit: 'gray8' as const, raw: String(PARAMS_V1.saturationThreshold) },
    raw: { instrument: 'ChemiDoc-mock', binning: '1x1' }
  };
}

function imageMaterial(id: string, blobRef: string, img: GrayImage, role: ImageMaterial['role'], frameId: string, orientation: number, rotationApplied: number, variantName: string): ImageMaterial {
  return {
    id,
    kind: 'image',
    role,
    blobRef,
    width: img.width,
    height: img.height,
    frameId,
    orientation,
    rotationAppliedDeg: rotationApplied,
    exposure: exposure(variantName),
    acquiredAt: stamp(1),
    source: { origin: 'import', reference: `cases/gel-ruler/${variantName}/original.png`, capturedAt: stamp(1), rawRepresentation: 'image/png; grayscale-8' }
  };
}

function smileCenterline(x: number, img: GrayImage) {
  const pts = [];
  for (let y = 60; y <= img.height - 30; y += 8) {
    const w = warpPoint({ x, y });
    pts.push({ x: Math.round(w.x * 10) / 10, y: Math.round(w.y * 10) / 10 });
  }
  return pts;
}

function laneSpecsFor(def: BranchDef, imageId: string, img: GrayImage): AutoLaneSpec[] {
  return LANE_CENTERS.map((x, order) => ({
    order,
    role: order === LADDER_LANE_INDEX ? ('ladder' as const) : ('sample' as const),
    centerline: def.variant.smile ? smileCenterline(x, img) : straightCenterline({ id: imageId, frameId: '', orientation: 1, rotationAppliedDeg: 0, width: img.width, height: img.height } as ImageMaterial, x),
    halfWidthPx: LANE_HALF_WIDTH
  }));
}

function nominalFor(def: BranchDef): LadderBandNominal[] {
  const base = LADDER_BASE_NOMINAL.map((massBp, i) => ({ ordinal: i, massBp, source: LADDER_REF }));
  if (def.nonmonotonic) {
    const t = base[3].massBp;
    base[3] = { ...base[3], massBp: base[4].massBp };
    base[4] = { ...base[4], massBp: t };
  }
  return base;
}

function clusterMap(bands: BandMaterial[]) {
  const byLane = new Map<string, BandMaterial[]>();
  for (const b of bands) {
    if (b.flag === 'overlap') {
      const list = byLane.get(b.laneId) ?? [];
      list.push(b);
      byLane.set(b.laneId, list);
    }
  }
  const map = new Map<string, { members: BandMaterial[] }>();
  for (const [, members] of byLane) {
    const rec = { members: [...members].sort((a, b) => a.center.y - b.center.y) };
    for (const m of members) map.set(m.id, rec);
  }
  return map;
}

export interface CasepackBuild {
  bundle: ProjectBundle;
  branchNames: string[];
  blobBytes: Map<string, Uint8Array>;
}

export function buildCasepack(): CasepackBuild {
  const defs = buildBranchDefs();
  const events: DomainEvent[] = [];
  const blobs: ProjectBundle['blobs'] = [];
  const blobBytes = new Map<string, Uint8Array>();
  let seq = 0;
  const next = () => seq++;

  const branches: Record<string, { name: string; parent: string | null; forkEventSeq: number | null; purpose: string }> = {};
  for (const d of defs) {
    branches[d.name] = {
      name: d.name,
      parent: d.name === 'baseline' ? null : 'baseline',
      forkEventSeq: null,
      purpose: d.purpose
    };
  }

  const { project, event: created } = newProject(PROJECT_ID, PROJECT_NAME, branches, SEED_STAMP);
  created.seq = next();
  events.push(created);

  const generated = new Map<string, { img: GrayImage; png: Uint8Array; def: BranchDef }>();
  for (const def of defs) {
    const { image: img } = generateGel(def.variant);
    const png = encodePng(img);
    generated.set(def.name, { img, png, def });
  }

  for (const def of defs) {
    const gen = generated.get(def.name)!;
    if (def.name === 'baseline') {
      buildBaseline(events, next, project.id, def, gen.img, gen.png, blobs, blobBytes);
    } else {
      buildVariant(events, next, project.id, def, gen.img, gen.png, blobs, blobBytes);
    }
  }

  events.sort((a, b) => a.seq - b.seq);
  return {
    bundle: {
      format: 'gel-ruler/project-bundle',
      bundleVersion: 1,
      projectId: PROJECT_ID,
      events,
      blobs,
      casepack: true,
      exportedAt: stamp(99)
    },
    branchNames: defs.map((d) => d.name),
    blobBytes
  };
}

type NextSeq = () => number;

function addBlob(blobs: ProjectBundle['blobs'], blobBytes: Map<string, Uint8Array>, png: Uint8Array): string {
  const id = `blob_${sha256Hex(png).slice(0, 32)}`;
  if (!blobBytes.has(id)) {
    blobBytes.set(id, png);
    blobs.push({ id, mediaType: 'image/png', bytesBase64: Buffer.from(png).toString('base64') });
  }
  return id;
}

function ladderSpecFor(projectId: string, imageId: string, def: BranchDef): LadderSpec {
  const lId = laneId(projectId, imageId, LADDER_LANE_INDEX);
  const spec: LadderSpec = {
    id: ladderSpecId(projectId, lId),
    kind: 'ladder-spec',
    laneId: lId,
    name: 'DL-10k (catalog mock)',
    nominal: nominalFor(def),
    source: { origin: 'import', reference: LADDER_REF, capturedAt: stamp(2), rawRepresentation: def.nonmonotonic ? '10000,5000,3000,1500,2000,1000,500,250' : '10000,5000,3000,2000,1500,1000,500,250' }
  };
  return spec;
}

interface BranchDerivation {
  auto: ReturnType<typeof runAutoDetection>;
  calibration?: ReturnType<typeof computeCalibrationEvent>;
  mass?: ReturnType<typeof computeMassEvent>;
}

function deriveBranch(
  events: DomainEvent[],
  next: NextSeq,
  projectId: string,
  def: BranchDef,
  image: ImageMaterial,
  img: GrayImage,
  paramsVersion: 1 | 2,
  parents: string[],
  stampOffset = 10
): BranchDerivation {
  const params = PARAMS_BY_VERSION[paramsVersion];
  const specs = laneSpecsFor(def, image.id, img);
  const auto = runAutoDetection(projectId, def.name, next(), image, img.pixels, specs, params, parents, stampOffset);
  events.push(auto.event);

  const spec = ladderSpecFor(projectId, image.id, def);
  events.push(makeMaterialEvent(def.name, next(), spec, [image.id], stampOffset + 1));

  const ladderBands = auto.bands.filter((b) => b.laneId === spec.laneId);
  const calibration = computeCalibrationEvent(def.name, next(), image, spec, ladderBands, auto.sByBand, params, [auto.event.id, spec.id], stampOffset + 2);
  events.push(calibration.event);

  let mass: ReturnType<typeof computeMassEvent> | undefined;
  if (calibration.results.length) {
    const sampleBands = auto.bands.filter((b) => b.laneId !== spec.laneId);
    mass = computeMassEvent(
      def.name,
      next(),
      image,
      sampleBands,
      auto.sByBand,
      calibration.results[0],
      params,
      [calibration.event.id],
      clusterMap(sampleBands),
      stampOffset + 3
    );
    events.push(mass.event);
  }
  return { auto, calibration, mass };
}

function buildVariant(
  events: DomainEvent[],
  next: NextSeq,
  projectId: string,
  def: BranchDef,
  img: GrayImage,
  png: Uint8Array,
  blobs: ProjectBundle['blobs'],
  blobBytes: Map<string, Uint8Array>
) {
  const isRotated = def.name === 'rotated';
  let displayImg = img;
  let bytes = png;
  if (isRotated) {
    displayImg = rotate90CW(img, 'frame://rotated/raw-rotated90');
    bytes = encodePng(displayImg);
  }
  const blobRef = addBlob(blobs, blobBytes, bytes);
  const imageId = stableId('img', [projectId, def.name, blobRef]);
  const role: ImageMaterial['role'] = isRotated ? 'rotated-gel' : def.variant.smile ? 'smile-gel' : 'sample-gel';
  const image = imageMaterial(imageId, blobRef, displayImg, role, displayImg.frameId, isRotated ? 6 : 1, 0, def.name);

  events.push(makeMaterialEvent(def.name, next(), image, [], 20));

  if (isRotated) {
    const gated: DomainEvent = {
      id: eventId(next(), 'auto-detected', [image.id, 'gated-orientation']),
      seq: 0,
      branch: def.name,
      type: 'auto-detected',
      at: stamp(21),
      parents: [image.id],
      inputDigest: digestOf({ image: image.id, orientation: image.orientation }),
      payload: { lanes: [], bands: [], paramsVersion: 1, rejected: true, reason: 'ORIENTATION_NOT_VERIFIED' },
      diagnostics: [
        diag(
          'ORIENTATION_NOT_VERIFIED',
          'SEMANTIC_UNRESOLVABLE',
          '拍摄方向(orientation=6)未经核对：凝胶泳道与像素帧不一致，禁止检测分子量',
          [{ material: image.id, field: 'orientation', pixel: { x: 0, y: 0, frame: image.frameId } }]
        )
      ],
      affected: [image.id]
    };
    gated.seq = events.length === 0 ? 0 : Math.max(...events.map((e) => e.seq)) + 1;
    gated.id = eventId(gated.seq, 'auto-detected', [image.id, 'gated-orientation']);
    events.push(gated);

    const corrected: ImageMaterial = { ...image, orientation: 1, rotationAppliedDeg: 90, frameId: `${image.frameId}#corrected` };
    events.push({
      id: eventId(0, 'orientation-corrected', [image.id]),
      seq: 0,
      branch: def.name,
      type: 'orientation-corrected',
      at: stamp(22),
      parents: [image.id, gated.id],
      inputDigest: digestOf({ from: 6, to: 1, rotationAppliedDeg: 90 }),
      payload: { image: corrected, fromOrientation: 6, toOrientation: 1, rotationAppliedDeg: 90 }
    });
    const last = events[events.length - 1];
    last.seq = Math.max(...events.map((e) => e.seq)) + 1;
    last.id = eventId(last.seq, 'orientation-corrected', [image.id]);
    deriveBranch(events, next, projectId, def, corrected, displayImg, 1, [last.id], 23);
    return;
  }

  deriveBranch(events, next, projectId, def, image, displayImg, 1, [image.id], 20);

  if (def.name === 'local-invalidation') {
    rebuildOneLane(events, next, projectId, def, image, displayImg);
  }
}

function rebuildOneLane(
  events: DomainEvent[],
  next: NextSeq,
  projectId: string,
  def: BranchDef,
  image: ImageMaterial,
  img: GrayImage,
  first?: BranchDerivation
) {
  const params = PARAMS_BY_VERSION[1];
  const targetOrder = 5;
  const oldLaneId = laneId(projectId, image.id, targetOrder);
  if (!first) throw new Error('rebuildOneLane requires first derivation');
  const oldBands = first.auto.bands.filter((b) => b.laneId === oldLaneId);
  const oldMassIds = (first.mass?.results ?? []).filter((r) => r.laneId === oldLaneId).map((r) => r.id);

  const shifted = straightCenterline(image, LANE_CENTERS[targetOrder] + 12).map((p) => ({ x: p.x + 2, y: p.y }));
  const editedLane: LaneMaterial = {
    id: oldLaneId,
    kind: 'lane',
    imageId: image.id,
    role: 'sample',
    order: targetOrder,
    centerline: shifted,
    halfWidthPx: LANE_HALF_WIDTH,
    source: { origin: 'manual', reference: 'reviewer@2026-09-23T02:40:00Z:drag-boundary+12px', capturedAt: stamp(40) }
  };
  const editEvent: DomainEvent = {
    id: eventId(0, 'lane-edited', [oldLaneId]),
    seq: 0,
    branch: def.name,
    type: 'lane-edited',
    at: stamp(40),
    parents: [image.id, oldLaneId],
    inputDigest: digestOf({ centerline: shifted }),
    payload: { lane: editedLane, invalidatedBandIds: oldBands.map((b) => b.id), invalidatedMassResultIds: oldMassIds, reason: 'boundary-shift' },
    affected: [oldLaneId, ...oldBands.map((b) => b.id), ...oldMassIds]
  };
  pushSequenced(events, editEvent, next);

  const auto = runAutoDetection(
    projectId,
    def.name,
    next(),
    image,
    img.pixels,
    [
      {
        order: targetOrder,
        role: 'sample',
        centerline: shifted,
        halfWidthPx: LANE_HALF_WIDTH
      }
    ],
    params,
    [editEvent.id],
    41,
    { bands: oldBands.map((b) => b.id), massResults: oldMassIds }
  );
  events.push(auto.event);

  const cal = first.calibration!.results[0];
  const bands = auto.bands;
  const mass = computeMassEvent(
    def.name,
    next(),
    image,
    bands,
    auto.sByBand,
    cal,
    params,
    [auto.event.id, cal.id],
    clusterMap(bands),
    42
  );
  events.push(mass.event);
}

function pushSequenced(events: DomainEvent[], ev: DomainEvent, next: NextSeq) {
  ev.seq = next();
  ev.id = eventId(ev.seq, ev.type, [ev.inputDigest, ev.branch, ev.payload]);
  events.push(ev);
}

function buildBaseline(
  events: DomainEvent[],
  next: NextSeq,
  projectId: string,
  def: BranchDef,
  img: GrayImage,
  png: Uint8Array,
  blobs: ProjectBundle['blobs'],
  blobBytes: Map<string, Uint8Array>
) {
  const blobRef = addBlob(blobs, blobBytes, png);
  const imageId = stableId('img', [projectId, def.name, blobRef]);
  const image = imageMaterial(imageId, blobRef, img, 'sample-gel', img.frameId, 1, 0, def.name);
  events.push(makeMaterialEvent(def.name, next(), image, [], 10));
  const imageEvent = events[events.length - 1];

  // v1 自动候选
  const v1 = deriveBranch(events, next, projectId, def, image, img, 1, [imageEvent.id], 11);

  // 参数修订 v1 -> v2（全局直线改为分段内插，饱和阈值收紧）
  const reviseEvent: DomainEvent = {
    id: eventId(0, 'params-revised', ['baseline', 2]),
    seq: 0,
    branch: 'baseline',
    type: 'params-revised',
    at: stamp(30),
    parents: [v1.mass!.event.id],
    inputDigest: digestOf({ from: 1, to: 2 }),
    payload: { fromVersion: 1, params: PARAMS_V2 },
    diagnostics: [diag('PARAMS_REVISED', 'SEMANTIC_UNRESOLVABLE', '标尺方法从 v1 全局直线修订为 v2 分段内插；v1 结果保留为历史，不覆盖', [], 'info')],
    affected: v1.mass!.results.map((r) => r.id)
  };
  pushSequenced(events, reviseEvent, next);

  // v2 重算全部泳道（参数修订是全局依赖）
  const v2 = deriveBranch(events, next, projectId, def, image, img, 2, [reviseEvent.id], 31);

  // 只改一条 lane 边界：影响必须限制在该 lane（局部依赖改动）
  rebuildOneLane(events, next, projectId, def, image, img, v2);

  // 人工决定：接受一个 resolved 值
  const acceptTarget = v2.mass!.results.find((r) => r.status === 'resolved' && r.singleBp && Math.abs(r.singleBp - 900) < 120)!;
  events.push(makeDecisionEvent('baseline', next(), acceptTarget, 'accepted', acceptTarget.singleBp, '审阅者接受自动候选', [], null, 50));

  // 否定一个区间值（饱和），保留区间证据但不采纳
  const rejectTarget = v2.mass!.results.find((r) => r.status === 'interval')!;
  events.push(makeDecisionEvent('baseline', next(), rejectTarget, 'rejected', null, '饱和条带：拒绝唯一值，保留区间证据', [], null, 51));

  // 互相冲突的人工决定：同一区间两个审阅者各选不同 bp
  const conflictBandId = rejectTarget.bandId;
  const d1 = makeDecisionEvent('baseline', next(), rejectTarget, 'adjusted', rejectTarget.intervalBp![0], '审阅者甲采用区间下界', [], null, 52);
  const dec1 = d1.payload.decision as Decision;
  events.push(d1);
  const d2 = makeDecisionEvent(
    'baseline',
    next(),
    v2.mass!.results.find((r) => r.bandId === conflictBandId)!,
    'adjusted',
    v2.mass!.results.find((r) => r.bandId === conflictBandId)!.intervalBp![1],
    '审阅者乙采用区间上界（冲突）',
    [dec1.id],
    null,
    53
  );
  d2.payload.conflictsWith = [dec1.id];
  (d2.payload.decision as Decision).conflictsWith = [dec1.id];
  events.push(d2);
}
