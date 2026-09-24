import { PxPoint } from './units.js';
import { Diagnostic } from './result.js';

/**
 * Band evidence. Saturated, trailing and overlapping bands may only ever be
 * reported as candidates or intervals — never as point estimates.
 */

export interface BandEvidence {
  id: string;
  laneId: string;
  center: PxPoint;
  contour: PxPoint[];
  maxIntensity: number; // 0..255
  /** vertical tail length below the peak, px */
  tailPx: number;
  source: 'auto' | 'revised';
}

export type BandClass = 'clean' | 'saturated' | 'overlap' | 'trailing';

export interface ClassifiedBand extends BandEvidence {
  classes: BandClass[];
  /** point estimates are only legal for clean bands */
  estimateKind: 'point' | 'interval' | 'candidates';
}

export interface Judgment {
  code: 'SATURATION_CANDIDATE_ONLY' | 'OVERLAP_INTERVAL_ONLY' | 'TRAILING_CANDIDATE_ONLY';
  basis: string;
  rule: string;
  affected: string[]; // band ids
}

export interface ClassifyParams {
  saturationLevel: number; // intensity at/above which a band is saturated
  minSeparationPx: number; // centers closer than this overlap
  trailingPx: number; // tail longer than this is trailing
}

export const BAND_PARAM_VERSION = 'bands.classify.v1';

export function classifyBands(
  bands: BandEvidence[],
  params: ClassifyParams,
): { bands: ClassifiedBand[]; judgments: Judgment[]; diagnostics: Diagnostic[] } {
  const judgments: Judgment[] = [];
  const diagnostics: Diagnostic[] = [];
  // stable order: by lane then pixel y
  const sorted = [...bands].sort((a, b) =>
    a.laneId === b.laneId ? a.center.y - b.center.y : a.laneId.localeCompare(b.laneId),
  );

  const overlapGroups = new Map<string, string[]>();
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      const a = sorted[i]!;
      const b = sorted[j]!;
      if (a.laneId !== b.laneId) continue;
      if (Math.abs(a.center.y - b.center.y) < params.minSeparationPx) {
        overlapGroups.set(a.id, [...(overlapGroups.get(a.id) ?? []), b.id]);
        overlapGroups.set(b.id, [...(overlapGroups.get(b.id) ?? []), a.id]);
      }
    }
  }

  const classified: ClassifiedBand[] = sorted.map((band) => {
    const classes: BandClass[] = [];
    if (band.maxIntensity >= params.saturationLevel) classes.push('saturated');
    if (overlapGroups.has(band.id)) classes.push('overlap');
    if (band.tailPx > params.trailingPx) classes.push('trailing');
    const estimateKind: ClassifiedBand['estimateKind'] =
      classes.length === 0 ? 'point' : classes.includes('overlap') ? 'candidates' : 'interval';
    return { ...band, classes, estimateKind };
  });

  const saturated = classified.filter((b) => b.classes.includes('saturated'));
  if (saturated.length > 0) {
    judgments.push({
      code: 'SATURATION_CANDIDATE_ONLY',
      basis: 'pixel intensity clipped at detector maximum; band center may be biased',
      rule: 'saturated bands may only be reported as candidates or intervals',
      affected: saturated.map((b) => b.id),
    });
    for (const b of saturated) {
      diagnostics.push({
        code: 'SATURATED_BAND',
        message: `band ${b.id} maxIntensity=${b.maxIntensity} >= ${params.saturationLevel}; interval only`,
        at: { laneId: b.laneId, y: b.center.y },
      });
    }
  }
  const overlapped = classified.filter((b) => b.classes.includes('overlap'));
  if (overlapped.length > 0) {
    judgments.push({
      code: 'OVERLAP_INTERVAL_ONLY',
      basis: 'two band centers closer than optical resolution; not uniquely separable',
      rule: 'overlapping bands keep all legal candidates and a combined interval',
      affected: overlapped.map((b) => b.id),
    });
  }
  const trailing = classified.filter((b) => b.classes.includes('trailing'));
  if (trailing.length > 0) {
    judgments.push({
      code: 'TRAILING_CANDIDATE_ONLY',
      basis: 'band tail exceeds threshold; centroid is not a reliable center',
      rule: 'trailing bands may only be reported as candidates or intervals',
      affected: trailing.map((b) => b.id),
    });
  }
  return { bands: classified, judgments, diagnostics };
}
