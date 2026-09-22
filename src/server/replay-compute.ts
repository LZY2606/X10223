import type { Store } from './store.js';
import { PROJECT_ID } from './workspace.js';
import { runAnalysis, type AnalysisContext, type AnalysisResult } from '../domain/pipeline.js';
import { baseState, applyEvent } from '../domain/materials-replay.js';
import type {
  BandAnnotationMaterial, ImageMaterial, LadderSpecMaterial,
  LaneGeometryMaterial, OrientationMaterial, Material, Event,
} from '../shared/types.js';
import { sha256Hex } from '../shared/digest.js';

export interface ReplayComputeResult extends AnalysisResult {
  events: Event[];
  paramsVersion: string;
  imageSha256: string;
  scenarioHints: { missingLadder?: number[]; saturatedLaneBands?: string[]; rotated?: boolean };
}

function find<T extends Material>(mats: Material[], type: T['type']): T {
  return mats.find((m) => m.type === type) as T;
}

export function computeAt(store: Store, branchId: string, uptoSeq?: number): ReplayComputeResult {
  const events = store.listEvents(branchId).filter((e) => uptoSeq === undefined || e.seq <= uptoSeq);
  const importEv = events.find((e) => e.type === 'materials-imported');
  const ids = new Set<string>(importEv ? (importEv.payload as { materialIds: string[] }).materialIds : []);
  const initial = store.listMaterials(PROJECT_ID).filter((m) => ids.has(m.id));

  let state = baseState(initial);
  for (const ev of events) state = applyEvent(state, ev);

  const mats = Object.values(state.materials);
  const imageMat = find<ImageMaterial>(mats, 'source-image');
  const orientation = find<OrientationMaterial>(mats, 'capture-orientation');
  const ladder = find<LadderSpecMaterial>(mats, 'ladder-spec');
  const geometry = find<LaneGeometryMaterial>(mats, 'lane-geometry');
  const bands = find<BandAnnotationMaterial>(mats, 'band-annotation');

  // 选择图像字节：source-patch(image:pixels) 或场景默认变体（rotated 图由 orientation 事件旋转）
  let sha = imageMat.blobSha256;
  const rotatedEv = events.find((e) => e.type === 'orientation-confirmed');
  const patchEv = [...events].reverse().find((e) => e.type === 'source-patch'
    && (e.payload as { target: string }).target === 'image:pixels') as Event | undefined;
  if (patchEv) sha = (patchEv.payload as { imageSha256?: string }).imageSha256 ?? sha;

  // 分支 id 决定该分支“场景图像”（曲线分支用弯曲重绘图；缺失/饱和用对应图；非单调/局部失效仍用基线）
  const scenarioImage: Record<string, string> = {
    'br-curved': 'scenarios/curved-lanes.png',
    'br-missing': 'scenarios/ladder-missing-band.png',
    'br-saturated': 'scenarios/saturated-band.png',
    'br-overlap': 'scenarios/overlap-two-bands.png',
    'br-rotated': 'scenarios/rotated-image.png',
  };
  let bytes = store.getBlob(sha);
  if (!bytes) bytes = Buffer.alloc(0);
  if (!patchEv && scenarioImage[branchId]) {
    // 这些场景图本身就是“只改一个来源”后的像素版本
    const alt = store.getBlob(sha256Hex(require_fs(scenarioImage[branchId])));
    if (alt) bytes = alt;
  }

  const rotation = rotatedEv ? (rotatedEv.payload as { rotationApplied: 0|90|180|270 }).rotationApplied : state.rotationApplied;
  const ctx: AnalysisContext = {
    imageMaterial: imageMat, imageBytes: bytes!, orientation,
    rotationApplied: rotation, ladder, geometry, bands, params: state.params,
  };
  const result = runAnalysis(ctx);
  return {
    ...result, events, paramsVersion: state.params.version, imageSha256: sha,
    scenarioHints: { rotated: rotation !== 0 },
  };
}

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
function require_fs(rel: string): Buffer {
  return readFileSync(join(process.cwd(), 'casepack', rel));
}
