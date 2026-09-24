import { encodePngGray8 } from './png.js';
import { CaseStore } from './store.js';
import { recompute, DEFAULT_PARAMS, paramVersionOf, RecomputeReport } from './engine.js';
import { detectBands, DETECT_PARAM_VERSION, GrayImage } from '../shared/detect.js';
import { canonicalJson, sha256Hex } from '../shared/hash.js';
import { BandEvidence } from '../shared/bands.js';
import { PxPoint } from '../shared/units.js';
import {
  CASE, LANES, LADDER_NOMINAL, UNKNOWN_BAND_Y, SAMPLE_BANDS,
  bandImageY, laneCurveOf, renderBaseImage, centerlineX,
} from './casepack.js';
import { runAllScenarios } from './scenarios.js';

export const CASE_PACK_VERSION = 'gel-ruler-casepack.v1';
export const MAIN_BRANCH = 'main';

function addImageMaterial(store: CaseStore, branch: string, imageId: string, img: GrayImage, eventId: string) {
  const png = encodePngGray8(img.width, img.height, img.pixels);
  return store.addMaterial(
    'image',
    branch,
    {
      imageId,
      width: img.width,
      height: img.height,
      format: 'png-gray8',
      sha256: sha256Hex(png),
      pixelBasis: 'image-px, origin top-left, y increases with migration',
    },
    { blob: png, createdByEvent: eventId },
  );
}

function addLaneMaterials(store: CaseStore, branch: string, imageId: string, eventId: string) {
  const ids: string[] = [];
  for (const lane of LANES) {
    const curve = laneCurveOf(lane, imageId);
    const row = store.addMaterial(
      'lane-boundary',
      branch,
      {
        laneId: lane.laneId,
        imageId,
        centerline: curve.centerline,
        halfWidth: curve.halfWidth,
        source: { basis: 'image-px', markedBy: 'operator', tool: 'lane-picker.v2' },
      },
      { createdByEvent: eventId },
    );
    ids.push(row.id);
  }
  return ids;
}

function ladderPayload(imageId: string) {
  const points = LADDER_NOMINAL.map(({ mw, raw }) => ({
    x: 60,
    y: bandImageY(LANES[0]!, mw),
    raw,
  }));
  // unconvertible nominal kept raw at its own position
  points.splice(1, 0, { x: 60, y: UNKNOWN_BAND_Y, raw: 'unknown' });
  return { laneId: 'ladder', imageId, unitBasis: 'nominal strings as imported', points };
}

function detectLaneBands(store: CaseStore, branch: string, image: GrayImage, imageId: string, eventId: string) {
  const ids: Record<string, string> = {};
  for (const lane of LANES) {
    if (lane.laneId === 'ladder') continue;
    const curve = laneCurveOf(lane, imageId);
    const outcome = detectBands(image, curve, DEFAULT_PARAMS.detect);
    if (outcome.kind !== 'ok') throw new Error(`detection failed for ${lane.laneId}`);
    const row = store.addMaterial(
      'band-center',
      branch,
      {
        laneId: lane.laneId,
        imageId,
        source: 'auto',
        detector: DETECT_PARAM_VERSION,
        bands: outcome.value,
      },
      { createdByEvent: eventId },
    );
    ids[lane.laneId] = row.id;
  }
  return ids;
}

function mkPx(x: number, y: number, imageId: string): PxPoint {
  return { x, y, space: 'image-px', imageId };
}

/** human revision: split the merged overlap in lane3, shift the saturated center in lane2 */
function revisedBandMaterials(
  store: CaseStore,
  branch: string,
  imageId: string,
  autoIds: Record<string, string>,
  eventId: string,
) {
  const lane2Auto = JSON.parse(store.getMaterial(autoIds['lane2']!)!.payload) as { bands: BandEvidence[] };
  const lane2Bands: BandEvidence[] = lane2Auto.bands.map((b) =>
    b.maxIntensity >= 255 ? { ...b, id: b.id + '_rev', center: mkPx(b.center.x, b.center.y + 2, imageId), source: 'revised' as const } : { ...b, source: 'revised' as const },
  );
  store.addMaterial(
    'band-center',
    branch,
    { laneId: 'lane2', imageId, source: 'revised', revisionOf: autoIds['lane2'], bands: lane2Bands },
    { createdByEvent: eventId },
  );

  const lane3Auto = JSON.parse(store.getMaterial(autoIds['lane3']!)!.payload) as { bands: BandEvidence[] };
  const merged = lane3Auto.bands.find((b) => b.center.y > 180 && b.center.y < 220)!;
  const others = lane3Auto.bands.filter((b) => b !== merged);
  const split: BandEvidence[] = [196.8, 200.6].map((y, i) => ({
    ...merged,
    id: `${merged.id}_split${i}`,
    center: mkPx(240, y, imageId),
    contour: [mkPx(233, y - 2, imageId), mkPx(247, y - 2, imageId), mkPx(247, y + 2, imageId), mkPx(233, y + 2, imageId)],
    source: 'revised' as const,
  }));
  store.addMaterial(
    'band-center',
    branch,
    {
      laneId: 'lane3',
      imageId,
      source: 'revised',
      revisionOf: autoIds['lane3'],
      bands: [...others.map((b) => ({ ...b, source: 'revised' as const })), ...split],
    },
    { createdByEvent: eventId },
  );
}

export interface BaselineResult {
  imageId: string;
  autoBandMaterialIds: Record<string, string>;
  reports: RecomputeReport[];
}

export function seedBaseline(store: CaseStore, branch: string = MAIN_BRANCH): BaselineResult {
  store.ensureBranch(branch);
  store.setMeta('params', canonicalJson(DEFAULT_PARAMS));
  const reports: RecomputeReport[] = [];
  const imageId = CASE.imageId;

  // 1. import: immutable materials with pixel-level sources
  const evtImport = store.appendEvent('import-materials', branch, {
    note: '原图、拍摄方向、曝光、ladder 标称值、lane 边界与条带中心均保留像素级来源',
    casePack: CASE_PACK_VERSION,
  });
  const image = renderBaseImage();
  addImageMaterial(store, branch, imageId, image, evtImport.id);
  store.addMaterial('orientation', branch, { imageId, wells: 'top', rotationDeg: 0, basis: 'image-px' }, { createdByEvent: evtImport.id });
  store.addMaterial('exposure', branch, { imageId, ms: 120, gain: 2.0, unit: 'ms' }, { createdByEvent: evtImport.id });
  store.addMaterial('ladder', branch, ladderPayload(imageId), { createdByEvent: evtImport.id });
  addLaneMaterials(store, branch, imageId, evtImport.id);

  // 2. automatic candidates
  const evtDetect = store.appendEvent('auto-detect', branch, {
    detector: DETECT_PARAM_VERSION,
    params: DEFAULT_PARAMS.detect,
    budget: { maxSamples: DEFAULT_PARAMS.detect.maxSamples },
  }, { parents: [evtImport.id] });
  const autoIds = detectLaneBands(store, branch, image, imageId, evtDetect.id);

  // 3. human revision of band centers
  const evtRevise = store.appendEvent('source-change', branch, {
    what: 'band-center revision: split merged overlap in lane3, shift saturated center in lane2',
    scope: ['lane2', 'lane3'],
  }, { parents: [evtDetect.id] });
  revisedBandMaterials(store, branch, imageId, autoIds, evtRevise.id);

  reports.push(recompute(store, branch, evtRevise.id));

  // 4. reviewer accepts lane1 point estimates
  store.appendEvent('decision', branch, {
    subject: 'lane1',
    action: 'accept',
    rationale: 'clean bands inside valid region; point estimates accepted',
    decidedBy: 'reviewer-a',
    decidedAt: '2026-09-19T10:00:00Z',
  }, { parents: [evtRevise.id] });

  // 5. parameter revision (bumps parameter version, recomputes)
  const revised = { ...DEFAULT_PARAMS, bands: { ...DEFAULT_PARAMS.bands, minSeparationPx: 12 } };
  const evtParams = store.appendEvent('param-revision', branch, {
    from: paramVersionOf(DEFAULT_PARAMS),
    to: paramVersionOf(revised),
    patch: { 'bands.minSeparationPx': [10, 12] },
  }, { parents: [evtRevise.id] });
  store.setMeta('params', canonicalJson(revised));
  reports.push(recompute(store, branch, evtParams.id));

  // 6. local source change: only lane3 boundary is redrawn
  const lane3 = LANES.find((l) => l.laneId === 'lane3')!;
  const oldBoundary = store
    .currentMaterials(branch)
    .find((m) => m.kind === 'lane-boundary' && JSON.parse(m.payload).laneId === 'lane3')!;
  const evtLocal = store.appendEvent('source-change', branch, {
    what: 'lane3 boundary redrawn (halfWidth 8 -> 7)',
    scope: ['lane3'],
  }, { parents: [evtParams.id] });
  const curve = laneCurveOf(lane3, imageId);
  store.addMaterial(
    'lane-boundary',
    branch,
    { laneId: 'lane3', imageId, centerline: curve.centerline, halfWidth: 7, source: { basis: 'image-px', markedBy: 'reviewer-b', tool: 'lane-picker.v2' } },
    { createdByEvent: evtLocal.id, supersedes: oldBoundary.id },
  );
  reports.push(recompute(store, branch, evtLocal.id));

  // 7. conflicting human decision on the overlap candidates (main branch side)
  store.appendEvent('decision', branch, {
    subject: 'lane3',
    action: 'accept-candidate',
    candidate: 'split0',
    rationale: 'reviewer-a picks the upper of the two overlapping candidates',
    decidedBy: 'reviewer-a',
    decidedAt: '2026-09-19T11:00:00Z',
  }, { parents: [evtLocal.id] });

  return { imageId, autoBandMaterialIds: autoIds, reports };
}

export function seedAll(store: CaseStore): void {
  if (store.getMeta('seeded') === CASE_PACK_VERSION) return;
  seedBaseline(store, MAIN_BRANCH);
  runAllScenarios(store);
  store.setMeta('seeded', CASE_PACK_VERSION);
}

export { SAMPLE_BANDS, centerlineX };
