/**
 * 合成凝胶（专门针对“胶道标尺”的领域材料，非通用表格）。
 * 输出的是真实像素 PNG：沿 lane 曲线绘制高斯条带，支持微笑弯曲、
 * 饱和削顶、重叠、拖尾、ladder 缺带等情形。所有坐标都可像素级溯源。
 */
import { paintGaussian } from './imageOps';
import { encodePng, type Raster } from './png';

export interface SynthBand {
  laneIndex: number;
  /** 沿 lane 的弧长（像素，自上样孔起）。 */
  s: number;
  amplitude: number;
  sigmaX: number;
  sigmaY: number;
  smear?: boolean;
}

export interface GelSpec {
  width: number;
  height: number;
  laneXs: number[];
  laneHalfWidth: number;
  /** 弯曲幅度（像素）：正值微笑（中间迁移更远），0 为直泳道。 */
  smileAmp: number;
  bands: SynthBand[];
  base?: number;
}

/** lane 中心线：随弧长 s 的横向偏移，模拟微笑/皱眉弯曲。 */
export function laneCenterX(laneX: number, s: number, height: number, smileAmp: number): number {
  const t = s / height;
  return laneX + smileAmp * Math.sin(Math.PI * t) * (0.6 + 0.4 * t);
}

export function renderGel(spec: GelSpec): { png: Buffer; raster: Raster; centers: Record<string, { x: number; y: number }> } {
  const raster: Raster = { width: spec.width, height: spec.height, channels: 1, data: new Uint8Array(spec.width * spec.height) };
  const centers: Record<string, { x: number; y: number }> = {};
  for (const band of spec.bands) {
    const laneX = spec.laneXs[band.laneIndex]!;
    const cx = Math.round(laneCenterX(laneX, band.s, spec.height, spec.smileAmp));
    const cy = Math.round(band.s);
    const sy = band.smear ? band.sigmaY * 3.2 : band.sigmaY;
    paintGaussian(raster, cx, cy, band.sigmaX, sy, band.amplitude, spec.base ?? 10);
    centers[`${band.laneIndex}:${band.s}`] = { x: cx, y: cy };
  }
  // 轻微背景噪声（确定性，保证可重放）。
  for (let i = 0; i < raster.data.length; i++) {
    if (raster.data[i] === 0) raster.data[i] = 6 + ((i * 1103515245 + 12345) % 9);
  }
  return { png: encodePng(raster), raster, centers };
}

/** 标准 ladder 标称值（bp，核酸），由上至下迁移增大、bp 减小。 */
export const LADDER_BP = [1000, 850, 700, 600, 500, 400, 300, 200, 100];

/** 由弧长位置生成 lane 折线点（像素级），含弯曲。 */
export function lanePolyline(
  laneX: number,
  width: number,
  height: number,
  smileAmp: number,
  step = 8
): { x: number; y: number }[] {
  void width;
  const pts: { x: number; y: number }[] = [];
  for (let y = 20; y <= height - 20; y += step) pts.push({ x: Math.round(laneCenterX(laneX, y, height, smileAmp)), y });
  return pts;
}
