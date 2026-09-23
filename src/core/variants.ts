import type { Event } from '../shared/model.js';
import { digestOf } from '../shared/ids.js';
import type { BuiltCase } from './caseFactory.js';
import { attachLadderRungs, buildGelCase } from './caseFactory.js';
import { appendEvent, forkBranch } from './service.js';
import { appendImageAndMaterials } from './casePack.js';
import { replay } from './replay.js';
import { decodePng, encodePngGray, toGray, type GrayRaster } from './image.js';

export interface VariantContext {
  log: BuiltCase['log'];
  branch: string;
  clock: () => string;
  built: BuiltCase;
}

export type VariantMutator = (ctx: VariantContext) => void;

export interface VariantDef {
  key: string;
  name: string;
  make: () => BuiltCase;
  missingRung?: number | null;
  mutator?: VariantMutator;
}

export const VARIANT_DEFS: VariantDef[] = [
  {
    key: 'rotation',
    name: '反例·旋转图像（等价输入，分子量顺序稳定）',
    make: () => buildGelCase({ seed: 1194 }),
    mutator: rotateVariant,
  },
  {
    key: 'smile',
    name: '反例·弯曲泳道（微笑）：同一高度不等于同一分子量',
    make: () => buildGelCase({ smiling: true, seed: 1194 }),
  },
  {
    key: 'missing-rung',
    name: '反例·ladder 缺带：局部插值段缺失',
    make: () => buildGelCase({ missingRungBp: 1500 }),
    missingRung: 1500,
  },
  {
    key: 'saturation',
    name: '反例·饱和区：只能候选/区间',
    make: () => buildGelCase({ saturated: true }),
  },
  {
    key: 'overlap',
    name: '反例·两条带重叠：保留全部合法候选',
    make: () => buildGelCase({ overlap: true }),
  },
  {
    key: 'nonmonotonic',
    name: '反例·非单调标尺：语义无解',
    make: () => buildGelCase({ ladderBpOverride: [10000, 5000, 3000, 3000, 3500, 1000, 750, 500, 250] }),
  },
  {
    key: 'local-revision',
    name: '反例·修订后局部失效：仅受影响对象改变',
    make: () => buildGelCase({ saturated: true, tailing: true }),
    mutator: localRevisionVariant,
  },
];

export function buildVariantBranch(
  baselineLog: BuiltCase['log'],
  projectCreatedEventId: string,
  def: VariantDef,
  clock: () => string,
  addBlob: (id: string, png: Buffer) => void,
): { branchId: string; built: BuiltCase } {
  const branchId = `br_${def.key}`;
  forkBranch(baselineLog, 'br_main', branchId, def.name, projectCreatedEventId, clock());
  const built = def.make();
  built.log = baselineLog;
  addBlob(built.blobId, built.png);
  appendImageAndMaterials(built, branchId, clock, { missingRung: def.missingRung ?? null });
  attachLadderRungs(built, branchId, { missingBp: def.missingRung ?? null, bpOverride: built.ladderBp });
  def.mutator?.({ log: baselineLog, branch: branchId, clock, built });
  return { branchId, built };
}

function rotateVariant(ctx: VariantContext): void {
  appendEvent(
    { log: ctx.log, branch: ctx.branch, actor: 'reviewer', now: ctx.clock() },
    'capture-orientation-recorded',
    {
      orientation: { rotationCw: 90, flipped: false, wellSide: 'right', rawLabel: '复核旋转：原图顺时针旋转 90°；这是相对基线唯一被改动的直接来源' },
      note: '等价输入：像素内容相同，仅拍摄方向解释改变',
    },
    { deterministic: false, inputSummary: { rotationCw: 90, sourceBlobId: ctx.built.blobId } },
  );
}

function localRevisionVariant(ctx: VariantContext): void {
  appendEvent(
    { log: ctx.log, branch: ctx.branch, actor: 'reviewer', now: ctx.clock() },
    'parameter-revised',
    {
      revision: {
        name: 'saturationThreshold',
        oldValue: 8,
        newValue: 20,
        reason: '反例：放宽饱和阈值后，仅饱和/拖尾条带的派生状态局部失效，其它条带分子量与顺序保持',
      },
    },
    { deterministic: false, inputSummary: { parameter: 'saturationThreshold', old: 8, new: 20 } },
  );
}

export function rotateRasterCw90(raster: GrayRaster): GrayRaster {
  const out = new Uint8Array(raster.width * raster.height);
  for (let y = 0; y < raster.height; y++) {
    for (let x = 0; x < raster.width; x++) {
      const nx = raster.height - 1 - y;
      const ny = x;
      out[ny * raster.height + nx] = raster.data[y * raster.width + x]!;
    }
  }
  return { width: raster.height, height: raster.width, data: out };
}

export function pngToRaster(png: Buffer): GrayRaster {
  return toGray(decodePng(png));
}

export function rasterToPng(raster: GrayRaster): Buffer {
  return encodePngGray(raster);
}

export function replayBranch(built: BuiltCase, branchId: string, raster: GrayRaster) {
  const events = built.log.events.filter((e) => e.branch === branchId).sort((a, b) => a.seq - b.seq);
  return replay(branchId, events, { raster });
}

export function resultsDigest(built: BuiltCase, branchId: string, raster: GrayRaster): string {
  return digestOf(replayBranch(built, branchId, raster).view.molecularWeights);
}

export type { Event };
