import { Diagnostic } from '../../shared/quantity';
import { PixelSource } from './lanes';

export interface BandEvidence {
  bandId: string;
  laneId: string;
  centerX: number; // image px
  centerY: number; // image px
  halfHeightPx: number;
  contour: [number, number][]; // px polygon, image space
  saturatedFraction: number; // 0..1 of pixels clipped at max intensity
  asymmetry: number; // |lowerSigma - upperSigma| / (lowerSigma + upperSigma)
  peakIntensity: number; // 0..255
  pixelSource: PixelSource;
}

export interface BandParams {
  version: string;
  saturationThreshold: number; // fraction at/above which a band is candidate-only
  tailingAsymmetry: number; // asymmetry at/above which a band is candidate-only
  overlapMarginPx: number; // center distance margin for overlap grouping
}

export interface BandAssessment {
  bandId: string;
  verdict: 'decisive' | 'candidate-only';
  reasons: Diagnostic[];
}

// Saturated, tailing or otherwise compromised bands may only ever be marked
// as candidates or intervals -- never as decisive point estimates.
export function assessBand(band: BandEvidence, params: BandParams): BandAssessment {
  const reasons: Diagnostic[] = [];
  if (band.saturatedFraction >= params.saturationThreshold) {
    reasons.push({
      code: 'SATURATED_BAND',
      message: `band ${band.bandId} has ${(band.saturatedFraction * 100).toFixed(1)}% saturated pixels (>= ${params.saturationThreshold * 100}%); center is a candidate only`,
      position: `$.bands[bandId=${band.bandId}].saturatedFraction`,
      severity: 'warning',
    });
  }
  if (band.asymmetry >= params.tailingAsymmetry) {
    reasons.push({
      code: 'TAILING_BAND',
      message: `band ${band.bandId} shows tailing (asymmetry ${band.asymmetry.toFixed(2)}); center is a candidate only`,
      position: `$.bands[bandId=${band.bandId}].asymmetry`,
      severity: 'warning',
    });
  }
  return { bandId: band.bandId, verdict: reasons.length > 0 ? 'candidate-only' : 'decisive', reasons };
}

export interface OverlapCandidate {
  kind: 'merged-single' | 'two-component';
  label: string;
  memberBandIds: string[];
  centerYPx: number[]; // one center per proposed component
}

export interface OverlapGroup {
  groupId: string;
  memberBandIds: string[];
  candidates: OverlapCandidate[]; // ALL legal candidates retained when not uniquely decidable
  diagnostic: Diagnostic;
}

// Two bands whose vertical extents interlock within the margin cannot be
// uniquely separated: keep every legal candidate decomposition.
export function detectOverlaps(bands: BandEvidence[], params: BandParams): OverlapGroup[] {
  const groups: OverlapGroup[] = [];
  const byLane = new Map<string, BandEvidence[]>();
  for (const b of bands) {
    const list = byLane.get(b.laneId) ?? [];
    list.push(b);
    byLane.set(b.laneId, list);
  }
  for (const [, list] of byLane) {
    const sorted = [...list].sort((a, b) => a.centerY - b.centerY);
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1];
      const cur = sorted[i];
      const gap = cur.centerY - cur.halfHeightPx - (prev.centerY + prev.halfHeightPx);
      if (gap < params.overlapMarginPx) {
        const weightedY =
          (prev.centerY * prev.peakIntensity + cur.centerY * cur.peakIntensity) /
          Math.max(1e-9, prev.peakIntensity + cur.peakIntensity);
        groups.push({
          groupId: `overlap:${prev.bandId}+${cur.bandId}`,
          memberBandIds: [prev.bandId, cur.bandId],
          candidates: [
            { kind: 'merged-single', label: 'single merged band (interval only)', memberBandIds: [prev.bandId, cur.bandId], centerYPx: [weightedY] },
            { kind: 'two-component', label: 'two overlapping components', memberBandIds: [prev.bandId, cur.bandId], centerYPx: [prev.centerY, cur.centerY] },
          ],
          diagnostic: {
            code: 'OVERLAPPING_BANDS',
            message: `bands ${prev.bandId} and ${cur.bandId} overlap (gap ${gap.toFixed(1)}px < margin ${params.overlapMarginPx}px); not uniquely decidable, all candidates retained`,
            position: `$.bands[bandId=${prev.bandId},${cur.bandId}]`,
            severity: 'warning',
          },
        });
      }
    }
  }
  return groups;
}
