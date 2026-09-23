import type { GelSpec } from '../domain/image';
import { renderGel } from '../domain/image';
import { encodePng } from '../domain/png';
import type { ParamSet } from '../shared/types';
import { Buffer } from 'node:buffer';

export const PARAMS_V1: ParamSet = { version: 'v1-global', interpolation: 'global-log-linear', saturationValue: 255, minPeakSeparationPx: 6, peakThreshold: 30 };
export const PARAMS_V2: ParamSet = { version: 'v2-local', interpolation: 'local-piecewise', saturationValue: 255, minPeakSeparationPx: 6, peakThreshold: 30 };

export const LADDER_SIZES = [10000, 8000, 6000, 5000, 4000, 3000, 2000, 1500, 1000, 500];

export function ladderY(sizeBp: number): number {
  return Math.round((50 + (4 - Math.log10(sizeBp)) * 220) * 10) / 10;
}

export interface CasePack {
  id: string;
  title: string;
  domain: string;
  params: { v1: ParamSet; v2: ParamSet };
  gel: GelSpec;
  imagePngBase64: string;
  orientation: { basis: string; loadingDirection: 'top-to-bottom'; wellsAt: 'top' };
  exposure: { seconds: number; iso: number; unit: { seconds: 's'; iso: 'ISO' } };
  counterexamples: { id: string; title: string; change: string }[];
}

/** 离线案例包：真实领域材料（合成凝胶图 + 标称值 + 泳道/条带几何），非通用表格。 */
export function buildCasePack(): CasePack {
  const gel: GelSpec = {
    width: 360,
    height: 420,
    lanes: [
      { id: 'L1-ladder', xCenter: 40, halfWidth: 10, source: { kind: 'interval', imageId: 'img_baseline', axis: 'x', lo: 30, hi: 50 } },
      { id: 'L2', xCenter: 110, halfWidth: 12, source: { kind: 'interval', imageId: 'img_baseline', axis: 'x', lo: 98, hi: 122 } },
      { id: 'L3', xCenter: 180, halfWidth: 12, source: { kind: 'interval', imageId: 'img_baseline', axis: 'x', lo: 168, hi: 192 } },
      { id: 'L4', xCenter: 250, halfWidth: 12, source: { kind: 'interval', imageId: 'img_baseline', axis: 'x', lo: 238, hi: 262 } },
      { id: 'L5', xCenter: 320, halfWidth: 12, source: { kind: 'interval', imageId: 'img_baseline', axis: 'x', lo: 308, hi: 332 } },
    ],
    ladderLaneId: 'L1-ladder',
    ladderSizesBp: LADDER_SIZES,
    ladderSizesPresent: LADDER_SIZES,
    ladderBandYs: LADDER_SIZES.map(ladderY),
    sampleBands: [
      { laneId: 'L2', y: 145, amplitude: 200, sigma: 2.4 },
      { laneId: 'L2', y: 250, amplitude: 180, sigma: 2.4 },
      { laneId: 'L3', y: 160, amplitude: 700, sigma: 2.6, saturate: true },
      { laneId: 'L3', y: 300, amplitude: 190, sigma: 2.4 },
      { laneId: 'L4', y: 200, amplitude: 190, sigma: 2.2 },
      { laneId: 'L4', y: 205, amplitude: 170, sigma: 2.2 },
      { laneId: 'L4', y: 320, amplitude: 170, sigma: 2.4, tail: 12 },
      { laneId: 'L5', y: 90, amplitude: 200, sigma: 2.4 },
      { laneId: 'L5', y: 370, amplitude: 180, sigma: 2.4 },
    ],
    smile: 18,
    noise: 6,
    background: 18,
  };
  const img = renderGel(gel);
  const png = encodePng(img);
  return {
    id: 'gel-case-001',
    title: '胶道标尺：电泳条带、泳道弯曲与分子量校准工作台',
    domain: 'gel-electrophoresis',
    params: { v1: PARAMS_V1, v2: PARAMS_V2 },
    gel,
    imagePngBase64: Buffer.from(png).toString('base64'),
    orientation: { basis: 'image-px:origin-top-left,y-down', loadingDirection: 'top-to-bottom', wellsAt: 'top' },
    exposure: { seconds: 0.8, iso: 400, unit: { seconds: 's', iso: 'ISO' } },
    counterexamples: [
      { id: 'rotated-image', title: '旋转图像', change: '图像旋转 90°，lane 定义仍在原坐标基准' },
      { id: 'curved-lanes', title: '弯曲泳道（微笑）', change: '微笑弯曲 18px：同一高度不等于同一分子量' },
      { id: 'ladder-missing-band', title: 'ladder 缺带', change: '移除 4000bp 标称带' },
      { id: 'saturated-region', title: '饱和区', change: 'L3 条带曝光饱和（幅值 700→255 截断）' },
      { id: 'overlapping-bands', title: '两条带重叠', change: 'L4 两条带中心相距 5px（< 6px 可分辨限）' },
      { id: 'non-monotonic-ruler', title: '非单调标尺', change: '交换 2000bp 与 3000bp 的 y 指派' },
      { id: 'local-invalidation', title: '修订后局部失效', change: '修正 L2 第二条带中心 250→258px，仅影响其依赖' },
    ],
  };
}
