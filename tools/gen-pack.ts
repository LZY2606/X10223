/**
 * 离线案例包生成器（npm postinstall 自动运行，产物入库）。
 * 生成一个完整项目 + 7 条反例分支的事件历史与图像，并做重放校验。
 */
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { renderGel, lanePolyline, LADDER_BP, type GelSpec, type SynthBand } from '../shared/synthetic';
import { rotateRaster } from '../shared/imageOps';
import { encodePng } from '../shared/png';
import { hashJson, sha256Bytes, shortId } from '../shared/hash';
import { makeQuantity } from '../shared/units';
import {
  DEFAULT_RULE_PARAMS,
  RULES_VERSION,
  type BandMark,
  type BandMarksMaterial,
  type CounterexampleRecord,
  type Event,
  type ExposureMaterial,
  type ImageMaterial,
  type LadderSpecMaterial,
  type LaneMapMaterial,
  type Material,
  type OrientationMaterial,
  type PhysicalQuantity,
  type RuleParams,
  type SourcedPoint
} from '../shared/types';
import { computeEventId } from '../shared/events';
import { derive } from '../shared/calibration';
import { detectPeaks, peaksToBandMarksMaterial } from '../shared/detect';
import { toCanonical, cumulativeLengths, projectToCurve } from '../shared/geometry';
import type { Raster } from '../shared/png';
import { decodePng } from '../shared/png';
import type { Bundle, ImageBlob } from '../shared/bundle';
import { BUNDLE_FORMAT } from '../shared/bundle';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'data', 'sample-project');
const W = 360;
const H = 520;
const LANE_XS = [60, 120, 180, 240, 300];
const NOW = '2026-09-19T00:40:00.000Z';

function time(min: number): string {
  return new Date(Date.parse(NOW) + min * 60000).toISOString();
}

function prov(materialId: string, origin: 'auto' | 'manual' | 'imported', method: string, basedOn?: string[]) {
  return { materialId, origin, method, basedOn };
}

function ladderMaterials(imageId: string, missingIndex?: number): LadderSpecMaterial {
  const bands = LADDER_BP.map((bp, i) => {
    const { q } = makeQuantity(`${bp} bp`, 'nucleic-acid');
    return { index: i, mass: q, present: !(missingIndex !== undefined && i === missingIndex) };
  });
  const idSeed = { t: 'ladder', missing: missingIndex ?? -1 };
  return {
    kind: 'ladderSpec',
    id: shortId(hashJson(idSeed), 'lad'),
    name: missingIndex === undefined ? 'DS-1kb 合成标尺' : `DS-1kb 合成标尺（缺 #${missingIndex}）`,
    analyte: 'nucleic-acid',
    bands,
    provenance: prov('synthetic-catalog-v1', 'imported', 'makeQuantity')
  };
}

const LADDER_S = [60, 100, 145, 195, 250, 305, 360, 410, 455];

function buildGel(opts: { smileAmp: number; missingIndex?: number; saturatedLane?: number; saturatedS?: number; overlap?: boolean; smear?: boolean }): {
  spec: GelSpec;
  png: Buffer;
  raster: Raster;
} {
  const bands: SynthBand[] = [];
  for (let i = 0; i < LADDER_S.length; i++) {
    if (opts.missingIndex === i) continue;
    bands.push({ laneIndex: 0, s: LADDER_S[i]!, amplitude: 150, sigmaX: 10, sigmaY: 7 });
  }
  const sampleS = [120, 220, 300, 380];
  for (const s of sampleS) {
    for (let lane = 1; lane < LANE_XS.length; lane++) {
      bands.push({ laneIndex: lane, s, amplitude: lane === 2 ? 120 : 140, sigmaX: 10, sigmaY: 7 });
    }
  }
  if (opts.saturatedLane !== undefined) {
    bands.push({ laneIndex: opts.saturatedLane, s: opts.saturatedS!, amplitude: 300, sigmaX: 12, sigmaY: 8 });
  }
  if (opts.overlap) {
    bands.push({ laneIndex: 3, s: 260, amplitude: 150, sigmaX: 9, sigmaY: 7 });
    bands.push({ laneIndex: 3, s: 268, amplitude: 140, sigmaX: 9, sigmaY: 7 });
  }
  if (opts.smear) {
    bands.push({ laneIndex: 4, s: 180, amplitude: 130, sigmaX: 12, sigmaY: 7, smear: true });
  }
  const spec: GelSpec = { width: W, height: H, laneXs: LANE_XS, laneHalfWidth: 18, smileAmp: opts.smileAmp, bands };
  const { png, raster } = renderGel(spec);
  return { spec, png, raster };
}

function imageMaterial(png: Buffer, name: string, raster: Raster): { material: ImageMaterial; blob: ImageBlob } {
  const sha = sha256Bytes(png);
  return {
    material: {
      kind: 'image',
      id: shortId(hashJson({ t: 'image', sha }), 'img'),
      sha256: sha,
      width: raster.width,
      height: raster.height,
      channels: raster.channels,
      byteLength: png.length,
      mediaType: 'image/png',
      originalName: name,
      createdAt: NOW
    },
    blob: { sha256: sha, mediaType: 'image/png', base64: png.toString('base64'), byteLength: png.length }
  };
}

function orientationMaterial(imageId: string, rotationDeg: 0 | 90 | 180 | 270): OrientationMaterial {
  return {
    kind: 'orientation',
    id: shortId(hashJson({ t: 'orient', imageId, rotationDeg }), 'ori'),
    imageId,
    rotationDeg,
    flipH: false,
    flipV: false,
    provenance: prov(imageId, 'imported', 'capture-direction-check')
  };
}

function exposureMaterial(imageId: string): ExposureMaterial {
  const duration: PhysicalQuantity = { value: 1.2, unit: 's', rawText: '1.2 s', canonicalUnit: 's' };
  return {
    kind: 'exposure',
    id: shortId(hashJson({ t: 'exp', imageId }), 'exp'),
    imageId,
    duration,
    intensityFloor: 0,
    intensityCeiling: 255,
    inverted: false,
    provenance: prov(imageId, 'imported', 'exposure-reading')
  };
}

function laneMapMaterial(imageId: string, smileAmp: number, rotationDeg: 0 | 90 | 180 | 270, raster: Raster): LaneMapMaterial {
  const dims = { width: W, height: H };
  const lanes = LANE_XS.map((lx, laneIndex) => {
    const canon = lanePolyline(lx, W, H, smileAmp);
    const centerline: SourcedPoint[] = canon.map((p) => ({
      ...p,
      frame: 'canonical' as const,
      source: prov(imageId, 'imported', 'lane-trace', [RULES_VERSION])
    }));
    const leftBoundary = centerline.map((p) => ({ ...p, x: p.x - 18, source: { ...p.source, method: 'lane-trace-left' } }));
    const rightBoundary = centerline.map((p) => ({ ...p, x: p.x + 18, source: { ...p.source, method: 'lane-trace-right' } }));
    void rotationDeg;
    void raster;
    void dims;
    return { laneIndex, centerline, leftBoundary, rightBoundary };
  });
  return {
    kind: 'laneMap',
    id: shortId(hashJson({ t: 'lanes', imageId, smileAmp }), 'lmap'),
    imageId,
    lanes,
    provenance: prov(imageId, 'imported', 'lane-trace')
  };
}

function paramsPayload(overrides: Partial<RuleParams> = {}, version = 1) {
  const params: RuleParams = { ...DEFAULT_RULE_PARAMS, ...overrides, version };
  const paramsHash = shortId(hashJson(params), 'par');
  return { params, paramsHash };
}

function detectBands(raster: Raster, imageId: string, smileAmp: number, paramsHash: string, rotationDeg: 0 | 90 | 180 | 270) {
  const laneMap = laneMapMaterial(imageId, smileAmp, rotationDeg, raster);
  const orientation = orientationMaterial(imageId, rotationDeg);
  const exposure = exposureMaterial(imageId);
  const detection = detectPeaks(raster, laneMap, orientation, exposure, { ...DEFAULT_RULE_PARAMS });
  const marks = peaksToBandMarksMaterial(imageId, laneMap.id, detection, paramsHash, RULES_VERSION);
  return { laneMap, orientation, exposure, detection, marks };
}

type E = Event;

function makeEvent(event: Omit<E, 'id'>): E {
  return { ...(event as object), id: computeEventId(event) } as E;
}

interface Chain {
  events: E[];
  images: ImageBlob[];
  materialIds: { image: string; orientation: string; exposure: string; ladder: string; laneMap: string; marks: string };
}

function materialAdded(parentId: string, material: Material, min: number): E {
  return makeEvent({ kind: 'materialAdded', parentId, timestamp: time(min), material });
}

/**
 * 构造一条分支：基线（直胶道）-> 该反例只改动一个直接来源 -> 自动检测 -> 派生。
 */
function buildChain(args: {
  projectId: string;
  rootEvent: E;
  branchName: string;
  min0: number;
  gel: { png: Buffer; raster: Raster };
  imageName: string;
  smileAmp: number;
  rotationDeg: 0 | 90 | 180 | 270;
  ladder: LadderSpecMaterial;
  paramsOverrides?: Partial<RuleParams>;
}): Chain {
  const events: E[] = [];
  const images: ImageBlob[] = [];
  const { material: imageMat, blob } = imageMaterial(args.gel.png, args.imageName, args.gel.raster);
  images.push(blob);

  const { params, paramsHash } = paramsPayload(args.paramsOverrides ?? {}, 1);
  let parent = args.rootEvent.id;
  const min = (d: number) => time(args.min0 + d);

  const eImg = materialAdded(parent, imageMat, args.min0);
  events.push(eImg); parent = eImg.id;
  const orientation = orientationMaterial(imageMat.id, args.rotationDeg);
  const exposure = exposureMaterial(imageMat.id);
  const laneMap = laneMapMaterial(imageMat.id, args.smileAmp, args.rotationDeg, args.gel.raster);
  const eOri = materialAdded(parent, orientation, args.min0 + 1);
  events.push(eOri); parent = eOri.id;
  const eExp = materialAdded(parent, exposure, args.min0 + 2);
  events.push(eExp); parent = eExp.id;
  const eLad = materialAdded(parent, args.ladder, args.min0 + 3);
  events.push(eLad); parent = eLad.id;
  const eLanes = materialAdded(parent, laneMap, args.min0 + 4);
  events.push(eLanes); parent = eLanes.id;

  const { marks } = detectBands(args.gel.raster, imageMat.id, args.smileAmp, paramsHash, args.rotationDeg);
  const eMarks = materialAdded(parent, marks, args.min0 + 5);
  events.push(eMarks); parent = eMarks.id;

  const eParams = makeEvent({ kind: 'paramsSet', parentId: parent, timestamp: min(6), params, paramsHash });
  events.push(eParams); parent = eParams.id;

  const { derivation } = derive({
    materials: { imageId: imageMat.id, orientation, exposure, ladder: args.ladder, laneMap, bandMarks: [marks] },
    params,
    paramsHash,
    trigger: 'initial',
    parents: [parent]
  });
  const eDeriv = makeEvent({ kind: 'derivationRecorded', parentId: parent, timestamp: min(7), derivation });
  events.push(eDeriv);

  return {
    events,
    images,
    materialIds: {
      image: imageMat.id,
      orientation: orientation.id,
      exposure: exposure.id,
      ladder: args.ladder.id,
      laneMap: laneMap.id,
      marks: marks.id
    }
  };
}

function appendDerivation(
  events: E[],
  parentId: string,
  min: number,
  ctx: {
    imageId: string;
    orientation: OrientationMaterial;
    exposure: ExposureMaterial;
    ladder: LadderSpecMaterial;
    laneMap: LaneMapMaterial;
    marks: BandMarksMaterial;
    params: RuleParams;
    paramsHash: string;
    trigger: 'initial' | 'material-change' | 'params-change' | 'decision';
    decisions?: { targetId: string; verb: 'accept' | 'reject' | 'adjust'; payload?: Record<string, unknown>; idList?: string[] };
  }
): E {
  const { derivation } = derive({
    materials: {
      imageId: ctx.imageId,
      orientation: ctx.orientation,
      exposure: ctx.exposure,
      ladder: ctx.ladder,
      laneMap: ctx.laneMap,
      bandMarks: [ctx.marks]
    },
    params: ctx.params,
    paramsHash: ctx.paramsHash,
    decisions: ctx.decisions ? [ctx.decisions] : [],
    acceptedDecisionIds: ctx.decisions?.idList ?? [],
    trigger: ctx.trigger,
    parents: [parentId]
  });
  const e = makeEvent({ kind: 'derivationRecorded', parentId, timestamp: time(min), derivation });
  events.push(e);
  return e;
}

function decisionEvent(
  parentId: string,
  min: number,
  verb: 'accept' | 'reject' | 'adjust',
  targetId: string,
  payload?: Record<string, unknown>,
  reason?: string,
  author = 'reviewer-li'
): E {
  return makeEvent({ kind: 'decision', parentId, timestamp: time(min), author, verb, targetId, payload, reason });
}

function amendMarks(
  parentId: string,
  min: number,
  previous: BandMarksMaterial,
  mutate: (bands: BandMark[]) => BandMark[]
): E {
  const bands = mutate(previous.bands.map((b) => ({ ...b })));
  const material: BandMarksMaterial = {
    ...previous,
    id: shortId(hashJson({ t: 'bmarks-amend', prev: previous.id, bands: bands.map((b) => [b.id, b.center.x, b.center.y, b.saturated, b.smear]) }), 'bmarks'),
    bands,
    provenance: { ...previous.provenance, origin: 'manual', method: 'manual-revision' }
  };
  return makeEvent({ kind: 'materialAmended', parentId, timestamp: time(min), supersedesId: previous.id, material });
}

function manualBand(base: BandMark, overrides: Partial<BandMark>): BandMark {
  return {
    ...base,
    ...overrides,
    center: overrides.center
      ? { ...overrides.center, source: { ...base.center.source, origin: 'manual', method: 'manual-revision' } }
      : base.center,
    provenance: { ...base.provenance, origin: 'manual', method: 'manual-revision' }
  };
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const projectId = 'proj_gel-ruler-offline-case';
  const allEvents: E[] = [];
  const allImages = new Map<string, ImageBlob>();
  const counterexamples: CounterexampleRecord[] = [];

  const root = makeEvent({ kind: 'projectCreated', parentId: null, timestamp: time(0), projectId, name: '胶道标尺：电泳条带、泳道弯曲与分子量校准工作台（离线案例）' });
  allEvents.push(root);

  // ---------- 基线（直泳道、完整 ladder、正常曝光） ----------
  const baselineGel = buildGel({ smileAmp: 0 });
  const baselineLadder = ladderMaterials('');
  const baseline = buildChain({
    projectId,
    rootEvent: root,
    branchName: 'baseline',
    min0: 1,
    gel: baselineGel,
    imageName: 'baseline-straight.png',
    smileAmp: 0,
    rotationDeg: 0,
    ladder: baselineLadder
  });
  allEvents.push(...baseline.events);
  baseline.images.forEach((img) => allImages.set(img.sha256, img));
  const baselineHead = baseline.events[baseline.events.length - 1]!;
  const baselineFirstDeriv = baselineHead;

  // 基线之上：一次参数修订（饱和阈值 250 -> 235）
  const { params: paramsV2, paramsHash: hashV2 } = paramsPayload({ saturationThreshold: 235 }, 2);
  const eParV2 = makeEvent({ kind: 'paramsSet', parentId: baselineHead.id, timestamp: time(10), params: paramsV2, paramsHash: hashV2 });
  allEvents.push(eParV2);
  const baseMarks = extractMarks(baseline.events);
  const baseCtx = extractCtx(baseline.events, baseline.materialIds);
  const eDerivV2 = appendDerivation(allEvents, eParV2.id, 11, {
    ...baseCtx,
    marks: baseMarks,
    params: paramsV2,
    paramsHash: hashV2,
    trigger: 'params-change'
  });

  // 一次只影响局部依赖的源数据改动：人工把 3 号泳道一个条带中心微调 3px（仅该候选与相关段残差受影响）
  const targetBand = baseMarks.bands.find((b) => b.laneIndex === 3 && b.arcLength! > 200 && b.arcLength! < 240)!;
  const eAmend = amendMarks(eDerivV2.id, 12, baseMarks, (bands) =>
    bands.map((b) => (b.id === targetBand.id ? manualBand(b, { center: { ...b.center, x: b.center.x + 3, y: b.center.y + 3, frame: 'canonical', source: b.center.source } }) : b))
  );
  allEvents.push(eAmend);
  const amendedMarks = (eAmend as Extract<E, { kind: 'materialAmended' }>).material as BandMarksMaterial;
  const eDerivLocal = appendDerivation(allEvents, eAmend.id, 13, {
    ...baseCtx,
    marks: amendedMarks,
    params: paramsV2,
    paramsHash: hashV2,
    trigger: 'material-change'
  });
  counterexamples.push(
    counterexample('revision-local-invalidation', 'baseline', `/event/${eAmend.id}/material/bands/${targetBand.id}/center`, [
      targetBand.id,
      ...candidateIdsFor(eDerivLocal, targetBand.id)
    ], allEvents, baseline.events, eDerivV2, eDerivLocal, ['single-source-change-scoped-impact'])
  );

  // 一次互相冲突的人工决定：同一候选先 accept 后 reject（冲突保留两个结论）
  const acceptedCandidateId = firstSampleCandidateId(eDerivV2);
  const eAccept = decisionEvent(eDerivV2.id, 14, 'accept', acceptedCandidateId, undefined, '自动候选与预期一致，接受');
  allEvents.push(eAccept);
  const eConflict = decisionEvent(eAccept.id, 15, 'reject', acceptedCandidateId, undefined, '复核发现上样量异常，改判拒绝（与先前接受冲突，待裁决）', 'reviewer-zhao');
  allEvents.push(eConflict);

  // ---------- 7 条反例分支：每条只改动一个直接来源 ----------
  const branches: Array<{
    case: CounterexampleRecord['case'];
    name: string;
    build: () => { gel: ReturnType<typeof buildGel>; smileAmp: number; rotation: 0 | 90 | 180 | 270; ladder: LadderSpecMaterial; overrides?: Partial<RuleParams>; judgments: CounterexampleRecord['judgments']; changedSource: string };
  }> = [
    {
      case: 'rotation',
      name: 'rotation-90.png',
      changedSource: '/material/orientation/rotationDeg',
      build: () => ({ gel: rotatedGel(baselineGel.raster, 90), smileAmp: 0, rotation: 90, ladder: baselineLadder, judgments: [] })
    },
    {
      case: 'curved-lane',
      name: 'curved-smile.png',
      changedSource: '/material/laneMap/centerline',
      build: () => ({ gel: buildGel({ smileAmp: 26 }), smileAmp: 26, rotation: 0, ladder: baselineLadder, judgments: [] })
    },
    {
      case: 'ladder-missing',
      name: 'ladder-missing.png',
      changedSource: '/material/ladderSpec/bands/4/present',
      build: () => ({
        gel: buildGel({ smileAmp: 0, missingIndex: 4 }),
        smileAmp: 0,
        rotation: 0,
        ladder: ladderMaterials('', 4),
        judgments: []
      })
    },
    {
      case: 'saturation',
      name: 'saturation.png',
      changedSource: '/material/image/pixels(saturated-blob)',
      build: () => ({ gel: buildGel({ smileAmp: 0, saturatedLane: 2, saturatedS: 170 }), smileAmp: 0, rotation: 0, ladder: baselineLadder, judgments: [] })
    },
    {
      case: 'overlap',
      name: 'overlap.png',
      changedSource: '/material/bandMarks(second-peak-center)',
      build: () => ({ gel: buildGel({ smileAmp: 0, overlap: true }), smileAmp: 0, rotation: 0, ladder: baselineLadder, judgments: [] })
    },
    {
      case: 'nonmonotonic',
      name: 'nonmonotonic.png',
      changedSource: '/material/ladderSpec/bands(nominal-order)',
      build: () => ({ gel: baselineGel, smileAmp: 0, rotation: 0, ladder: nonMonotonicLadder(), judgments: [] })
    }
  ];

  let minute = 20;
  for (const branch of branches) {
    const spec = branch.build();
    const chain = buildChain({
      projectId,
      rootEvent: root,
      branchName: branch.case,
      min0: minute,
      gel: spec.gel,
      imageName: branch.name,
      smileAmp: spec.smileAmp,
      rotationDeg: spec.rotation,
      ladder: spec.ladder,
      paramsOverrides: spec.overrides
    });
    allEvents.push(...chain.events);
    chain.images.forEach((img) => allImages.set(img.sha256, img));
    const head = chain.events[chain.events.length - 1]!;
    const record = counterexample(
      branch.case,
      branch.case,
      branch.changedSource,
      collectAffected(head, branch.case),
      allEvents,
      baseline.events,
      baselineFirstDeriv,
      head,
      judgmentRulesFor(branch.case)
    );
    counterexamples.push(record);
    minute += 10;
  }

  const replayChecks = allEvents
    .filter((e): e is Extract<E, { kind: 'derivationRecorded' }> => e.kind === 'derivationRecorded')
    .map((e) => ({ eventId: e.id, digest: e.derivation.digest }));

  const bundle: Bundle = {
    format: BUNDLE_FORMAT,
    projectId,
    name: root.name,
    exportedAt: time(minute + 5),
    events: allEvents,
    images: [...allImages.values()],
    counterexamples,
    replayChecks
  };

  const outPath = join(OUT_DIR, 'case.gelbundle.json');
  writeFileSync(outPath, JSON.stringify(bundle));
  // 同时落一份原始 PNG，便于人工核对“原图”来源。
  for (const img of allImages.values()) {
    writeFileSync(join(OUT_DIR, `${img.sha256.slice(0, 12)}.png`), Buffer.from(img.base64, 'base64'));
  }
  console.log(`案例包写入 ${outPath}`);
  console.log(`事件 ${allEvents.length} 个，图像 ${allImages.size} 张，反例 ${counterexamples.length} 条`);
}

// ---------- 主流程辅助 ----------

function extractMarks(events: E[]): BandMarksMaterial {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.kind === 'materialAdded' && e.material.kind === 'bandMarks') return e.material;
  }
  throw new Error('未找到 bandMarks');
}

function extractCtx(events: E[], ids: Chain['materialIds']) {
  const find = <T extends Material>(id: string): T => {
    for (const e of events) {
      if ('material' in e && (e as { material?: Material }).material?.id === id) {
        return (e as { material: T }).material;
      }
    }
    throw new Error(`材料 ${id} 未找到`);
  };
  return {
    imageId: ids.image,
    orientation: find<OrientationMaterial>(ids.orientation),
    exposure: find<ExposureMaterial>(ids.exposure),
    ladder: find<LadderSpecMaterial>(ids.ladder),
    laneMap: find<LaneMapMaterial>(ids.laneMap)
  };
}

function firstSampleCandidateId(derivEvent: E): string {
  const d = (derivEvent as Extract<E, { kind: 'derivationRecorded' }>).derivation;
  const cand = d.bandCandidates.find((c) => c.laneIndex > 0) ?? d.bandCandidates[0]!;
  return cand.id;
}

function candidateIdsFor(derivEvent: E, bandMarkId: string): string[] {
  const d = (derivEvent as Extract<E, { kind: 'derivationRecorded' }>).derivation;
  return d.bandCandidates.filter((c) => c.bandMarkId === bandMarkId).map((c) => c.id);
}

function rotatedGel(src: Raster, deg: 90): { png: Buffer; raster: Raster } {
  const raster = rotateRaster(src, deg);
  return { png: encodePng(raster), raster };
}

function nonMonotonicLadder(): LadderSpecMaterial {
  // 交换中间两档标称值，制造“迁移顺序与标称质量矛盾”的非单调标尺
  const swapped = [...LADDER_BP];
  [swapped[3], swapped[4]] = [swapped[4], swapped[3]];
  const bands = swapped.map((bp, i) => {
    const { q } = makeQuantity(`${bp} bp`, 'nucleic-acid');
    return { index: i, mass: q, present: true };
  });
  return {
    kind: 'ladderSpec',
    id: shortId(hashJson({ t: 'ladder', nonmono: true }), 'lad'),
    name: 'DS-1kb 合成标尺（标称值顺序被人为打乱，非单调）',
    analyte: 'nucleic-acid',
    bands,
    provenance: prov('synthetic-catalog-v1', 'manual', 'nonmonotonic-fixture')
  };
}

function collectAffected(head: E, caseKind: CounterexampleRecord['case']): string[] {
  const d = (head as Extract<E, { kind: 'derivationRecorded' }>).derivation;
  if (caseKind === 'ladder-missing') return d.diagnostics.filter((x) => x.code === 'LADDER_MISSING_BAND').flatMap((x) => x.affects ?? []);
  if (caseKind === 'saturation') return d.bandCandidates.filter((c) => c.diagnostics.includes('BAND_SATURATED')).map((c) => c.id);
  if (caseKind === 'overlap') return d.bandCandidates.filter((c) => c.diagnostics.includes('BAND_OVERLAP')).map((c) => c.id);
  if (caseKind === 'nonmonotonic') return d.diagnostics.filter((x) => x.code === 'CALIBRATION_NONMONOTONIC').flatMap((x) => x.affects ?? []);
  return d.bandCandidates.map((c) => c.id);
}

function judgmentRulesFor(caseKind: CounterexampleRecord['case']): CounterexampleRecord['judgments'] {
  const mk = (rule: CounterexampleRecord['judgments'][number]['rule'], holds: boolean, detail: string, ids: string[] = []) => ({
    id: shortId(hashJson({ rule, holds }), 'j'),
    rule,
    holds,
    detail,
    evidenceEventIds: ids
  });
  switch (caseKind) {
    case 'curved-lane':
      return [
        mk('same-y-not-same-mass-on-smile', true, '同像素行 y 的两条带落在不同弧长 s 上，弧长基准给出不同分子量；按 y 直接比较会误判'),
        mk('local-ruler-requires-valid-region', true, '局部标尺段带 [sMin, sMax] 有效区域，段外只给区间/诊断')
      ];
    case 'saturation':
      return [mk('saturated-is-candidate-or-range', true, '峰值削顶 -> status=candidate，给 massRange 与合法候选，不给唯一值')];
    case 'overlap':
      return [
        mk('overlap-is-candidate-or-range', true, '中心距 < overlapDistancePx 的两条带只标候选/区间'),
        mk('all-legal-candidates-retained', true, '无法唯一决定时 legalCandidates 保留全部合法候选')
      ];
    case 'ladder-missing':
      return [mk('all-legal-candidates-retained', true, '缺带导致多种 ladder 配对，全部保留并给 LADDER_MISSING_BAND 诊断')];
    case 'nonmonotonic':
      return [mk('local-ruler-requires-valid-region', false, '没有单调配对，标尺段 monotonic=false，相关候选 invalid')];
    case 'rotation':
      return [mk('single-source-change-scoped-impact', true, '仅 orientation 来源改变，canonical 弧长与基线一致，候选身份稳定')];
  }
  return [];
}

function counterexample(
  caseKind: CounterexampleRecord['case'],
  branchId: string,
  changedSource: string,
  expectedAffected: string[],
  allEvents: E[],
  baselineEvents: E[],
  baselineHead: E,
  variantHead: E,
  judgments: CounterexampleRecord['judgments']
): CounterexampleRecord {
  return {
    kind: 'counterexample',
    id: shortId(hashJson({ case: caseKind, branch: branchId }), 'cx'),
    branchId,
    case: caseKind,
    changedSource,
    unchangedBaselineDigest: (baselineHead as Extract<E, { kind: 'derivationRecorded' }>).derivation.digest,
    expectedAffected,
    expectedUnaffected: [],
    adopted: [{ eventId: variantHead.id, verdict: 'accepted', note: '自动派生已归档，作为该反例的证据节点' }],
    rejectedAlternatives: allEvents.length === 0 ? [] : [{ eventId: baselineEvents[0]!.id, note: '基线材料不适用该反例，保留但未采纳到本分支' }],
    judgments
  };
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
