/**
 * 从合成凝胶构建不可变材料层。
 * 原图、拍摄方向、曝光、ladder 标称值、lane 边界、band 中心分别成材料，
 * 每个几何量都保留像素坐标与 provenance（auto-candidate / manual-revision）。
 */
import {
  DNA_LADDER_BP,
  decodeGray,
  encodeGray,
  generateGel,
  laneCurvePoints,
  rotateGray,
  type GelImageSpec,
} from './synthetic-gel.js';
import { projectToCurve } from './geometry.js';
import { materialId, shortHash } from './ids.js';
import type {
  BandCentersMaterial,
  BandCenter,
  CalibrationParams,
  ExposureMaterial,
  ImmutableMaterial,
  LadderNominal,
  LadderNominalsMaterial,
  LaneBoundariesMaterial,
  OrientationMaterial,
  RawImageMaterial,
} from '../shared/types.js';

export interface GelBundle {
  width: number;
  height: number;
  grayBase64: string;
  spec: GelImageSpec;
  truth: ReturnType<typeof generateGel>['truth'];
}

export interface MaterialBuildOptions {
  capturedAt: string;
  origin: string;
  /** 拍摄方向：顺时针旋转。给定后，原图即旋转后像素，拍摄方向材料记录该来源。 */
  rotationDeg?: 0 | 90 | 180 | 270;
  exposureMs?: number;
  saturationGray?: number;
  /** ladder 缺带 ordinal（自 well 0 起）：从图像像素层移除该带。 */
  missingLadderOrdinals?: number[];
  /** 非单调标尺：交换两个 ladder 标称 ordinal 的名义分子量（仅改标称来源）。 */
  swapNominalOrdinals?: [number, number];
  /** 人工修订 band 像素中心。 key `${laneId}:${label}` -> {x,y} */
  manualBandOverrides?: Record<string, { x: number; y: number }>;
  /** 人工修订 lane 微笑曲率。 */
  manualLaneSmile?: Record<string, number>;
  /** 人工修订：删除/新增样品 band（像素来源标记 manual）。 */
  extraSampleBands?: Array<{ laneId: string; s: number; amp: number; label: string; saturated?: boolean; tail?: boolean; overlapGroup?: string }>;
  derivedFromEventId: string;
}

/** 生成（可选缺带/旋转的）凝胶像素与真值。 */
export function buildGelBundle(baseSpec: GelImageSpec, opts: MaterialBuildOptions): GelBundle {
  const missing = new Set(opts.missingLadderOrdinals ?? []);
  const spec: GelImageSpec = {
    ...baseSpec,
    lanes: baseSpec.lanes.map((lane) => {
      if (lane.role !== 'ladder') {
        return { ...lane, bands: [...lane.bands, ...(opts.extraSampleBands?.filter((b) => b.laneId === lane.laneId) ?? [])] };
      }
      return { ...lane, bands: lane.bands.filter((_, ordinal) => !missing.has(ordinal)) };
    }),
  };
  const gel = generateGel(spec);
  let width = gel.width;
  let height = gel.height;
  let gray = gel.gray;
  let truth = gel.truth.map((t) => ({ ...t, center: { ...t.center } }));

  const rotation = opts.rotationDeg ?? 0;
  if (rotation !== 0) {
    const r = rotateGray(gray, width, height, rotation as 90 | 180 | 270);
    const remap = (x: number, y: number) => {
      if (rotation === 90) return { x: height - 1 - y, y: x };
      if (rotation === 180) return { x: width - 1 - x, y: height - 1 - y };
      return { x: y, y: width - 1 - x }; // 270
    };
    truth = truth.map((t) => {
      const q = remap(t.center.x, t.center.y);
      return { ...t, center: { ...t.center, x: q.x, y: q.y } };
    });
    gray = r.gray;
    width = r.width;
    height = r.height;
  }

  return { width, height, grayBase64: encodeGray(gray), spec, truth };
}

export function defaultParams(version = 'params-v1'): CalibrationParams {
  return {
    paramVersion: version,
    model: 'piecewise-log-linear',
    minLadderPoints: 3,
    extrapolationFraction: 0.05,
    localArcRuler: true,
    forceIntervalForAmbiguity: true,
    maxArcSamples: 200_000,
  };
}

function makeRawImage(bundle: GelBundle, opts: MaterialBuildOptions): RawImageMaterial {
  return {
    id: materialId('raw-image', { w: bundle.width, h: bundle.height, sha: shortHash(bundle.grayBase64, 48) }),
    type: 'raw-image',
    width: bundle.width,
    height: bundle.height,
    channels: 1,
    grayBase64: bundle.grayBase64,
    bitDepth: 8,
    capturedAt: opts.capturedAt,
    origin: opts.origin,
    sha256: shortHash(bundle.grayBase64, 64),
  };
}

/** 由凝胶 + 选项构建六种不可变材料。 */
export function buildMaterials(bundle: GelBundle, opts: MaterialBuildOptions): ImmutableMaterial[] {
  const { width, height } = bundle;
  const image = makeRawImage(bundle, opts);
  const rotationDeg = opts.rotationDeg ?? 0;

  const orientation: OrientationMaterial = {
    id: materialId('orientation', { image: image.id, rotationDeg, flip: 'none' }),
    type: 'orientation',
    rotationDeg: { value: rotationDeg, unit: 'degree', raw: `${rotationDeg}° clockwise` },
    flip: 'none',
    appliesToImageId: image.id,
    rawNotation: `rotation=${rotationDeg}`,
  };

  const exposure: ExposureMaterial = {
    id: materialId('exposure', { image: image.id, ms: opts.exposureMs ?? 80, sat: opts.saturationGray ?? 235 }),
    type: 'exposure',
    exposureMs: { value: opts.exposureMs ?? 80, unit: 'ms', raw: `${opts.exposureMs ?? 80} ms` },
    saturationGray: { value: opts.saturationGray ?? 235, unit: 'gray', raw: `sat ${opts.saturationGray ?? 235}` },
    gain: 1.0,
    appliesToImageId: image.id,
    rawNotation: `${opts.exposureMs ?? 80} ms; sat ${opts.saturationGray ?? 235}`,
  };

  const coordSystem = `original-image:${image.id}`;
  const swap = opts.swapNominalOrdinals ?? null;

  let nominalBands: LadderNominal[] = DNA_LADDER_BP.map((bp, ordinal) => ({
    ordinal,
    nominal: { value: bp, unit: 'bp', raw: `${bp}bp` },
    raw: `${bp}bp`,
  }));
  if (swap) {
    nominalBands = nominalBands.map((b) => ({ ...b, nominal: { ...b.nominal }, }));
    const [i, j] = swap;
    const ni = nominalBands[i].nominal;
    nominalBands[i] = { ...nominalBands[i], nominal: { ...nominalBands[j].nominal }, raw: nominalBands[j].raw };
    nominalBands[j] = { ...nominalBands[j], nominal: { ...ni }, raw: ni.raw ?? `${ni.value}bp` };
  }
  const ladderNominals: LadderNominalsMaterial = {
    id: materialId('ladder-nominals', { bp: nominalBands.map((b) => b.nominal.value), molecule: 'dna' }),
    type: 'ladder-nominals',
    ladderLaneId: 'L0',
    molecule: 'dna',
    bands: nominalBands,
    orderedFromBottom: false,
    rawNotation: nominalBands.map((b) => b.raw).join(','),
  };

  // lane 曲线（旋转时坐标系随新图像：x/y 需重映射；微笑以 y 偏移表达，旋转后偏移轴变化由 truth 体现，
  // 此处 lane 曲线在“拍摄方向校正前的原始像素”里构建，以保留像素级来源）。
  const yWell = 24;
  const yEnd = (rotation === 90 || rotation === 270 ? bundle.width : height) - 0; // 未旋转时使用
  // 直接以每泳道 band 的 x 分布确定 lane xCenter（真值），并用微笑曲率重建曲线后旋转。
  const laneEntries = bundle.spec.lanes.map((lane) => {
    const smile = opts.manualLaneSmile?.[lane.laneId] ?? lane.smile;
    let points = laneCurvePoints(lane.xCenter, smile, yWell, bundle.spec.height - 16, coordSystem);
    if (rotationDeg !== 0) {
      const ow = bundle.spec.width;
      const oh = bundle.spec.height;
      points = points.map((p) => {
        let q = { x: p.x, y: p.y };
        if (rotationDeg === 90) q = { x: oh - 1 - p.y, y: p.x };
        else if (rotationDeg === 180) q = { x: ow - 1 - p.x, y: oh - 1 - p.y };
        else q = { x: p.y, y: ow - 1 - p.x };
        return { ...p, x: q.x, y: q.y };
      });
    }
    const manual = Boolean(opts.manualLaneSmile && lane.laneId in opts.manualLaneSmile);
    return {
      laneId: lane.laneId,
      role: lane.role,
      label: lane.label,
      curve: { points, halfWidth: 16, kind: (smile !== 0 ? 'smile' : 'straight') as 'straight' | 'smile', curvature: smile },
      provenance: {
        source: (manual ? 'manual-revision' : 'auto-candidate') as 'manual-revision' | 'auto-candidate',
        seedPoints: [points[0], points[Math.floor(points.length / 2)], points[points.length - 1]],
        derivedFromEventId: opts.derivedFromEventId,
      },
    };
  });
  const laneBoundaries: LaneBoundariesMaterial = {
    id: materialId('lane-boundaries', { lanes: laneEntries.map((l) => ({ id: l.laneId, c: l.curve })) }),
    type: 'lane-boundaries',
    coordinateSystem: coordSystem,
    lanes: laneEntries,
  };

  // band 中心：以像素真值投影到对应 lane 曲线，保留像素证据。
  const gray = decodeGray(bundle.grayBase64);
  const bands: BandCenter[] = [];
  const missing = new Set(opts.missingLadderOrdinals ?? []);
  for (const truth of bundle.truth) {
    const specLane = bundle.spec.lanes.find((l) => l.laneId === truth.laneId)!;
    if (specLane.role === 'ladder') {
      const ordinal = DNA_LADDER_BP.indexOf(parseInt(truth.label ?? '0', 10));
      if (ordinal >= 0 && missing.has(ordinal)) continue;
    }
    const entry = laneEntries.find((l) => l.laneId === truth.laneId)!;
    const specBand = specLane.bands.find((b) => b.label === truth.label)!;
    let cx = truth.center.x;
    let cy = truth.center.y;
    const override = opts.manualBandOverrides?.[`${truth.laneId}:${truth.label}`];
    const manual = Boolean(override) || Boolean(specBand.overlapGroup);
    if (override) {
      cx = override.x;
      cy = override.y;
    }
    const proj = projectToCurve(entry.curve.points, { x: cx, y: cy });
    const sat = exposure.saturationGray.value;
    const x0 = Math.max(0, Math.round(cx - specBand.sigmaX * 2));
    const x1 = Math.min(bundle.width - 1, Math.round(cx + specBand.sigmaX * 2));
    const y0 = Math.max(0, Math.round(cy - specBand.sigmaY * 2));
    const y1 = Math.min(bundle.height - 1, Math.round(cy + specBand.sigmaY * (specBand.tail ? 6 : 2)));
    let integrated = 0;
    let saturatedPixels = 0;
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const v = gray[y * bundle.width + x] ?? 0;
      integrated += Math.max(0, v - 28);
      if (v >= sat) saturatedPixels++;
    }
    bands.push({
      bandId: `B-${truth.laneId}-${truth.label}`,
      laneId: truth.laneId,
      center: { x: cx, y: cy, unit: 'pixel', coordinateSystem: coordSystem },
      arcLength: { value: proj.s, unit: 'pixel' },
      integrated: { value: integrated, unit: 'px^2' },
      peakGray: { value: gray[Math.round(cy) * bundle.width + Math.round(cx)] ?? 0, unit: 'gray' },
      evidence: {
        saturatedPixels,
        tailing: Boolean(specBand.tail),
        overlapGroupId: specBand.overlapGroup ?? null,
        roi: { x0, y0, x1, y1, unit: 'pixel' },
      },
      provenance: {
        source: manual ? 'manual-revision' : 'auto-candidate',
        derivedFromEventId: opts.derivedFromEventId,
      },
    });
  }
  const bandCenters: BandCentersMaterial = {
    id: materialId('band-centers', { bands: bands.map((b) => ({ id: b.bandId, c: b.center, a: b.arcLength.value })) }),
    type: 'band-centers',
    coordinateSystem: coordSystem,
    bands,
  };

  return [image, orientation, exposure, ladderNominals, laneBoundaries, bandCenters];
}
