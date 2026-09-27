// 合成凝胶的“真值”场景模型：泳道曲线 + 每条带的迁移位置与形态
// 该模型是离线案例包的领域材料来源（不是通用表格）。

export interface SceneBand {
  rank: number;
  m: number;
  intensity: number;
  sigma: number;
  tail: number;
  saturate?: boolean;
  missingInImage?: boolean;
  label?: string;
}

export interface SceneLane {
  index: number;
  isLadder: boolean;
  halfWidth: number;
  bend: { amplitude: number; phase: number };
  bands: SceneBand[];
}

export interface GelScene {
  width: number;
  height: number;
  topY: number;
  bottomY: number;
  laneCount: number;
  lanes: SceneLane[];
  seed: number;
  background: number;
  noiseSigma: number;
}

export function laneCenterX(scene: GelScene, lane: SceneLane, y: number): number {
  const spacing = scene.width / (scene.laneCount + 1);
  const baseX = spacing * (lane.index + 1);
  const t = (y - scene.topY) / (scene.bottomY - scene.topY);
  const bendShape = Math.sin(Math.PI * t);
  return baseX + lane.bend.amplitude * bendShape;
}

export function laneCenterPoints(scene: GelScene, lane: SceneLane, step = 4) {
  const pts: { x: number; y: number }[] = [];
  for (let y = scene.topY; y <= scene.bottomY + 0.5; y += step) {
    pts.push({ x: laneCenterX(scene, lane, y), y });
  }
  return pts;
}

export function makeRng(seed: number) {
  let s = (seed >>> 0) || 1;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
