/**
 * 离线案例包：胶道标尺工作台专用合成凝胶。
 * 确定性生成（种子 PRNG），包含：原图像素、拍摄方向、曝光、ladder 标称值、
 * lane 边界/中心线、条带中心与轮廓——全部带像素级来源。
 * 内置一条饱和条带与一组重叠条带，供边界情形重放使用。
 */
import { contentId, sha256, canonical } from '../shared/ids.js';
import type { BandObject, GelImageObject, LaneObject, LadderObject, PixelBasis, PixelPoint } from '../shared/types.js';

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface BandSpec {
  lane: number;
  mwBp: number;
  saturated?: boolean;
  heightPx?: number;
  overlapGroup?: string;
}

export interface GelSpec {
  width: number;
  height: number;
  topY: number;
  bottomY: number;
  laneX: number[];
  ladderLane: number;
  smileAmp: number; // 微笑弯曲强度（中间泳道迁移延伸比例）
  bendAmp: number;  // 泳道横向弯曲幅度 px
  ladderMwBp: number[];
  bands: BandSpec[];
  exposureMs: number;
  seed: number;
}

export const BASE_SPEC: GelSpec = {
  width: 360,
  height: 300,
  topY: 28,
  bottomY: 272,
  laneX: [46, 106, 166, 226, 286],
  ladderLane: 0,
  smileAmp: 0.1,
  bendAmp: 2,
  ladderMwBp: [10000, 7000, 5000, 4000, 3000, 2000, 1500, 1000, 700, 500],
  bands: [
    { lane: 1, mwBp: 6000 },
    { lane: 1, mwBp: 3000 },
    { lane: 1, mwBp: 1200 },
    { lane: 2, mwBp: 4500 },
    { lane: 2, mwBp: 2000, saturated: true, heightPx: 12 },
    { lane: 2, mwBp: 900 },
    { lane: 3, mwBp: 5200 },
    { lane: 3, mwBp: 2600, overlapGroup: 'og1' },
    { lane: 3, mwBp: 2450, overlapGroup: 'og1' },
    { lane: 3, mwBp: 800 },
    { lane: 4, mwBp: 7000 },
    { lane: 4, mwBp: 1500 }
  ],
  exposureMs: 120,
  seed: 20260919
};

export function migrationOfMw(mwBp: number, spec: GelSpec): number {
  const maxM = spec.bottomY - spec.topY - 14;
  const k = maxM / (Math.log10(spec.ladderMwBp[0]) - Math.log10(spec.ladderMwBp[spec.ladderMwBp.length - 1]));
  return k * (Math.log10(spec.ladderMwBp[0]) - Math.log10(mwBp));
}

export function smileAt(x: number, spec: GelSpec): number {
  const cx = spec.width / 2;
  const half = spec.width / 2;
  const u = (x - cx) / half;
  return spec.smileAmp * (1 - u * u);
}

/** 泳道中心线：t∈[0,1] -> 像素点；长度随微笑系数拉伸。 */
export function laneCenterline(laneIndex: number, spec: GelSpec, basis: PixelBasis = 'image-raw'): PixelPoint[] {
  const x0 = spec.laneX[laneIndex];
  const smile = smileAt(x0, spec);
  const pts: PixelPoint[] = [];
  const n = 24;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const y = spec.topY + t * (spec.bottomY - spec.topY) * (1 + smile);
    const x = x0 + spec.bendAmp * Math.sin(Math.PI * t);
    pts.push({ x: round2(x), y: round2(y), basis });
  }
  return pts;
}

export function bandPosition(laneIndex: number, mwBp: number, spec: GelSpec): { x: number; y: number } {
  const m = migrationOfMw(mwBp, spec);
  const x0 = spec.laneX[laneIndex];
  const smile = smileAt(x0, spec);
  const t = m / (spec.bottomY - spec.topY);
  const y = spec.topY + m * (1 + smile);
  const x = x0 + spec.bendAmp * Math.sin(Math.PI * t);
  return { x: round2(x), y: round2(y) };
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

export interface GeneratedGel {
  image: { width: number; height: number; pixels: Uint8Array };
  lanes: LaneObject[];
  ladder: LadderObject;
  bands: BandObject[];
}

function shiftLine(line: PixelPoint[], dx: number): PixelPoint[] {
  return line.map((p) => ({ ...p, x: round2(p.x + dx) }));
}

function contourOf(cx: number, cy: number, rx: number, ry: number, basis: PixelBasis): PixelPoint[] {
  const pts: PixelPoint[] = [];
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2;
    pts.push({ x: round2(cx + rx * Math.cos(a)), y: round2(cy + ry * Math.sin(a)), basis });
  }
  return pts;
}

/** 生成材料对象（不含事件，事件由播种方创建以提供来源 id）。 */
export function generateGel(spec: GelSpec, sourceEventId: string): GeneratedGel {
  const rand = mulberry32(spec.seed);
  const { width, height } = spec;
  const img = new Float64Array(width * height);
  for (let i = 0; i < img.length; i++) img[i] = 14 + rand() * 8;

  const lanes: LaneObject[] = spec.laneX.map((x, i) => {
    const centerline = laneCenterline(i, spec);
    const id = contentId('lane', { spec: spec.seed, lane: i, smile: spec.smileAmp, bend: spec.bendAmp });
    return {
      kind: 'lane' as const,
      id,
      hash: '',
      index: i,
      role: i === spec.ladderLane ? ('ladder' as const) : ('sample' as const),
      centerline,
      leftEdge: shiftLine(centerline, -11),
      rightEdge: shiftLine(centerline, 11),
      source: { sourceEventId, note: `lane ${i} 边界由像素列剖面确定` }
    };
  });
  for (const l of lanes) l.hash = sha256(canonical({ ...l, hash: '' }));

  const ladderLaneId = lanes[spec.ladderLane].id;
  const ladderPoints = spec.ladderMwBp.map((mw, i) => {
    const pos = bandPosition(spec.ladderLane, mw, spec);
    return {
      id: contentId('ldp', { spec: spec.seed, mw, smile: spec.smileAmp, bend: spec.bendAmp }),
      mwBp: mw,
      center: { x: pos.x, y: pos.y, basis: 'image-raw' as const },
      source: { sourceEventId, note: `ladder 第 ${i + 1} 条带中心` }
    };
  });
  const ladder: LadderObject = {
    kind: 'ladder',
    id: contentId('ladder', { spec: spec.seed, mw: spec.ladderMwBp, smile: spec.smileAmp, bend: spec.bendAmp }),
    hash: '',
    laneId: ladderLaneId,
    points: ladderPoints
  };
  ladder.hash = sha256(canonical({ ...ladder, hash: '' }));

  const bands: BandObject[] = spec.bands.map((b) => {
    const pos = bandPosition(b.lane, b.mwBp, spec);
    const heightPx = b.heightPx ?? 6;
    const band: BandObject = {
      kind: 'band',
      id: contentId('band', { spec: spec.seed, lane: b.lane, mw: b.mwBp, smile: spec.smileAmp, bend: spec.bendAmp }),
      hash: '',
      laneId: lanes[b.lane].id,
      center: { x: pos.x, y: pos.y, basis: 'image-raw' },
      contour: contourOf(pos.x, pos.y, 9, heightPx / 2 + 2, 'image-raw'),
      heightPx,
      peakIntensity: b.saturated ? 255 : 170,
      saturated: b.saturated ?? false,
      overlapGroupId: b.overlapGroup ?? null,
      origin: 'auto',
      source: { sourceEventId, note: `lane ${b.lane} 自动候选条带` }
    };
    band.hash = sha256(canonical({ ...band, hash: '' }));
    // 渲染到图像
    const amp = b.saturated ? 430 : 175;
    const sx = 6.5;
    const sy = heightPx / 2.4;
    for (let yy = Math.max(0, Math.floor(pos.y - 14)); yy < Math.min(height, Math.ceil(pos.y + 14)); yy++) {
      for (let xx = Math.max(0, Math.floor(pos.x - 20)); xx < Math.min(width, Math.ceil(pos.x + 20)); xx++) {
        const dx = (xx - pos.x) / sx;
        const dy = (yy - pos.y) / sy;
        img[yy * width + xx] += amp * Math.exp(-(dx * dx + dy * dy));
      }
    }
    return band;
  });

  const pixels = new Uint8Array(width * height);
  for (let i = 0; i < img.length; i++) pixels[i] = Math.max(0, Math.min(255, Math.round(img[i])));

  return { image: { width, height, pixels }, lanes, ladder, bands };
}

export function imageObjectOf(g: GeneratedGel, spec: GelSpec, orientationDeg: 0 | 90 | 180 | 270 = 0): GelImageObject {
  const pixelsB64 = Buffer.from(g.image.pixels).toString('base64');
  const obj: GelImageObject = {
    kind: 'gel-image',
    id: contentId('img', { spec: spec.seed, orientationDeg }),
    hash: '',
    width: g.image.width,
    height: g.image.height,
    pixelsB64,
    orientationDeg,
    exposureMs: spec.exposureMs,
    captureNote: `合成凝胶案例包 seed=${spec.seed}，灰度 8bit，曝光 ${spec.exposureMs} ms`
  };
  obj.hash = sha256(canonical({ ...obj, hash: '' }));
  return obj;
}
