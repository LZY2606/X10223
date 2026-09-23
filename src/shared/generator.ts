import { contentId } from './hash.js';
import { createRaster, encodePng, paintBand, rotateRasterCW, type Raster } from './image.js';
import type {
  CaptureMetadataMaterial,
  ImageMaterial,
  LaneAnnotationMaterial,
  LadderSpecMaterial,
  Material,
  PixelPoint,
  PixelProvenance,
} from './types.js';
import { parseDurationMs, parseOrientation, parseQuantity } from './units.js';

/** 合成凝胶场景：领域专用离线案例，非通用表格。 */
export interface GelScenario {
  key: string;
  title: string;
  width: number;
  height: number;
  laneCount: number;
  marginTop: number;
  marginBottom: number;
  rotateCW?: 0 | 90 | 180 | 270;
  /** 微笑幅度：外侧泳道在 f=0.5 处相对直线额外向下弯 px。 */
  smilePx?: number;
  bands: ScenarioBand[];
  exposureRaw: string;
  orientationRaw: string;
  runDurationRaw: string;
  ladderBp: number[]; // 从大到小
  omitLadderBandOrdinal?: number; // 缺带：ladder 第几个标称（1=最大）在图上不画
  ladderLane?: string;
  /** 让 ladder 标称值非单调（制造语义无解）。 */
  scrambleLadder?: boolean;
}

export interface ScenarioBand {
  lane: number; // 1-based
  rank: number; // 沿迁移方向 1-based（rank1 最大/最靠上）
  f: number; // 设计迁移分数 0..1（正向图坐标系）
  darkness?: number;
  plateau?: number; // >0 画饱和平台
  tail?: boolean;
  overlapKey?: string; // 同 key 的两条带刻意画近
}

export interface GeneratedBundle {
  frameId: string;
  materials: Material[];
  png: Uint8Array;
  raster: Raster; // 最终（可能已旋转）图
  uprightRaster: Raster; // 正向图
  scenario: GelScenario;
  laneLength: number;
}

export const LADDER_LANE = 'L1';

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function laneX(scenario: GelScenario, laneOrdinal: number): number {
  const usable = scenario.width - 40;
  const step = usable / scenario.laneCount;
  return Math.round(20 + step * (laneOrdinal - 0.5));
}

/**
 * 弯曲中心线：x(f) 在中点横向偏移（微笑时外侧泳道），y 随 f 单调。
 * 条带画在中心线上，保证弧长分数 = 迁移分数 f；
 * 但同一全局 y 处不同泳道的弧长分数不同（微笑核心）。
 */
export function centerlineFor(scenario: GelScenario, laneOrdinal: number): PixelPoint[] {
  const x0 = laneX(scenario, laneOrdinal);
  const top = scenario.marginTop;
  const bottom = scenario.height - scenario.marginBottom;
  const span = (scenario.laneCount - 1) / 2 || 1;
  const side = Math.abs(laneOrdinal - 1 - (scenario.laneCount - 1) / 2) / span;
  const amp = (scenario.smilePx ?? 0) * side;
  const pts: PixelPoint[] = [];
  const N = 60;
  for (let i = 0; i <= N; i++) {
    const f = i / N;
    const y = top + (bottom - top) * f;
    const x = x0 + amp * 4 * f * (1 - f);
    pts.push({ x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10 });
  }
  return pts;
}

function laneBoundaries(center: PixelPoint[], halfWidth: number): { left: PixelPoint[]; right: PixelPoint[] } {
  const left: PixelPoint[] = [];
  const right: PixelPoint[] = [];
  for (let i = 0; i < center.length; i++) {
    const p = center[i];
    const a = center[Math.max(0, i - 1)];
    const b = center[Math.min(center.length - 1, i + 1)];
    let tx = b.x - a.x;
    let ty = b.y - a.y;
    const len = Math.hypot(tx, ty) || 1;
    tx /= len;
    ty /= len;
    const nx = -ty;
    const ny = tx;
    left.push({ x: Math.round((p.x + nx * halfWidth) * 10) / 10, y: Math.round((p.y + ny * halfWidth) * 10) / 10 });
    right.push({ x: Math.round((p.x - nx * halfWidth) * 10) / 10, y: Math.round((p.y - ny * halfWidth) * 10) / 10 });
  }
  return { left, right };
}

/** 生成一整块案例材料：原图(PNG字节) + 拍摄方向/曝光 + ladder标称 + lane边界（无条带标注，检测自动产出）。 */
export function generateGel(scenario: GelScenario, seed = 42): GeneratedBundle {
  const frameId = `frame_${scenario.key}`;
  const rand = rng(seed + hashStr(scenario.key));
  const raster = createRaster(scenario.width, scenario.height, [242, 242, 236, 255]);

  // 胶片颗粒噪声（确定性）。
  for (let i = 0; i < scenario.width * scenario.height; i++) {
    const n = (rand() - 0.5) * 6;
    const o = i * 4;
    raster.data[o] = clamp255(raster.data[o] + n);
    raster.data[o + 1] = clamp255(raster.data[o + 1] + n);
    raster.data[o + 2] = clamp255(raster.data[o + 2] + n);
  }

  // ladder 条带：rank r → f 均匀分布在 [0.12, 0.88]。
  const ladderFs = scenario.ladderBp.map((_, i) => 0.12 + (0.76 * i) / (scenario.ladderBp.length - 1));
  const ladderCenter = centerlineFor(scenario, 1);
  scenario.ladderBp.forEach((_, i) => {
    if (scenario.omitLadderBandOrdinal === i + 1) return;
    const f = ladderFs[i];
    const p = pointAtF(ladderCenter, f);
    paintBand(raster, p.x, p.y, 7, 2.6, 150);
  });

  // 样品条带。
  for (const band of scenario.bands) {
    const center = centerlineFor(scenario, band.lane);
    const p = pointAtF(center, band.f);
    const darkness = band.darkness ?? 150;
    if (band.overlapKey) {
      // 同组第二条画在 4px 之外，制造重叠双峰。
      paintBand(raster, p.x + (band.rank % 2 === 0 ? 3.2 : -3.2), p.y, 7, 2.4, darkness);
    } else if (band.plateau) {
      paintBand(raster, p.x, p.y, 8, 2.8, 235, { plateau: band.plateau });
    } else if (band.tail) {
      paintBand(raster, p.x, p.y, 7, 2.6, darkness, { tailSide: 1 });
    } else {
      paintBand(raster, p.x, p.y, 7, 2.6, darkness);
    }
  }

  const upright = raster;
  const rotation = scenario.rotateCW ?? 0;
  const finalRaster = rotation ? rotateRasterCW(upright, rotation) : upright;
  const png = encodePng(finalRaster);

  const imageId = contentId('mat_img', { key: scenario.key, w: finalRaster.width, h: finalRaster.height, bytes: png.length });
  const blobId = contentId('blob', png);

  const materials: Material[] = [];
  const image: ImageMaterial = {
    id: imageId,
    kind: 'image',
    blobId,
    mediaType: 'image/png',
    width: finalRaster.width,
    height: finalRaster.height,
    channels: 4,
    importedAt: '2026-01-15T09:30:00.000Z',
    rawRepresentation: { fileName: `${scenario.key}.png`, byteLength: png.length },
  };
  materials.push(image);

  const orient = parseOrientation(scenario.orientationRaw, '/capture/orientationDegRaw');
  const exposure = parseDurationMs(scenario.exposureRaw, '/capture/exposure');
  const runDuration = parseDurationMs(scenario.runDurationRaw, '/capture/runDuration');
  const capture: CaptureMetadataMaterial = {
    id: contentId('mat_cap', { image: imageId, orientation: scenario.orientationRaw, exposure: scenario.exposureRaw }),
    kind: 'capture_metadata',
    imageId,
    orientationDegRaw: scenario.orientationRaw,
    orientationDeg: orient.deg,
    exposure,
    runDuration,
    diagnostics: [orient.diagnostic, exposure.diagnostic, runDuration.diagnostic].filter(Boolean) as never,
    rawRepresentation: {
      orientation: scenario.orientationRaw,
      exposure: scenario.exposureRaw,
      runDuration: scenario.runDurationRaw,
      imager: 'GelDoc-XR (synthetic)',
    },
  };
  materials.push(capture);

  const bpList = scenario.scrambleLadder
    ? scenario.ladderBp.map((v, i) => (i === 2 ? scenario.ladderBp[1] : v))
    : scenario.ladderBp;
  const ladder: LadderSpecMaterial = {
    id: contentId('mat_ladder', { key: scenario.key, bp: bpList }),
    kind: 'ladder_spec',
    ladderLaneRef: scenario.ladderLane ?? LADDER_LANE,
    unit: 'bp',
    entries: bpList.map((bp, i) => ({
      ordinal: i + 1,
      label: parseQuantity(`${bp} bp`, `/ladder/entries/${i}/label`, ['bp']),
      expectedRank: i + 1,
    })),
    rawRepresentation: { vendor: 'synthetic 1kb-style mix', values: bpList.map((b) => `${b} bp`) },
  };
  materials.push(ladder);

  const halfWidth = Math.max(5, Math.floor((laneX(scenario, 2) - laneX(scenario, 1)) / 2) - 3);
  const lanes = Array.from({ length: scenario.laneCount }, (_, i) => {
    const ordinal = i + 1;
    const center = centerlineFor(scenario, ordinal);
    const b = laneBoundaries(center, halfWidth);
    const prov: PixelProvenance = {
      frameId,
      materialId: 'synthetic',
      polyline: center.slice(0, 5),
      method: 'imported',
      note: `合成 lane ${ordinal} 几何（${center.length} 个折线点，像素坐标）`,
    };
    return {
      laneRef: `L${ordinal}`,
      role: ordinal === 1 ? ('ladder' as const) : ('sample' as const),
      centerline: center,
      leftBoundary: b.left,
      rightBoundary: b.right,
      provenance: [prov],
    };
  });
  const laneMat: LaneAnnotationMaterial = {
    id: contentId('mat_lanes', { key: scenario.key, count: scenario.laneCount, smile: scenario.smilePx ?? 0 }),
    kind: 'lane_annotation',
    imageId,
    frameId,
    lanes,
    rawRepresentation: { source: 'synthetic geometry', coordinateFrame: 'pixel(0,0)=top-left' },
  };
  materials.push(laneMat);

  return {
    frameId,
    materials,
    png,
    raster: finalRaster,
    uprightRaster: upright,
    scenario,
    laneLength: Math.hypot(1, (scenario.height - scenario.marginTop - scenario.marginBottom) / 60) * 60,
  };
}

function pointAtF(centerline: PixelPoint[], f: number): PixelPoint {
  const i = Math.round(f * (centerline.length - 1));
  return centerline[Math.max(0, Math.min(centerline.length - 1, i))];
}

function clamp255(v: number): number {
  return Math.max(0, Math.min(255, Math.round(v)));
}

function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** 设计真值：ladder bp → 该场景 ladder 泳道分数，便于生成已知分子量样品带。 */
export function ladderFractionTable(scenario: GelScenario): { bp: number; f: number }[] {
  return scenario.ladderBp.map((bp, i) => ({ bp, f: 0.12 + (0.76 * i) / (scenario.ladderBp.length - 1) }));
}

/** 由目标 bp 反推设计 f（log 线性）。 */
export function fForBp(bp: number, scenario: GelScenario): number {
  const tab = ladderFractionTable(scenario);
  const logs = tab.map((t) => Math.log10(t.bp));
  const target = Math.log10(bp);
  for (let i = 0; i < logs.length - 1; i++) {
    if (target <= logs[i] && target >= logs[i + 1]) {
      const t = (target - logs[i]) / (logs[i + 1] - logs[i]);
      return tab[i].f + t * (tab[i + 1].f - tab[i].f);
    }
  }
  return tab[tab.length - 1].f;
}
