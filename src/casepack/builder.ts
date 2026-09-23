/**
 * 离线案例包构建：胶道标尺领域材料，不是通用表格。
 * 主分支叙事：导入基线（像素级来源）→ 参数修订 → 单源改动（曝光）→
 *   接受自动候选 → 冲突人工决定 → 否定 → 区间决定
 * 七个分支分别只改一个直接来源，重放覆盖全部七种情形。
 */
import type {
  BandObservation,
  BundleV1,
  Exposure,
  GelEvent,
  ImageMaterial,
  InputDigest,
  LadderNominal,
  LadderLaneMaterial,
  LaneMaterial,
  Orientation,
  PixelPoint,
  Provenance,
  CalibParamsV1,
  DecisionEvent,
} from '../shared/types.ts';
import { DEFAULT_CALIB_PARAMS_V1, RULES_VERSION } from '../shared/types.ts';
import {
  eventId,
  sampleMaterialsDigest,
  sha256Hex,
  slotId,
} from '../shared/util.ts';

function brEvt(projectId: string, branch: string, seq: number): string {
  return `evt:${projectId}:${branch}:${String(seq).padStart(4, '0')}`;
}
import { renderGel, baselineSpec, missingRungSpec, LADDER_BP, type GelSpec } from '../core/synth.ts';
import {
  classifyFlags,
  detectCurvedCenterline,
  extractLaneProfile,
  findPeaks,
  peaksToBands,
} from '../core/signal.ts';

export const CASE_PROJECT_ID = 'case-gelbench-001';
export const CASE_NAME = '胶道标尺：电泳条带、泳道弯曲与分子量校准工作台';

interface BuiltVariant {
  image: ImageMaterial;
  ladder: LadderLaneMaterial;
  lanes: LaneMaterial[];
  bands: BandObservation[];
  digest: InputDigest;
}

const SYNTH_ORIGIN: Provenance = {
  source: 'synthetic',
  eventId: '',
  note: '离线案例包：确定性合成凝胶原始图像',
};

function orientation(seedNote: string): Orientation {
  return {
    rotationDeg: 0,
    flipH: false,
    flipV: false,
    provenance: { ...SYNTH_ORIGIN, note: `拍摄方向：扫描仪正向 0°（${seedNote}）` },
  };
}

function exposure(gain: number, durationMs = 800): Exposure {
  return {
    duration: { value: durationMs, unit: 'ms', raw: `${durationMs} ms` },
    gain: { value: gain, unit: 'gray8', raw: gain === 1 ? '1x' : `${gain}x` },
    saturationGray: { value: 250, unit: 'gray8', raw: '250/255' },
    provenance: { ...SYNTH_ORIGIN, note: '曝光记录与增益（独立直接来源）' },
  };
}

function buildLadder(projectId: string, swapNominals = false): LadderLaneMaterial {
  const nominals: LadderNominal[] = LADDER_BP.map((bp, i) => {
    let value = bp;
    let raw = `${bp} bp`;
    if (swapNominals && i === 1) { value = 750; raw = '750 bp'; }
    if (swapNominals && i === 2) { value = 1000; raw = '1000 bp'; }
    return {
      rungId: slotId('rung', projectId, `R${String(i + 1).padStart(2, '0')}`),
      ordinal: i,
      mw: { value, unit: 'bp', raw },
      provenance: {
        ...SYNTH_ORIGIN,
        source: 'nominal-sheet',
        note: `ladder 标称表第 ${i + 1} 行，原始表示 "${raw}"`,
      },
    };
  });
  return {
    id: slotId('ladder', projectId, 'L0'),
    kind: 'ladder-lane',
    nominals,
    provenance: { ...SYNTH_ORIGIN, source: 'nominal-sheet' },
  };
}

function detectAll(
  projectId: string,
  spec: GelSpec,
  gel: ReturnType<typeof renderGel>,
  importEvtId: string,
  params: CalibParamsV1,
  curved: boolean,
): { lanes: LaneMaterial[]; bands: BandObservation[] } {
  const lanes: LaneMaterial[] = [];
  let bands: BandObservation[] = [];
  spec.lanes.forEach((sl, li) => {
    let centerline: PixelPoint[];
    if (curved) {
      centerline = detectCurvedCenterline(gel.pixels, gel.width, gel.height, sl.x, sl.halfWidth);
    } else {
      centerline = [
        { x: sl.x, y: 0, frame: 'image' },
        { x: sl.x, y: gel.height - 1, frame: 'image' },
      ];
    }
    const laneId = slotId('lane', projectId, `L${li}`);
    const lane: LaneMaterial = {
      id: laneId,
      index: li,
      role: sl.role === 'ladder' ? 'ladder' : 'sample',
      centerline,
      halfWidth: { value: sl.halfWidth, unit: 'px', raw: `${sl.halfWidth} px` },
      leftBoundary: centerline.map((p) => ({ ...p, x: p.x - sl.halfWidth })),
      rightBoundary: centerline.map((p) => ({ ...p, x: p.x + sl.halfWidth })),
      provenance: {
        source: 'auto-detect',
        eventId: importEvtId,
        anchors: centerline.slice(0, 4),
        note: curved ? '逐行亮质心跟踪的弯曲 lane 曲线' : '垂直扫描检测的直线 lane',
      },
    };
    lanes.push(lane);
    const profile = extractLaneProfile(gel.pixels, gel.width, gel.height, centerline, sl.halfWidth);
    const peaks = findPeaks(profile, { minHeight: 28, resolutionWidth: params.resolutionWidth });
    const flags = classifyFlags(peaks, {
      saturationGray: params.saturationGray,
      tailingRatio: params.tailingRatio,
    });
    bands = [...bands, ...peaksToBands(lane, profile, peaks, flags, importEvtId, projectId)];
  });
  return { lanes, bands };
}

function buildVariant(
  projectId: string,
  key: string,
  spec: GelSpec,
  importEvtId: string,
  params: CalibParamsV1,
  opts: { curved?: boolean; swapNominals?: boolean } = {},
): BuiltVariant {
  const gel = renderGel(spec);
  const hash = sha256Hex(gel.pixels);
  const image: ImageMaterial = {
    id: slotId('img', projectId, key),
    kind: 'gel-image',
    width: gel.width,
    height: gel.height,
    channels: 1,
    pixelsSha256: hash,
    orientation: orientation(key),
    exposure: exposure(spec.gain ?? 1),
    provenance: { ...SYNTH_ORIGIN, eventId: importEvtId, note: `原始凝胶图像（${key}）` },
  };
  const ladder = buildLadder(projectId, opts.swapNominals);
  const { lanes, bands } = detectAll(projectId, spec, gel, importEvtId, params, !!opts.curved);
  const digest = sampleMaterialsDigest({ image, ladder, lanes, bands });
  return { image, ladder, lanes, bands, digest };
}

interface EvtOpts {
  seq: number;
  branch: string;
  parent: string | null;
  atMs: number;
}

function base<T extends GelEvent>(projectId: string, type: T['type'], o: EvtOpts, extra: Partial<T> = {}): T {
  return {
    id: brEvt(projectId, o.branch, o.seq),
    seq: o.seq,
    type,
    at: new Date(o.atMs).toISOString(),
    branch: o.branch,
    parentEventId: o.parent,
    rulesVersion: RULES_VERSION,
    ...extra,
  } as T;
}

function importEvent(
  projectId: string,
  branch: string,
  seq: number,
  parent: string | null,
  atMs: number,
  v: BuiltVariant,
  imageIdOverride?: string,
): GelEvent {
  const evt = base<GelEvent>(projectId, 'materials_imported', { seq, branch, parent, atMs });
  return {
    ...evt,
    imageId: imageIdOverride ?? v.image.id,
    ladderId: v.ladder.id,
    laneIds: v.lanes.map((l) => l.id),
    bandIds: v.bands.map((b) => b.id),
    inputDigest: v.digest,
    materials: [v.image, v.ladder, v.lanes, v.bands].flat(),
  } as GelEvent;
}

const T0 = Date.UTC(2026, 8, 23, 1, 0, 0);

export function buildBundle(): BuiltCase {
  const projectId = CASE_PROJECT_ID;
  const pixelByHash = new Map<string, { pixels: Uint8Array; width: number; height: number }>();
  const events: GelEvent[] = [];
  const branchHeads: Record<string, string> = {};
  const params0 = { ...DEFAULT_CALIB_PARAMS_V1 };

  const remember = (v: BuiltVariant, gel?: ReturnType<typeof renderGel>) => {
    if (gel) pixelByHash.set(v.image.pixelsSha256, { pixels: gel.pixels, width: gel.width, height: gel.height });
  };

  // ---------- 主分支：完整叙事 ----------
  const main = 'main';
  const baselineGel = renderGel(baselineSpec());
  const baseline = buildVariant(projectId, 'baseline', baselineSpec(), brEvt(projectId, 'main', 1), params0);
  remember(baseline, baselineGel);
  const e1 = importEvent(projectId, main, 1, null, T0, baseline);
  events.push(e1);

  // 参数修订（决定层；只记录变化字段）
  const e2 = base<GelEvent>(projectId, 'parameter_revised', {
    seq: 2,
    branch: main,
    parent: e1.id,
    atMs: T0 + 60_000,
  });
  events.push({
    ...e2,
    paramsVersion: 1,
    previousVersion: 0,
    patch: { resolutionWidth: 16 },
    reason: '审阅者认为该胶分辨宽度应放宽到 16px',
  } as GelEvent);

  // 只影响局部依赖的源数据改动：重曝（曝光是独立直接来源；几何/标称不变）
  const exposedSpec = baselineSpec({ gain: 1.35, seed: 1194 });
  const exposedGel = renderGel(exposedSpec);
  const exposed = buildVariant(projectId, 'exposed', exposedSpec, brEvt(projectId, 'main', 3), params0);
  remember(exposed, exposedGel);
  const e3 = importEvent(projectId, main, 3, e2.id, T0 + 120_000, exposed);
  events.push(e3);

  // 接受 lane1 第一个清晰自动候选
  const acceptTarget = exposed.bands.find((b) => b.laneId.endsWith('L1'))!.id;
  events.push({
    ...base<GelEvent>(projectId, 'decision', { seq: 4, branch: main, parent: e3.id, atMs: T0 + 180_000 }),
    kind: 'accept',
    targetSlotId: acceptTarget,
    acceptedMw: 0,
    reason: '自动候选落在单调局部标尺段，人工接受',
  } as GelEvent);

  // 互相冲突的人工决定：重叠 lane 上同一簇，两位审阅者给出互斥区间/单值
  const overlapBand = exposed.bands.find((b) => b.flag === 'overlap')!;
  events.push({
    ...base<GelEvent>(projectId, 'decision', { seq: 5, branch: main, parent: events[3].id, atMs: T0 + 240_000 }),
    kind: 'conflict',
    targetSlotId: overlapBand.id,
    reason: '重叠簇无法唯一决定，两位审阅者结论互斥，全部保留',
    conflicts: [
      { author: 'reviewer-A', kind: 'accept', mw: 0 },
      { author: 'reviewer-B', kind: 'interval', interval: [0, 0] },
    ],
  } as GelEvent);

  // 否定饱和 lane 的自动候选
  const satBand = exposed.bands.find((b) => b.flag === 'saturated')!;
  events.push({
    ...base<GelEvent>(projectId, 'decision', { seq: 6, branch: main, parent: events[4].id, atMs: T0 + 300_000 }),
    kind: 'reject',
    targetSlotId: satBand.id,
    reason: '饱和条带只能候选/区间，拒绝把自动候选作为唯一值',
  } as GelEvent);

  // 对拖尾条带采用区间决定
  const tailBand = exposed.bands.find((b) => b.flag === 'tailing')!;
  events.push({
    ...base<GelEvent>(projectId, 'decision', { seq: 7, branch: main, parent: events[5].id, atMs: T0 + 360_000 }),
    kind: 'interval',
    targetSlotId: tailBand.id,
    mwInterval: [0, 0],
    reason: '拖尾条带以区间采纳，不唯一化',
  } as GelEvent);
  branchHeads[main] = events[events.length - 1].id;

  // ---------- 七个分支：每个只改一个直接来源 ----------
  const branches: Array<{
    name: string;
    key: string;
    spec: GelSpec;
    opts?: { curved?: boolean; swapNominals?: boolean };
  }> = [
    { name: 'branch-missing', key: 'missing', spec: missingRungSpec() },
    { name: 'branch-saturated', key: 'sat', spec: baselineSpec() },
    { name: 'branch-overlap', key: 'overlap', spec: baselineSpec() },
    { name: 'branch-nonmono', key: 'nonmono', spec: baselineSpec(), opts: { swapNominals: true } },
    { name: 'branch-curved', key: 'curved', spec: baselineSpec({ bend: 46 }), opts: { curved: true } },
    { name: 'branch-exposure', key: 'exposure2', spec: baselineSpec({ gain: 1.35, seed: 1194 }) },
    { name: 'branch-rotation', key: 'rot0', spec: baselineSpec() },
  ];

  for (const br of branches) {
    const gel = renderGel(br.spec);
    const v = buildVariant(projectId, br.key, br.spec, brEvt(projectId, br.name, 1), params0, br.opts);
    remember(v, gel);
    const ev1 = importEvent(projectId, br.name, 1, e1.id, T0 + 420_000, v);
    events.push(ev1);

    if (br.name === 'branch-rotation') {
      // 旋转图像：新图材料 + 刚体重投影（MW 必须不变）
      const rotatedGel = rotateGray(gel, 90);
      const rotImg: ImageMaterial = {
        ...v.image,
        id: slotId('img', projectId, 'rot90'),
        width: rotatedGel.width,
        height: rotatedGel.height,
        pixelsSha256: sha256Hex(rotatedGel.pixels),
        orientation: {
          ...v.image.orientation,
          rotationDeg: 90,
          provenance: { source: 'human', eventId: '', note: '审阅者旋转 90° 核对方向' },
        },
        derivedFrom: { parentImageId: v.image.id, rotate: 90, flipH: false, flipV: false },
      };
      pixelByHash.set(rotImg.pixelsSha256, { pixels: rotatedGel.pixels, width: rotatedGel.width, height: rotatedGel.height });
      const warpBand = (b: BandObservation): BandObservation => ({
        ...b,
        center: rotPt(b.center, gel.width, gel.height, 90),
        cluster: b.cluster?.map((p) => rotPt(p, gel.width, gel.height, 90)),
        provenance: { ...b.provenance, source: 'derived-transform', note: '旋转刚体重投影' },
      });
      const warpLane = (l: LaneMaterial): LaneMaterial => ({
        ...l,
        centerline: l.centerline.map((p) => rotPt(p, gel.width, gel.height, 90)),
        leftBoundary: l.leftBoundary.map((p) => rotPt(p, gel.width, gel.height, 90)),
        rightBoundary: l.rightBoundary.map((p) => rotPt(p, gel.width, gel.height, 90)),
      });
      const ev2r = base<GelEvent>(projectId, 'image_rotated', {
        seq: 2,
        branch: br.name,
        parent: ev1.id,
        atMs: T0 + 480_000,
      });
      events.push({
        ...ev2r,
        sourceImageId: v.image.id,
        newImageId: rotImg.id,
        rotate: 90,
        refs: [{ materialId: v.image.id, kind: 'gel-image' }],
        materials: [
          rotImg,
          ...v.lanes.map(warpLane),
          ...v.bands.map(warpBand),
        ],
      } as GelEvent);
    }

    if (br.name === 'branch-curved') {
      // 修订后局部失效：调严 resolutionWidth，触发重叠簇重组 + 局部失效证据
      const evp = base<GelEvent>(projectId, 'parameter_revised', {
        seq: 2,
        branch: br.name,
        parent: ev1.id,
        atMs: T0 + 480_000,
      });
      events.push({
        ...evp,
        paramsVersion: 1,
        previousVersion: 0,
        patch: { resolutionWidth: 6 },
        reason: '微笑胶场景下调严分辨宽度，验证局部标尺与局部失效',
      } as GelEvent);
    }

    branchHeads[br.name] = events[events.length - 1].id;
  }

  const images: BundleV1['images'] = {};
  for (const [hash, entry] of pixelByHash) {
    images[hash] = {
      width: entry.width,
      height: entry.height,
      base64: Buffer.from(entry.pixels).toString('base64'),
    };
  }

  const bundle: BundleV1 = {
    format: 'gelbench-bundle',
    bundleVersion: 1,
    exportedAt: new Date(T0 + 600_000).toISOString(),
    project: { id: projectId, name: CASE_NAME, caseId: 'casepack-2026-09-23' },
    events,
    branchHeads,
    images,
  };
  return { bundle, pixelByHash };
}
function rotateGray(gel: ReturnType<typeof renderGel>, deg: 90) {
  const out = new Uint8Array(gel.width * gel.height);
  for (let y = 0; y < gel.height; y++) {
    for (let x = 0; x < gel.width; x++) {
      const nx = gel.height - 1 - y;
      const ny = x;
      out[ny * gel.height + nx] = gel.pixels[y * gel.width + x];
    }
  }
  return { pixels: out, width: gel.height, height: gel.width };
}

function rotPt(p: PixelPoint, w: number, h: number, deg: 90): PixelPoint {
  return { x: h - 1 - p.y, y: p.x, frame: 'image-rot90' };
}
