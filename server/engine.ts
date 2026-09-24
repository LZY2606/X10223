import { buildRuler, estimateAt, fitResiduals, Ruler, Estimate, RULER_PARAM_VERSION } from '../shared/calibration.js';
import { classifyBands, BandEvidence, ClassifiedBand, Judgment, BAND_PARAM_VERSION } from '../shared/bands.js';
import { correctedS, localValidRegion, LaneCurve, SmileModel, smileOffset } from '../shared/lanes.js';
import { Diagnostic } from '../shared/result.js';
import { canonicalJson, digestOf, sha256Hex, stableId } from '../shared/hash.js';
import { PxRegion, Quantity } from '../shared/units.js';
import { CaseStore, DerivedRow, MaterialRow } from './store.js';

export interface EngineParams {
  ruler: { gapSpacingRatio: number };
  bands: { saturationLevel: number; minSeparationPx: number; trailingPx: number };
  detect: { threshold: number; minPeakDistancePx: number; maxSamples: number };
  smile: SmileModel;
}

export const DEFAULT_PARAMS: EngineParams = {
  ruler: { gapSpacingRatio: 1.8 },
  bands: { saturationLevel: 255, minSeparationPx: 10, trailingPx: 8 },
  detect: { threshold: 90, minPeakDistancePx: 6, maxSamples: 2000 },
  smile: { a: 18, cx: 180, w: 180 },
};

export function paramVersionOf(params: EngineParams): string {
  return `p_${sha256Hex(canonicalJson(params)).slice(0, 12)}`;
}

export interface BandEstimatePayload {
  bandId: string;
  laneId: string;
  centerPx: { x: number; y: number; space: 'image-px'; imageId: string };
  correctedS: number;
  localValidRegion: PxRegion;
  estimateKind: 'point' | 'interval' | 'candidates';
  classes: string[];
  estimate:
    | { status: 'point'; mw: Quantity; segmentIndex: number }
    | { status: 'interval'; lo: Quantity; hi: Quantity; reason: string }
    | { status: 'candidates'; options: { bandId: string; mw: Quantity }[]; combined: { lo: Quantity; hi: Quantity } }
    | { status: 'out-of-range'; direction: 'above' | 'below'; bound: Quantity }
    | { status: 'unsolvable'; reason: string };
  /** ladder points and interpolation segment this estimate reads back to */
  segment: { index: number; y0: number; y1: number; logMw0: number; logMw1: number } | null;
  unitBasis: string;
}

export interface RecomputeReport {
  branch: string;
  paramVersion: string;
  derivedIds: string[];
  invalidatedIds: string[];
  judgments: Judgment[];
  diagnostics: Diagnostic[];
  rulerOutcome: 'ok' | 'unsolvable';
}

function payloadOf<T>(m: MaterialRow): T {
  return JSON.parse(m.payload) as T;
}

interface OrientationPayload {
  imageId: string;
  wells: string;
  rotationDeg: number;
}

/**
 * Pixel sources are stored in image-px of the stored image. When the
 * acquisition orientation says the image is rotated, sources are normalized
 * into the analysis frame here; the raw materials are never rewritten.
 */
function makeFrameTransform(
  orientation: OrientationPayload | null,
  image: { width: number; height: number },
): { transform: (p: { x: number; y: number }) => { x: number; y: number }; note: string } {
  if (!orientation || orientation.rotationDeg === 0) {
    return { transform: (p) => p, note: 'identity' };
  }
  if (orientation.rotationDeg === 90) {
    // stored image = analysis frame rotated 90deg clockwise
    const hOrig = image.width; // rotated image width == original height
    return { transform: (p) => ({ x: p.y, y: hOrig - 1 - p.x }), note: 'undo-90cw' };
  }
  return { transform: (p) => p, note: `unsupported-rotation-${orientation.rotationDeg}` };
}

/**
 * Recompute all derived records for a branch from its CURRENT materials.
 * Every derived record carries input digest, parameter version and parents.
 * Only subjects whose inputs changed get new identities; stale records for
 * those subjects are retired by an invalidation EVENT (local invalidation).
 */
export function recompute(store: CaseStore, branch: string, causeEventId?: string): RecomputeReport {
  const params: EngineParams = JSON.parse(store.getMeta('params') ?? 'null') ?? DEFAULT_PARAMS;
  const paramVersion = paramVersionOf(params);
  const mats = store.currentMaterials(branch);
  const byKind = (k: string) => mats.filter((m) => m.kind === k);

  const diagnostics: Diagnostic[] = [];
  const judgments: Judgment[] = [];
  const derivedIds: string[] = [];

  const image = byKind('image')[0];
  const orientationMat = byKind('orientation')[0] ?? null;
  const ladder = byKind('ladder')[0];
  const laneMats = byKind('lane-boundary');
  const bandMats = byKind('band-center');

  const imageMeta = image ? payloadOf<{ width: number; height: number }>(image) : { width: 0, height: 0 };
  const orientation = orientationMat ? payloadOf<OrientationPayload>(orientationMat) : null;
  const frame = makeFrameTransform(orientation, imageMeta);
  if (frame.note.startsWith('unsupported')) {
    diagnostics.push({
      code: 'ORIENTATION_UNSUPPORTED',
      message: `rotation ${orientation?.rotationDeg} not supported; sources left in stored frame`,
      at: { materialId: orientationMat?.id },
    });
  }

  const put = (
    kind: string,
    subject: string,
    parents: MaterialRow[],
    payload: unknown,
  ): DerivedRow => {
    const parentIds = parents.map((p) => p.id).sort();
    const inputDigest = digestOf({ parents: parents.map((p) => p.digest).sort(), params });
    const id = stableId('drv', kind, subject, branch, inputDigest, paramVersion);
    const row = store.putDerived({
      id, kind, subject, branch,
      input_digest: inputDigest,
      param_version: paramVersion,
      parents: canonicalJson(parentIds),
      payload: canonicalJson(payload),
    });
    derivedIds.push(row.id);
    return row;
  };

  let rulerOutcome: 'ok' | 'unsolvable' = 'ok';
  let ruler: Ruler | null = null;
  let ladderX = 0;

  if (!image || !ladder) {
    diagnostics.push({
      code: 'INPUT_INCOMPLETE',
      message: `branch ${branch} is missing ${!image ? 'image' : 'ladder'} material; no defaults fabricated`,
      at: { materialId: !image ? undefined : ladder!.id },
    });
    rulerOutcome = 'unsolvable';
  } else {
    const ladderPayload = payloadOf<{ laneId: string; imageId: string; points: { x: number; y: number; raw: string }[] }>(ladder);
    const analysisPoints = ladderPayload.points.map((p) => ({ y: frame.transform(p).y, raw: p.raw }));
    const ladderLane = laneMats.find((m) => payloadOf<{ laneId: string }>(m).laneId === ladderPayload.laneId);
    const outcome = buildRuler(ladderPayload.laneId, ladderPayload.imageId, analysisPoints, params.ruler);
    if (outcome.kind !== 'ok') {
      rulerOutcome = 'unsolvable';
      diagnostics.push(outcome.diagnostic);
      put('ruler', ladderPayload.laneId, [ladder, image], {
        outcome: outcome.kind,
        diagnostic: outcome.diagnostic,
        ruleVersion: RULER_PARAM_VERSION,
      });
    } else {
      ruler = outcome.value;
      diagnostics.push(...outcome.diagnostics);
      if (ladderLane) {
        const curve = payloadOf<LaneCurve & { laneId: string }>(ladderLane);
        ladderX = curve.centerline.reduce((a, p) => a + frame.transform(p).x, 0) / curve.centerline.length;
      }
      put('ruler', ladderPayload.laneId, [ladder, image], {
        outcome: 'ok',
        ruleVersion: RULER_PARAM_VERSION,
        points: ruler.points,
        segments: ruler.segments,
        validRegion: ruler.validRegion,
        residuals: fitResiduals(ruler),
        smile: params.smile,
        frame: frame.note,
      });
    }
  }

  // band estimates per lane (revised band-centers win over auto for estimates)
  const byLane = new Map<string, MaterialRow[]>();
  for (const bm of bandMats) {
    const laneId = payloadOf<{ laneId: string }>(bm).laneId;
    byLane.set(laneId, [...(byLane.get(laneId) ?? []), bm]);
  }

  for (const [laneId, rows] of [...byLane.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const laneMat = laneMats.find((m) => payloadOf<{ laneId: string }>(m).laneId === laneId);
    if (!laneMat) {
      diagnostics.push({ code: 'INPUT_INCOMPLETE', message: `lane ${laneId} has band centers but no lane boundary`, at: { laneId } });
      continue;
    }
    const revised = rows.find((r) => payloadOf<{ source: string }>(r).source === 'revised');
    const auto = rows.find((r) => payloadOf<{ source: string }>(r).source === 'auto');
    const chosen = revised ?? auto!;
    const chosenPayload = payloadOf<{ imageId: string; bands: BandEvidence[] }>(chosen);
    const analysisBands = chosenPayload.bands.map((b) => ({
      ...b,
      center: { ...b.center, ...frame.transform(b.center) },
      contour: b.contour.map((p) => ({ ...p, ...frame.transform(p) })),
    }));
    const laneCurveRaw = payloadOf<LaneCurve>(laneMat);
    const laneCurve: LaneCurve = {
      ...laneCurveRaw,
      centerline: laneCurveRaw.centerline.map((p) => ({ ...p, ...frame.transform(p) })),
    };
    const laneX = laneCurve.centerline.reduce((a, p) => a + p.x, 0) / laneCurve.centerline.length;

    const { bands: classified, judgments: laneJudgments, diagnostics: bandDiags } = classifyBands(
      analysisBands,
      params.bands,
    );
    judgments.push(...laneJudgments);
    diagnostics.push(...bandDiags);

    // comparison of automatic candidates vs human revision (when both exist)
    if (auto && revised) {
      const autoBands = payloadOf<{ bands: BandEvidence[] }>(auto).bands;
      const revisedBands = payloadOf<{ bands: BandEvidence[] }>(revised).bands;
      const deltas = revisedBands.map((rb) => {
        const nearest = autoBands
          .map((ab) => ({ ab, d: Math.abs(ab.center.y - rb.center.y) }))
          .sort((a, b) => a.d - b.d)[0];
        return {
          revisedBandId: rb.id,
          autoBandId: nearest?.ab.id ?? null,
          deltaYPx: nearest ? rb.center.y - nearest.ab.center.y : null,
        };
      });
      put('comparison', laneId, [auto, revised], { laneId, deltas, ruleVersion: BAND_PARAM_VERSION });
    }

    if (!ruler) {
      put('estimates', laneId, [chosen, laneMat], {
        laneId,
        outcome: 'unsolvable',
        reason: 'ruler unavailable',
        estimates: [],
      });
      continue;
    }

    const region = localValidRegion(ruler, laneX, ladderX, params.smile);
    const estimates: BandEstimatePayload[] = classified.map((band: ClassifiedBand) => {
      const s = correctedS(band.center.y, band.center.x, params.smile);
      const base = estimateAt(ruler, s);
      const seg = base.status === 'point' ? ruler!.segments[base.segmentIndex]! : null;
      let estimate: BandEstimatePayload['estimate'];
      if (base.status === 'out-of-range') {
        estimate = { status: 'out-of-range', direction: base.direction, bound: base.bound };
      } else if (base.status === 'unsolvable') {
        estimate = { status: 'unsolvable', reason: base.reason };
      } else if (band.estimateKind === 'point') {
        estimate = { status: 'point', mw: base.mw, segmentIndex: base.segmentIndex };
      } else if (band.estimateKind === 'interval') {
        const half = Math.max(1, Math.round((band.contour[2]!.y - band.contour[0]!.y) / 2));
        const loEst = estimateAt(ruler!, correctedS(band.center.y + half, band.center.x, params.smile));
        const hiEst = estimateAt(ruler!, correctedS(band.center.y - half, band.center.x, params.smile));
        const lo = loEst.status === 'point' ? loEst.mw : base.mw;
        const hi = hiEst.status === 'point' ? hiEst.mw : base.mw;
        estimate = {
          status: 'interval',
          lo: { value: Math.min(lo.value, hi.value), unit: base.mw.unit },
          hi: { value: Math.max(lo.value, hi.value), unit: base.mw.unit },
          reason: band.classes.join('+'),
        };
      } else {
        // overlap: keep ALL legal candidates plus the combined interval
        const group = classified.filter(
          (other) =>
            other.laneId === band.laneId &&
            Math.abs(other.center.y - band.center.y) < params.bands.minSeparationPx,
        );
        const options = group.map((g) => {
          const e = estimateAt(ruler!, correctedS(g.center.y, g.center.x, params.smile));
          return { bandId: g.id, mw: e.status === 'point' ? e.mw : base.mw };
        });
        const values = options.map((o) => o.mw.value);
        estimate = {
          status: 'candidates',
          options,
          combined: {
            lo: { value: Math.min(...values), unit: base.mw.unit },
            hi: { value: Math.max(...values), unit: base.mw.unit },
          },
        };
      }
      return {
        bandId: band.id,
        laneId,
        centerPx: band.center,
        correctedS: s,
        localValidRegion: region,
        estimateKind: band.estimateKind,
        classes: band.classes,
        estimate,
        segment: seg ? { index: seg.index, y0: seg.y0, y1: seg.y1, logMw0: seg.logMw0, logMw1: seg.logMw1 } : null,
        unitBasis: `log10(${base.status === 'point' ? base.mw.unit : 'bp'}) vs image-px; smile offset at lane x=${laneX.toFixed(1)} is ${smileOffset(params.smile, laneX).toFixed(2)}px`,
      };
    });
    put('estimates', laneId, [chosen, laneMat, ladder!, image!], {
      laneId,
      outcome: 'ok',
      localValidRegion: region,
      estimates,
      frame: frame.note,
      ruleVersions: { ruler: RULER_PARAM_VERSION, bands: BAND_PARAM_VERSION },
    });
  }

  // local invalidation: retire visible derived rows for subjects whose inputs changed
  const visible = store.derivedVisible(branch);
  const stale = visible.filter((d) => !derivedIds.includes(d.id));
  let invalidatedIds: string[] = [];
  if (stale.length > 0) {
    const ev = store.invalidateDerived(
      stale.map((d) => d.id),
      branch,
      `superseded by recompute at param ${paramVersion}`,
      causeEventId ? [causeEventId] : [],
    );
    invalidatedIds = stale.map((d) => d.id);
    void ev;
  }

  // machine-readable judgment events (idempotent)
  for (const j of judgments) {
    store.appendEvent('judgment', branch, { ...j, paramVersion }, { status: 'accepted' });
  }

  return { branch, paramVersion, derivedIds, invalidatedIds, judgments, diagnostics, rulerOutcome };
}
