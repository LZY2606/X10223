import type { BandCenterMaterial, LaneSpec, PixelProvenance } from './types.js';
import { pixelProv } from './materials.js';
import { rotatePointCW } from './geometry.js';

/**
 * 把 lane 几何与条带中心从原图帧变换到“分析帧”（标准方向）。
 * 弧长在 90 度旋转下保持，因此迁移距离仍可回到原图像素来源。
 * 返回的来源坐标保留原图帧，仅新增分析坐标用于取样。
 */
export interface AnalyzeFrame {
  lanes: LaneSpec[];
  /** laneId -> 分析帧中心像素（与原图中心一一对应） */
  bandCentersAnalyze: Record<string, Array<{ x: number; y: number; src: PixelProvenance }>>;
}

export function toAnalyzeFrame(
  lanes: LaneSpec[],
  bandsByLane: Record<string, BandCenterMaterial>,
  widthOrig: number,
  heightOrig: number,
  cw: number,
): AnalyzeFrame {
  const tf = (x: number, y: number) => rotatePointCW(x, y, widthOrig, heightOrig, cw);
  const mappedLanes = lanes.map((lane) => {
    const mapPts = (pts: Array<{ x: { value: number }; y: { value: number } }>) =>
      pts.map((p) => {
        const q = tf(p.x.value, p.y.value);
        return { x: { value: q.x, unit: 'pixel' as const }, y: { value: q.y, unit: 'pixel' as const } };
      });
    return {
      ...lane,
      leftBoundary: mapPts(lane.leftBoundary),
      rightBoundary: mapPts(lane.rightBoundary),
      centerline: mapPts(lane.centerline),
    };
  });

  const bandCentersAnalyze: AnalyzeFrame['bandCentersAnalyze'] = {};
  for (const lane of lanes) {
    const bc = bandsByLane[lane.laneId];
    if (!bc) continue;
    bandCentersAnalyze[lane.laneId] = bc.centers.map((c) => {
      const q = tf(c.x.value, c.y.value);
      return { x: q.x, y: q.y, src: c };
    });
  }
  return { lanes: mappedLanes, bandCentersAnalyze };
}

export function makeAnalyzeProvenance(
  src: PixelProvenance,
  xAnalyze: number,
  yAnalyze: number,
  transformId: string,
  cw: number,
): PixelProvenance {
  return pixelProv(src.imageId, xAnalyze, yAnalyze, 'rotated', {
    gray: src.gray,
    radius: src.radius,
    note: `analyze-frame; source original pixel retained`,
    transformChain: [
      ...(src.transformChain ?? []),
      { transformId, type: 'rotate' as const, clockwiseDegrees: cw },
    ],
  });
}
