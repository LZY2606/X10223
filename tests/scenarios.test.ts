import { describe, expect, it } from 'vitest';
import { runPipeline, computeInvalidated } from '../src/domain/engine.ts';
import { PARAMS_V1, JUDGEMENT, type BandCenter, type DerivedResult, type ParamSet } from '../src/domain/types.ts';
import { orientationAfter180, rotate180, transformCenters } from '../src/domain/scenarios.ts';
import { decodeGrayPng, encodeGrayPng } from '../src/domain/png.ts';
import { currentByKind, rerun, seededStore } from './helpers.ts';
import { digest } from '../src/domain/ids.ts';
import { IMAGE_BASIS } from '../src/domain/units.ts';

const PARAMS_V2: ParamSet = { ...PARAMS_V1, version: 'params-v2', overlap_min_sep_px: 12 };

type MwValue = {
  band_id: string; status: string; mw_bp?: number; interval_bp?: [number, number];
  candidates_bp?: number[]; flags?: string[]; reason?: string;
};

function mwResults(results: DerivedResult[]): { id: string; value: MwValue }[] {
  return results.filter((r) => r.kind === 'mw_estimate' && r.status !== 'superseded')
    .map((r) => ({ id: r.id, value: r.value as MwValue }));
}

describe('counterexample archive: one source changed at a time', () => {
  it('curved_lanes: smile makes same height != same MW; local rulers carry valid regions', () => {
    const store = seededStore();
    const pipeline = rerun(store);
    expect(pipeline.outcome.kind).toBe('ok');
    // machine-readable judgement recorded
    expect(pipeline.judgements.some((j) => j.code === JUDGEMENT.SMILE_LOCAL_RULER_REQUIRED)).toBe(true);
    const rulers = pipeline.results.filter((r) => r.kind === 'ruler' && r.status === 'ok')
      .map((r) => r.value as { lane_index: number; smile_offset_px: number; valid_region: { y_min: number; y_max: number } });
    expect(rulers.length).toBeGreaterThan(1);
    // every local ruler carries a valid region
    for (const r of rulers) {
      expect(r.valid_region.y_max).toBeGreaterThan(r.valid_region.y_min);
    }
    // smile curvature differs across lanes -> different local offsets
    const offsets = new Set(rulers.map((r) => r.smile_offset_px.toFixed(3)));
    expect(offsets.size).toBeGreaterThan(1);
    // same apparent height in two different lanes => different molecular weight
    const lane1 = rulers.find((r) => r.lane_index === 1)!;
    const lane5 = rulers.find((r) => r.lane_index === 5)!;
    expect(lane1.smile_offset_px).not.toBeCloseTo(lane5.smile_offset_px, 6);
  });

  it('ladder_missing_band: estimates inside the gap segment become intervals', () => {
    const store = seededStore();
    const ladderMat = currentByKind(store, 'band_centers', 'lane-0');
    const raw = ladderMat.raw as { lane_index: number; centers: (BandCenter & { size_bp?: number })[]; unit: string; basis: unknown };
    const pruned = raw.centers.filter((c) => c.size_bp !== 4000);
    store.addMaterial('band_centers', 'lane-0', { ...raw, centers: pruned, amended_from: ladderMat.id });
    const pipeline = rerun(store);
    expect(pipeline.outcome.kind).toBe('ok');
    expect(pipeline.judgements.some((j) => j.code === JUDGEMENT.LADDER_GAP_INTERVAL)).toBe(true);
    const target = mwResults(pipeline.results).find((r) => r.value.band_id === 'b_L1_3500');
    expect(target).toBeDefined();
    expect(target!.value.status).toBe('interval');
    expect(target!.value.reason).toBe('ladder_gap');
    expect(target!.value.interval_bp![0]).toBeLessThan(3500);
    expect(target!.value.interval_bp![1]).toBeGreaterThan(3500);
  });

  it('saturated_region: saturated bands can only be candidates or intervals', () => {
    const store = seededStore();
    const pipeline = rerun(store);
    const sat = mwResults(pipeline.results).find((r) => r.value.band_id === 'b_L2_6000');
    expect(sat).toBeDefined();
    expect(['candidate', 'interval']).toContain(sat!.value.status);
    expect(sat!.value.flags).toContain('saturated');
    expect(sat!.value.mw_bp).toBeUndefined();
    expect(pipeline.judgements.some((j) => j.code === JUDGEMENT.SATURATED_CANDIDATE_ONLY)).toBe(true);
  });

  it('overlapping_bands: overlap resolves only as interval with all legal candidates kept', () => {
    const store = seededStore();
    const pipeline = rerun(store);
    const pair = mwResults(pipeline.results).filter(
      (r) => r.value.band_id === 'b_L4_1180' || r.value.band_id === 'b_L4_1250');
    expect(pair).toHaveLength(2);
    for (const p of pair) {
      expect(p.value.status).toBe('interval');
      expect(p.value.flags).toContain('overlap');
      expect(p.value.candidates_bp!.length).toBe(2);
      // both legal candidates preserved, bracketing the truth
      const [lo, hi] = [...p.value.candidates_bp!].sort((a, b) => a - b);
      expect(lo).toBeLessThan(1250);
      expect(hi).toBeGreaterThan(1180);
    }
    expect(pipeline.judgements.some((j) => j.code === JUDGEMENT.OVERLAP_INTERVAL_ONLY)).toBe(true);
  });

  it('non_monotonic_ruler: semantically unsolvable, distinct from budget and format failures', () => {
    const store = seededStore();
    const ladderMat = currentByKind(store, 'band_centers', 'lane-0');
    const raw = ladderMat.raw as { lane_index: number; centers: (BandCenter & { size_bp?: number })[]; unit: string; basis: unknown };
    const swapped = raw.centers.map((c) => {
      if (c.size_bp === 6000) return { ...c, y: raw.centers.find((d) => d.size_bp === 5000)!.y };
      if (c.size_bp === 5000) return { ...c, y: raw.centers.find((d) => d.size_bp === 6000)!.y };
      return c;
    });
    store.addMaterial('band_centers', 'lane-0', { ...raw, centers: swapped, amended_from: ladderMat.id });
    const pipeline = rerun(store);
    expect(pipeline.outcome.kind).toBe('semantically_unsolvable');
    // three failure kinds are mutually distinct
    expect(pipeline.outcome.kind).not.toBe('budget_exhausted');
    expect(pipeline.outcome.kind).not.toBe('format_corrupt');
    const budgeted = runPipeline(store.listMaterials(), { ...PARAMS_V2, solver_budget: 0 });
    expect(budgeted.outcome.kind).toBe('budget_exhausted');
  });

  it('rotated_image: orientation change invalidates dependents; transformed recompute preserves MW', () => {
    const store = seededStore();
    const before = rerun(store);
    const mwBefore = new Map(mwResults(before.results).map((r) => [r.value.band_id, r.value.mw_bp]));

    const imageMat = currentByKind(store, 'gel_image', 'gel-image');
    const blob = store.getBlob(imageMat.id)!;
    const { width, height, pixels } = decodeGrayPng(blob);
    const rotated = rotate180(pixels, width, height);
    const newPng = encodeGrayPng(width, height, rotated.pixels);
    const imageRaw = imageMat.raw as Record<string, unknown>;
    const newImage = store.addMaterial('gel_image', 'gel-image', {
      ...imageRaw, rotated_from: imageMat.id, png_digest: digest(newPng.toString('base64')),
    }, newPng);
    const orientMat = currentByKind(store, 'capture_orientation', 'orientation');
    const newOrient = store.addMaterial('capture_orientation', 'orientation',
      orientationAfter180(orientMat.raw as { rotation_deg: 0; wells: 'top' }));

    // dependency-scoped invalidation: lane curves depend on orientation+image
    const changed = new Set([imageMat.id, orientMat.id]);
    const invalidated = computeInvalidated(before.results, changed);
    const laneCurveIds = before.results.filter((r) => r.kind === 'lane_curve').map((r) => r.id);
    expect(invalidated).toEqual(expect.arrayContaining(laneCurveIds));

    // transform all band centers into the rotated frame and recompute
    for (const lane of [0, 1, 2, 3, 4, 5]) {
      const mat = currentByKind(store, 'band_centers', `lane-${lane}`);
      const raw = mat.raw as { lane_index: number; centers: BandCenter[]; unit: string; basis: unknown };
      store.addMaterial('band_centers', `lane-${lane}`, {
        ...raw, centers: transformCenters(raw.centers, rotated.transform), amended_from: mat.id,
      });
    }
    const after = runPipeline(store.listMaterials(), PARAMS_V2, store.imageAccess(newImage.id));
    expect(after.outcome.kind).toBe('ok');
    expect(newOrient.kind).toBe('capture_orientation');
    const mwAfter = new Map(mwResults(after.results).map((r) => [r.value.band_id, r.value.mw_bp]));
    for (const [band, mw] of mwBefore) {
      if (mw === undefined) continue;
      expect(mwAfter.get(band)).toBeCloseTo(mw, 6);
    }
  });

  it('revision_local_invalidation: amending one band center invalidates only its dependents', () => {
    const store = seededStore();
    // the case pack already amended lane-3's 2000bp band center
    const amend = store.listEvents().find((e) => e.type === 'source.amended')!;
    const payload = amend.payload as { old_material: string; invalidated_result_ids: string[] };
    expect(payload.invalidated_result_ids.length).toBeGreaterThan(0);
    const all = store.allResults();
    for (const id of payload.invalidated_result_ids) {
      const rows = all.filter((r) => r.id === id);
      expect(rows.some((r) => r.status === 'superseded')).toBe(true);
      // every invalidated result depends on the amended material
      expect(rows[0].parents).toContain(payload.old_material);
    }
    // results depending only on other lanes' materials remain valid
    const current = store.currentResults();
    const lane1 = current.filter((r) => r.kind === 'mw_estimate'
      && (r.value as MwValue).band_id?.startsWith('b_L1_'));
    expect(lane1.length).toBeGreaterThan(0);
    for (const r of lane1) expect(r.status).not.toBe('superseded');
  });

  it('tailing bands are candidates only', () => {
    const store = seededStore();
    const pipeline = rerun(store);
    const tail = mwResults(pipeline.results).find((r) => r.value.band_id === 'b_L5_800');
    expect(tail).toBeDefined();
    expect(['candidate', 'interval']).toContain(tail!.value.status);
    expect(pipeline.judgements.some((j) => j.code === JUDGEMENT.TAILING_CANDIDATE_ONLY)).toBe(true);
  });

  it('keeps pixel-level provenance and units on every domain quantity', () => {
    const store = seededStore();
    const bands = currentByKind(store, 'band_centers', 'lane-1');
    const raw = bands.raw as { centers: BandCenter[]; unit: string; basis: unknown };
    expect(raw.unit).toBe('px');
    expect(raw.basis).toEqual(IMAGE_BASIS);
    for (const c of raw.centers) {
      expect(c.source).toBeTruthy();
      expect(c.basis).toEqual(IMAGE_BASIS);
    }
    const exposure = currentByKind(store, 'exposure', 'exposure');
    expect(exposure.raw).toEqual({ time_ms: 250, gain: 1.0 });
  });
});
