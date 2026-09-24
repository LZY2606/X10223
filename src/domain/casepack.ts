import { readFileSync } from 'node:fs';
import { renderGelImage, yForSize, type GelImageSpec } from './gelImage.ts';
import { runPipeline, computeInvalidated, type ImageAccess } from './engine.ts';
import { PARAMS_V1, type AppEvent, type BandCenter, type DerivedResult, type Material, type ParamSet } from './types.ts';
import { digest } from './ids.ts';
import { IMAGE_BASIS } from './units.ts';

/** Minimal store contract the case-pack runner needs (implemented by the
 *  SQLite Store and by test doubles). */
export interface CaseStore {
  addMaterial(kind: Material['kind'], label: string, raw: unknown, blob?: Buffer): Material;
  appendEvent(type: AppEvent['type'], payload: unknown, parents: string[], branch?: string): AppEvent;
  listMaterials(): Material[];
  putResults(results: DerivedResult[], seq: number): void;  supersede(resultIds: string[], seq: number): void;
  currentResults(): DerivedResult[];
  imageAccess(materialId: string): ImageAccess | undefined;
  latestSeq(): number;
}

export interface CasePack {
  format: string;
  title: string;
  narrative: string;
  image: Omit<GelImageSpec, 'lanes' | 'bands'> & {
    lanes: { lane_index: number; role: 'ladder' | 'sample'; x0: number; x1: number }[];
  };
  orientation: { rotation_deg: 0; wells: 'top' };
  exposure: { time_ms: number; gain: number };
  ladder_nominal: { sizes_bp: number[]; unit: 'bp' };
  ladder_sizes_present: number[];
  sample_bands: { lane: number; size_bp: number; intensity: number; saturated?: boolean; tailing?: boolean }[];
  script: Record<string, unknown>[];
}

export function loadCasePack(path: string): CasePack {
  return JSON.parse(readFileSync(path, 'utf8')) as CasePack;
}

export interface SeedReport {
  title: string;
  materials: number;
  events: number;
  results: number;
  branches: string[];
  log: string[];
}

/** Execute the case pack against a store: baseline import, auto
 *  candidates, one parameter revision, one locally-scoped source
 *  amendment, and one pair of conflicting human decisions. */
export function runCasePack(store: CaseStore, pack: CasePack): SeedReport {
  const log: string[] = [];
  const spec: GelImageSpec = {
    width: pack.image.width,
    height: pack.image.height,
    smile_k: pack.image.smile_k,
    y_for_size: pack.image.y_for_size,
    lanes: pack.image.lanes.map((l) => ({ x0: l.x0, x1: l.x1 })),
    bands: [
      ...pack.ladder_sizes_present.map((s) => ({ lane: 0, size_bp: s, intensity: 200 })),
      ...pack.sample_bands.map((b) => ({ lane: b.lane, size_bp: b.size_bp, intensity: b.intensity, tailing: b.tailing })),
    ],
    saturated_regions: pack.sample_bands
      .filter((b) => b.saturated)
      .map((b) => {
        const lane = pack.image.lanes[b.lane];
        const y = yForSize(pack.image.y_for_size, b.size_bp);
        return { x: lane.x0, y: Math.round(y) - 4, w: lane.x1 - lane.x0, h: 8 };
      }),
  };
  const { png, bandCenters } = renderGelImage(spec);

  const imageMat = store.addMaterial('gel_image', 'gel-image', {
    width: spec.width,
    height: spec.height,
    smile_k: spec.smile_k,
    generator: 'casepack:renderGelImage',
    png_digest: digest(png.toString('base64')),
    unit: 'px',
    basis: IMAGE_BASIS,
  }, png);
  const orientMat = store.addMaterial('capture_orientation', 'orientation', pack.orientation);
  const expoMat = store.addMaterial('exposure', 'exposure', pack.exposure);
  const ladderMat = store.addMaterial('ladder_nominal', 'ladder', pack.ladder_nominal);
  const lanesMat = store.addMaterial('lane_boundary', 'lanes', { lanes: pack.image.lanes, unit: 'px', basis: IMAGE_BASIS });

  const bandMats = new Map<number, Material>();
  const centersByLane = new Map<number, BandCenter[]>();
  for (const bc of bandCenters) {
    const isLadder = bc.lane === 0;
    const sample = pack.sample_bands.find((s) => s.lane === bc.lane && s.size_bp === bc.size_bp);
    const center: BandCenter & { size_bp?: number; true_size_bp?: number; tailing?: boolean } = {
      band_id: `b_L${bc.lane}_${bc.size_bp}`,
      lane_index: bc.lane,
      x: bc.x,
      y: bc.y,
      basis: IMAGE_BASIS,
      source: isLadder ? 'human:ladder-annotation' : 'auto:band-detector-v1',
    };
    if (isLadder) center.size_bp = bc.size_bp;
    else {
      center.true_size_bp = bc.size_bp;
      if (sample?.tailing) center.tailing = true;
    }
    if (!centersByLane.has(bc.lane)) centersByLane.set(bc.lane, []);
    centersByLane.get(bc.lane)!.push(center);
  }
  for (const [lane, centers] of [...centersByLane.entries()].sort((a, b) => a[0] - b[0])) {
    centers.sort((a, b) => a.y - b.y || a.band_id.localeCompare(b.band_id));
    const mat = store.addMaterial('band_centers', `lane-${lane}`, {
      lane_index: lane,
      centers,
      unit: 'px',
      basis: IMAGE_BASIS,
    });
    bandMats.set(lane, mat);
  }

  const baseMats = [imageMat, orientMat, expoMat, ladderMat, lanesMat, ...bandMats.values()];
  store.appendEvent('material.imported',
    { note: '初始导入：原图、拍摄方向、曝光、ladder 标称值、lane 边界与条带中心均保留像素级来源', material_ids: baseMats.map((m) => m.id) },
    baseMats.map((m) => m.id));
  log.push(`imported ${baseMats.length} materials`);

  let params: ParamSet = { ...PARAMS_V1 };
  const compute = (branch: string, note: string) => {
    const materials = store.listMaterials();
    const image = store.imageAccess(imageMat.id);
    const pipeline = runPipeline(materials, params, image, branch);
    const seq = store.latestSeq() + 1;
    store.putResults(pipeline.results, seq);
    store.appendEvent('candidates.generated', {
      note,
      params_version: params.version,
      outcome: pipeline.outcome.kind,
      result_ids: pipeline.results.map((r) => r.id),
      diagnostics: pipeline.diagnostics,
    }, baseMats.map((m) => m.id), branch);
    for (const j of pipeline.judgements) {
      store.appendEvent('judgement.recorded', j, pipeline.results.map((r) => r.id), branch);
    }
    return pipeline;
  };

  let pipeline = compute('main', '自动候选生成 (params-v1)');
  log.push(`computed ${pipeline.results.length} results with ${params.version}`);

  // --- parameter revision: overlap threshold 8px -> 12px -----------------
  params = { ...params, version: 'params-v2', overlap_min_sep_px: 12 };
  store.appendEvent('params.revised', { from: 'params-v1', to: params, note: '参数修订：重叠判定阈值 8px → 12px' }, []);
  pipeline = compute('main', '参数修订后重算 (params-v2)');
  log.push('params revised to params-v2, recomputed');

  // --- locally-scoped source amendment: one band center in lane 3 --------
  const lane3Mat = bandMats.get(3)!;
  const lane3Raw = lane3Mat.raw as { lane_index: number; centers: (BandCenter & { true_size_bp?: number })[]; unit: string; basis: unknown };
  const amendedCenters = lane3Raw.centers.map((c) =>
    c.true_size_bp === 2000 ? { ...c, y: c.y + 6, source: 'human:revision-r1' } : c);
  const amendedMat = store.addMaterial('band_centers', 'lane-3', {
    ...lane3Raw,
    centers: amendedCenters,
    amended_from: lane3Mat.id,
  });
  const invalidated = computeInvalidated(store.currentResults(), new Set([lane3Mat.id]));
  const amendSeq = store.latestSeq() + 1;
  store.appendEvent('source.amended', {
    note: '源数据改动：仅修订 lane-3 一个条带中心（y +6px），检验局部失效',
    old_material: lane3Mat.id,
    new_material: amendedMat.id,
    invalidated_result_ids: invalidated,
  }, [lane3Mat.id, amendedMat.id]);
  store.supersede(invalidated, amendSeq);
  pipeline = compute('main', 'lane-3 条带中心修订后重算 (params-v2)');
  log.push(`amended lane-3 source, invalidated ${invalidated.length} results locally`);

  // --- conflicting human decisions on the same auto candidate ------------
  const target = store.currentResults()
    .find((r) => r.kind === 'mw_estimate' && (r.value as { band_id?: string }).band_id === 'b_L1_3500');
  if (target) {
    store.appendEvent('decision.accepted', {
      reviewer: 'reviewer-1', target_result: target.id,
      note: '人工决定：接受自动候选（lane-1 ~3500bp）',
    }, [target.id], 'main');
    store.appendEvent('decision.rejected', {
      reviewer: 'reviewer-2', target_result: target.id,
      note: '互相冲突的人工决定：同一候选被否决',
    }, [target.id], 'reviewer-2');
    store.appendEvent('conflict.recorded', {
      target_result: target.id,
      parties: ['reviewer-1:accept', 'reviewer-2:reject'],
      resolution: 'both-kept',
      note: '冲突保留：被采纳与未采纳的结果同时存档',
    }, [target.id], 'main');
    log.push('recorded conflicting decisions on ' + target.id);
  }

  const events = store.latestSeq();
  return {
    title: pack.title,
    materials: store.listMaterials().length,
    events,
    results: store.currentResults().length,
    branches: ['main', 'reviewer-2'],
    log,
  };
}
