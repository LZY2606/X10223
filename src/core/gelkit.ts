/**
 * 离线领域案例材料生成器：确定性合成原始凝胶图像（像素级来源可追溯）。
 * 不使用通用表格——所有 lane 曲线、ladder 点、band 中心都对应实际渲染的像素。
 */
import type { Band, GelImage, ImageVariant, LadderBandNominal, Lane, OrientationDeg, Point } from './types.ts';
import { encodePng } from '../platform/png.ts';
import { sha256Bytes } from './ids.ts';

export const GEL_W = 240;
export const GEL_H = 300;

export interface LadderSpec {
  y: number;
  nominal: number;
  id: string;
  missing?: boolean;
}

export interface SampleBandSpec {
  id: string;
  laneLabel: string;
  y: number;
  status?: Band['status'];
  peak?: number;
  interval?: { start: number; end: number };
  /** 重叠时给出实际渲染的次峰 y。 */
  altY?: number;
}

export interface GelBlueprint {
  variant: ImageVariant;
  orientation: OrientationDeg;
  laneLabels: string[];
  ladderX: number;
  sampleXs: number[];
  curveAmp: number; // 微笑弯曲幅度（像素），0 为直泳道
  ladder: LadderSpec[];
  samples: SampleBandSpec[];
  exposureMs: number;
  sensorBits: number;
  saturationLevel: number;
  smears: { laneX: number; startY: number; endY: number; peak: number }[];
}

export const LADDER_NOMINALS = [
  { y: 30, nominal: 1500 },
  { y: 60, nominal: 1000 },
  { y: 90, nominal: 750 },
  { y: 125, nominal: 500 },
  { y: 160, nominal: 300 },
  { y: 200, nominal: 200 },
  { y: 245, nominal: 100 },
];

function curvePoints(x: number, amp: number): Point[] {
  if (amp === 0) {
    return [
      { x, y: 20, unit: 'px' },
      { x, y: 280, unit: 'px' },
    ];
  }
  // 微笑：中部向迁移方向（下）凸出；x 方向控制点偏移形成弧线
  return [
    { x, y: 20, unit: 'px' },
    { x: x + amp, y: 150, unit: 'px' },
    { x, y: 280, unit: 'px' },
  ];
}

function quadAt(p0: Point, pc: Point | undefined, p2: Point, t: number): Point {
  if (!pc) return { x: p0.x + (p2.x - p0.x) * t, y: p0.y + (p2.y - p0.y) * t, unit: 'px' };
  const u = 1 - t;
  return {
    x: u * u * p0.x + 2 * u * t * pc.x + t * t * p2.x,
    y: u * u * p0.y + 2 * u * t * pc.y + t * t * p2.y,
    unit: 'px',
  };
}

function xAtY(curve: Point[], y: number): number {
  const [p0, pc, p2] = curve.length === 3 ? curve : [curve[0], undefined, curve[1]];
  // 二分求 y(t)=y 的 t（曲线对 y 单调）
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (quadAt(p0, pc, p2, mid).y < y) lo = mid;
    else hi = mid;
  }
  return quadAt(p0, pc, p2, (lo + hi) / 2).x;
}

export function renderGel(bp: GelBlueprint): { raster: Buffer; width: number; height: number; points: Map<string, Point> } {
  const width = GEL_W;
  const height = GEL_H;
  const raster = Buffer.alloc(width * height, 228); // 凝胶底色（亮）
  const laneXs = [bp.ladderX, ...bp.sampleXs];
  const curves = laneXs.map((x) => curvePoints(x, bp.curveAmp));

  // 轻微背景噪声（确定性）
  let seed = 1234;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  for (let i = 0; i < raster.length; i++) raster[i] = Math.max(210, Math.min(238, raster[i] + Math.floor((rand() - 0.5) * 10)));

  const points = new Map<string, Point>();
  const putBand = (laneIdx: number, y: number, sigma: number, peak: number, key?: string) => {
    const curve = curves[laneIdx];
    const cx = xAtY(curve, y);
    if (key) points.set(key, { x: cx, y, unit: 'px' });
    const half = Math.ceil(sigma * 3);
    for (let yy = Math.max(0, y - half); yy <= Math.min(height - 1, y + half); yy++) {
      const xc = xAtY(curve, yy);
      for (let xx = Math.max(0, Math.floor(xc - half)); xx <= Math.min(width - 1, xc + half); xx++) {
        const d2 = (xx - xc) ** 2 + (yy - y) ** 2;
        const v = peak * Math.exp(-d2 / (2 * sigma * sigma));
        const idx = yy * width + xx;
        raster[idx] = Math.max(0, Math.min(255, raster[idx] - Math.round(v * 255)));
      }
    }
  };

  // ladder 带
  bp.ladder.forEach((s, i) => {
    if (!s.missing) putBand(0, s.y, 3.2, 0.72, `ladder:${s.id ?? i}`);
  });

  // 样本带（饱和时中心平台达到纯黑）
  for (const s of bp.samples) {
    const laneIdx = bp.laneLabels.indexOf(s.laneLabel) + 1;
    const peak = s.peak ?? (s.status === 'saturated' ? 1 : 0.66);
    putBand(laneIdx, s.y, 3.4, peak, `band:${s.id}`);
    if (s.altY != null) putBand(laneIdx, s.altY, 3.4, 0.6, `band:${s.id}:alt`);
  }

  // 拖尾：沿 y 的拉长弱分布
  for (const sm of bp.smears) {
    const laneIdx = laneXs.indexOf(sm.laneX);
    for (let y = sm.startY; y <= sm.endY; y++) {
      const mid = (sm.startY + sm.endY) / 2;
      const fall = 1 - Math.abs(y - mid) / (sm.endY - mid);
      putBand(laneIdx, y, 2.0, sm.peak * Math.max(0, fall));
    }
    const cy = (sm.startY + sm.endY) / 2;
    points.set(`smear:${sm.laneX}:${sm.startY}`, { x: xAtY(curves[laneIdx], cy), y: cy, unit: 'px' });
  }

  return { raster, width, height, points };
}

export interface BuiltGel {
  image: GelImage;
  png: Buffer;
  lanes: Lane[];
  ladderBands: LadderBandNominal[];
  bands: Band[];
  points: Map<string, Point>;
}

let imageSeq = 0;
export function buildGel(bp: GelBlueprint, sourcePrefix: string): BuiltGel {
  const { raster, width, height, points } = renderGel(bp);
  const png = encodePng(width, height, 1, raster);
  const blobSha256 = sha256Bytes(png);
  imageSeq += 1;
  const image: GelImage = {
    id: `img_${bp.variant}`,
    width,
    height,
    channels: 1,
    contentType: 'image/png',
    blobSha256,
    variant: bp.variant,
    exposure: {
      exposureMs: bp.exposureMs,
      sensorBits: bp.sensorBits,
      saturationLevel: bp.saturationLevel,
      sourceText: `${bp.exposureMs}ms @ ${bp.sensorBits}-bit`,
    },
    importTime: '2026-09-25T03:00:00.000Z',
  };

  const orientVersion = `orient_${bp.variant}_${bp.orientation}`;
  const src = (imageId: string) => ({ imageId, orientationVersion: orientVersion, origin: 'seed' as const });

  const laneXs = [bp.ladderX, ...bp.sampleXs];
  const lanes: Lane[] = laneXs.map((x, i) => ({
    id: i === 0 ? 'lane_ladder' : `lane_${bp.laneLabels[i - 1]}`,
    imageId: image.id,
    centerline: curvePoints(x, bp.curveAmp),
    widthPx: 22,
    shape: bp.curveAmp > 0 ? 'smile' : 'straight',
    isLadder: i === 0,
    label: i === 0 ? 'Ladder' : bp.laneLabels[i - 1],
    source: { ...src(image.id), raw: { coords: curvePoints(x, bp.curveAmp) } },
  }));

  const ladderBands: LadderBandNominal[] = bp.ladder.map((s, i) => {
    const p = s.missing
      ? { x: xAtY(lanes[0].centerline, s.y), y: s.y, unit: 'px' as const }
      : points.get(`ladder:${s.id ?? i}`)!;
    return {
      id: `lb_${s.id ?? i}`,
      laneId: 'lane_ladder',
      center: p,
      nominal: s.nominal,
      unit: 'bp',
      missing: s.missing,
      source: { ...src(image.id), raw: { text: `${s.nominal} bp`, coords: [p] } },
    };
  });

  const bands: Band[] = bp.samples.map((s) => {
    const laneId = `lane_${s.laneLabel}`;
    const p = points.get(`band:${s.id}`)!;
    const smear = bp.smears.find((sm) => sm.laneX === bp.sampleXs[bp.laneLabels.indexOf(s.laneLabel)]);
    const interval = smear
      ? {
          start: smear.startY - 20,
          end: smear.startY + 20,
          unit: 'px' as const,
        }
      : s.interval;
    return {
      id: s.id,
      laneId,
      imageId: image.id,
      center: p,
      status: s.status ?? 'resolved',
      interval: interval as Band['interval'],
      peakIntensity: s.peak ?? (s.status === 'saturated' ? 1 : 0.66),
      source: { ...src(image.id), origin: 'auto_candidate', raw: { coords: [p] } },
    };
  });

  void sourcePrefix;
  return { image, png, lanes, ladderBands, bands, points };
}
