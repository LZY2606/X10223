import type { CurvePoint, LaneGeometry } from '../shared/model.js';
import type { GrayRaster } from './image.js';
import { provenance } from './detection.js';

export interface LaneDetectionConfig {
  expectedCount?: number;
  halfWidth: number;
  searchTop: number;
  searchBottom: number;
  minDarkness?: number;
}

export function detectLanes(raster: GrayRaster, blobId: string, config: LaneDetectionConfig): LaneGeometry[] {
  const { searchTop, searchBottom, halfWidth } = config;
  const colScore: number[] = new Array(raster.width).fill(0);
  for (let x = 0; x < raster.width; x++) {
    let sum = 0;
    for (let y = searchTop; y <= searchBottom; y++) sum += 255 - raster.data[y * raster.width + x]!;
    colScore[x] = sum / (searchBottom - searchTop + 1);
  }
  const threshold = Math.max(6, average(colScore) * 1.05);
  const seeds: { x: number; score: number }[] = [];
  let runStart = -1;
  for (let x = 1; x < raster.width; x++) {
    const hot = colScore[x]! > threshold;
    if (hot && runStart < 0) runStart = x;
    if ((!hot || x === raster.width - 1) && runStart >= 0) {
      const end = hot ? x : x - 1;
      let bestX = runStart;
      let bestScore = -1;
      for (let k = runStart; k <= end; k++) {
        if (colScore[k]! > bestScore) {
          bestScore = colScore[k]!;
          bestX = k;
        }
      }
      seeds.push({ x: bestX, score: bestScore });
      runStart = -1;
    }
  }
  const merged = mergeSeeds(seeds, halfWidth * 1.4);
  const lanes: LaneGeometry[] = merged.map((seed, i) => {
    const center = traceCenterline(raster, seed.x, searchTop, searchBottom, halfWidth);
    const { left, right } = laneEdges(center, halfWidth);
    return {
      laneId: `lane-${i + 1}`,
      label: i === 0 ? 'Ladder' : `Sample ${i}`,
      wellSide: 'top',
      left,
      center,
      right,
      source: center.map((p) => provenance(blobId, p.x, p.y, 2)),
    };
  });
  return lanes;
}

function traceCenterline(raster: GrayRaster, startX: number, top: number, bottom: number, halfWidth: number): CurvePoint[] {
  const points: CurvePoint[] = [];
  let x = startX;
  const step = 2;
  for (let y = top; y <= bottom; y += step) {
    let bestX = x;
    let bestScore = -1;
    for (let dx = -Math.round(halfWidth * 0.9); dx <= Math.round(halfWidth * 0.9); dx++) {
      const xx = x + dx;
      if (xx < 0 || xx >= raster.width) continue;
      let score = 0;
      for (let off = -halfWidth; off <= halfWidth; off++) {
        const ax = xx + off;
        if (ax < 0 || ax >= raster.width) continue;
        const w = 1 - Math.abs(off) / (halfWidth + 1);
        score += (255 - raster.data[y * raster.width + ax]!) * w;
      }
      score -= Math.abs(dx) * 2;
      if (score > bestScore) {
        bestScore = score;
        bestX = xx;
      }
    }
    x = bestX;
    points.push({ x, y });
  }
  return points;
}

function laneEdges(center: CurvePoint[], halfWidth: number): { left: CurvePoint[]; right: CurvePoint[] } {
  const left: CurvePoint[] = [];
  const right: CurvePoint[] = [];
  for (let i = 0; i < center.length; i++) {
    const p = center[i]!;
    const prev = center[Math.max(0, i - 1)]!;
    const next = center[Math.min(center.length - 1, i + 1)]!;
    const dx = next.x - prev.x;
    const dy = next.y - prev.y;
    const n = Math.hypot(dx, dy) || 1;
    const nx = -dy / n;
    const ny = dx / n;
    left.push({ x: p.x + nx * halfWidth, y: p.y + ny * halfWidth });
    right.push({ x: p.x - nx * halfWidth, y: p.y - ny * halfWidth });
  }
  return { left, right };
}

function mergeSeeds(seeds: { x: number; score: number }[], minGap: number): { x: number; score: number }[] {
  const sorted = [...seeds].sort((a, b) => b.score - a.score);
  const kept: { x: number; score: number }[] = [];
  for (const seed of sorted) {
    if (kept.every((k) => Math.abs(k.x - seed.x) > minGap)) kept.push(seed);
  }
  return kept.sort((a, b) => a.x - b.x);
}

function average(values: number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length;
}
