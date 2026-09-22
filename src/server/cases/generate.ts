import { encodePng, type Raster } from '../../shared/png.js';
import { stableId } from '../../shared/hash.js';
import type {
  BandCenterMaterial,
  ExposureMaterial,
  LaneBoundaryMaterial,
  LadderNominalMaterial,
  OrientationMaterial,
  Point,
  RawImageMaterial,
  ScenarioKind,
} from '../../shared/types.js';
import { rotate90Cw, warpSmile } from '../../shared/imageops.js';
import { q } from '../../shared/geometry.js';
import { createHash } from 'node:crypto';

export const BASE_WIDTH = 360;
export const BASE_HEIGHT = 420;
export const LANE_X = [60, 130, 200, 270]; // 第 0 条为 ladder
export const LANE_HALF = 22;

// 常见 dsDNA ladder 标称值(bp)，按迁移升序（大→小）
export const LADDER_BP = [1500, 1000, 750, 500, 250, 100];

export interface CaseConfig {
  scenario: 'baseline' | ScenarioKind;
  laneYs?: number[][]; // 每条泳道条带 y（image-px）
  saturatedLanes?: number[];
  smearLanes?: number[];
  overlapLanes?: number[];
  missingLadder?: boolean;
  nonmonotonic?: boolean;
  rotate?: boolean;
  warpAmp?: number;
  exposureRaw?: Record<string, string>;
}

// 可复现 PRNG（案例包确定性）
export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface DrawOptions {
  saturated?: boolean;
  smear?: boolean;
  overlap?: boolean;
  intensity?: number;
}

function drawBand(
  raster: Raster,
  cx: number,
  cy: number,
  width: number,
  height: number,
  intensity: number,
  saturated: boolean,
  rng: () => number,
) {
  for (let y = cy - height; y <= cy + height; y++) {
    for (let x = cx - width; x <= cx + width; x++) {
      if (x < 0 || y < 0 || x >= raster.width || y >= raster.height) continue;
      const tx = (x - cx) / width;
      const ty = (y - cy) / height;
      const falloff = Math.exp(-(tx * tx * 2.2 + ty * ty * 3.0));
      const noise = (rng() - 0.5) * 8;
      let value = 245 - intensity * falloff + noise;
      if (saturated && falloff > 0.45) value = 255;
      value = Math.max(0, Math.min(255, Math.round(value)));
      for (let c = 0; c < raster.channels; c++) {
        const idx = (y * raster.width + x) * raster.channels + c;
        raster.data[idx] = value;
      }
    }
  }
}

export function baselineRaster(rng: () => number, opts: {
  laneYs: number[][];
  saturatedLanes: number[];
  smearLanes: number[];
  overlapLanes: number[];
  skipLadderBandIndex?: number;
}): Raster {
  const raster: Raster = {
    width: BASE_WIDTH,
    height: BASE_HEIGHT,
    channels: 1,
    data: new Uint8Array(BASE_WIDTH * BASE_HEIGHT).fill(245),
  };
  for (let y = 0; y < BASE_HEIGHT; y++) {
    for (let x = 0; x < BASE_WIDTH; x++) {
      raster.data[y * BASE_WIDTH + x] = Math.max(0, Math.min(255, 245 + (rng() - 0.5) * 10));
    }
  }
  opts.laneYs.forEach((ys, laneIdx) => {
    ys.forEach((yPos, bandIdx) => {
      if (laneIdx === 0 && bandIdx === opts.skipLadderBandIndex) return;
      const saturated = opts.saturatedLanes.includes(laneIdx) && bandIdx === 1;
      const smear = opts.smearLanes.includes(laneIdx) && bandIdx === 2;
      drawBand(
        raster,
        LANE_X[laneIdx],
        yPos,
        LANE_HALF - 4,
        smear ? 16 : 6,
        150,
        saturated,
        rng,
      );
      if (opts.overlapLanes.includes(laneIdx) && bandIdx === 1) {
        drawBand(raster, LANE_X[laneIdx] + 2, yPos + 12, LANE_HALF - 4, 6, 150, false, rng);
      }
    });
  });
  return raster;
}

const defaultLaneYs = (): number[][] => {
  const ladderYs = LADDER_BP.map((_, i) => 70 + i * 52);
  const sample = [
    [96, 174, 278, 330],
    [70, 226, 330],
    [122, 226, 278],
  ];
  return [ladderYs, ...sample];
};

export interface GeneratedCase {
  scenario: 'baseline' | ScenarioKind;
  png: Buffer;
  width: number;
  height: number;
  sha256: string;
  lanes: { laneId: string; role: 'ladder' | 'sample'; label: string; left: Point[]; right: Point[]; kind: 'straight' | 'curved' }[];
  bands: { laneId: string; at: Point; saturated?: boolean; smeared?: boolean; overlap?: boolean }[];
  ladderNominal: { id: string; mwBp: number; raw: string }[];
  rotated: boolean;
  warpAmp: number;
}

export function scenarioConfig(scenario: 'baseline' | ScenarioKind): CaseConfig {
  const laneYs = defaultLaneYs();
  const base: CaseConfig = { scenario, laneYs };
  switch (scenario) {
    case 'saturation':
      return { ...base, saturatedLanes: [2] };
    case 'overlap':
      return { ...base, overlapLanes: [3], smearLanes: [2] };
    case 'smile-warp':
      return { ...base, warpAmp: 26 };
    case 'rotation':
      return { ...base, rotate: true, exposureRaw: { time: '1.5 s', rotation: '90deg' } };
    case 'ladder-missing-band':
      return { ...base, missingLadder: true };
    case 'nonmonotonic-ruler':
      return { ...base, nonmonotonic: true };
    case 'revision-local-failure':
      return { ...base };
    default:
      return base;
  }
}

export function generateCase(scenario: 'baseline' | ScenarioKind): GeneratedCase {
  const config = scenarioConfig(scenario);
  const rng = mulberry32(
    scenario.split('').reduce((acc, ch) => acc * 31 + ch.charCodeAt(0), 7),
  );
  const laneYs = config.laneYs ?? defaultLaneYs();
  let raster = baselineRaster(rng, {
    laneYs,
    saturatedLanes: config.saturatedLanes ?? [],
    smearLanes: config.smearLanes ?? [],
    overlapLanes: config.overlapLanes ?? [],
    skipLadderBandIndex: config.missingLadder ? 3 : undefined,
  });

  let warpAmp = config.warpAmp ?? 0;
  if (warpAmp) raster = warpSmile(raster, warpAmp).raster;
  let rotated = false;
  if (config.rotate) {
    raster = rotate90Cw(raster).raster;
    rotated = true;
  }

  const png = encodePng(raster);
  const sha256 = createHash('sha256').update(png).digest('hex');
  const width = raster.width;
  const height = raster.height;

  const lanes = buildLanes(scenario, laneYs, raster, config);
  const bands = buildBands(scenario, laneYs, raster, config);
  let ladderNominal = LADDER_BP.map((bp, i) => ({
    id: stableId('nom', [scenario, i, bp]),
    mwBp: bp,
    raw: `${bp} bp`,
  }));
  if (config.nonmonotonic) {
    // 人为制造非单调标称（交换相邻两项，破坏 bp 单调）
    const swap = [...ladderNominal];
    [swap[2], swap[3]] = [swap[3], swap[2]];
    ladderNominal = swap;
  }

  return { scenario, png, width, height, sha256, lanes, bands, ladderNominal, rotated, warpAmp };
}

function warpShiftAt(y: number, amp: number, h: number) {
  const t = (y / Math.max(1, h - 1) - 0.5) * 2;
  return Math.round(amp * t * t);
}

function buildLanes(
  scenario: string,
  laneYs: number[][],
  raster: Raster,
  config: CaseConfig,
): GeneratedCase['lanes'] {
  const curved = scenario === 'smile-warp';
  const rotated = !!config.rotate;
  return laneYs.map((_, idx) => {
    const laneId = `lane-${idx + 1}`;
    const role = idx === 0 ? 'ladder' : 'sample';
    const top = 40;
    const bottom = raster.height - 20;
    if (rotated) {
      // 旋转后泳道沿 x 方向：上下边界为竖直短线，中心线水平
      const xCenter =
        BASE_HEIGHT - 1 - (idx === 0 ? LANE_X[0] : LANE_X[idx]);
      const xs = [];
      for (let y = top; y <= bottom; y += 20) xs.push({ x: xCenter - LANE_HALF, y }, { x: xCenter + LANE_HALF, y });
      const left: Point[] = [];
      const right: Point[] = [];
      for (let y = top; y <= bottom; y += 20) {
        left.push({ x: xCenter - LANE_HALF, y });
        right.push({ x: xCenter + LANE_HALF, y });
      }
      return { laneId, role, label: `${role} ${idx + 1}`, left, right, kind: 'straight' as const };
    }
    const baseX = LANE_X[idx];
    const left: Point[] = [];
    const right: Point[] = [];
    for (let y = top; y <= bottom; y += 20) {
      const shift = curved ? warpShiftAt(y, config.warpAmp ?? 0, BASE_HEIGHT) : 0;
      left.push({ x: baseX - LANE_HALF + shift, y });
      right.push({ x: baseX + LANE_HALF + shift, y });
    }
    return { laneId, role, label: `${role} ${idx + 1}`, left, right, kind: curved ? ('curved' as const) : ('straight' as const) };
  });
}

function buildBands(
  scenario: string,
  laneYs: number[][],
  raster: Raster,
  config: CaseConfig,
): GeneratedCase['bands'] {
  const bands: GeneratedCase['bands'] = [];
  laneYs.forEach((ys, idx) => {
    const laneId = `lane-${idx + 1}`;
    ys.forEach((yPos, bandIdx) => {
      const xBase = LANE_X[idx];
      let at: Point;
      if (config.rotate) {
        // 原 (xBase,y) -> (H-1-y, xBase)
        at = { x: BASE_HEIGHT - 1 - yPos, y: xBase };
      } else {
        const shift = scenario === 'smile-warp' ? warpShiftAt(yPos, config.warpAmp ?? 0, BASE_HEIGHT) : 0;
        at = { x: xBase + shift, y: yPos };
      }
      const inMissing =
        config.missingLadder && idx === 0 && bandIdx === 3;
      if (inMissing) return;
      bands.push({
        laneId,
        at,
        saturated: (config.saturatedLanes ?? []).includes(idx) && bandIdx === 1,
        smeared: (config.smearLanes ?? [1]).includes(idx) && bandIdx === 2,
        overlap: (config.overlapLanes ?? []).includes(idx) && bandIdx === 1,
      });
      if ((config.overlapLanes ?? []).includes(idx) && bandIdx === 1) {
        bands.push({
          laneId,
          at: config.rotate
            ? { x: BASE_HEIGHT - 1 - (yPos + 12), y: xBase + 2 }
            : { x: xBase + 2 + (scenario === 'smile-warp' ? 0 : 0), y: yPos + 12 },
          overlap: true,
        });
      }
    });
  });
  return bands;
}
