import type { Quantity } from "./units.ts";

export type BandStatus = "accepted" | "candidate" | "interval" | "rejected";

export interface BandEvidence {
  id: string;
  laneId: string;
  /** band center with pixel-level provenance (basis image-raw) */
  center: Quantity;      // y coordinate, px
  centerX: Quantity;     // x coordinate, px
  maxIntensity: number;
  saturationThreshold: number;
  trailingScore: number; // 0..1 asymmetry of the band profile
}

export interface BandClassification {
  status: BandStatus;
  reasons: string[];
  /** for overlaps: ids of all legal alternative explanations */
  overlapGroup: string[];
}

export const MIN_BAND_SEPARATION_PX = 10;

/**
 * Degraded-evidence rule (machine-readable):
 * saturated, trailing or overlapping bands may ONLY ever be marked
 * `candidate` or `interval` — never a clean accepted point estimate.
 */
export function classifyBand(ev: BandEvidence, neighbors: BandEvidence[]): BandClassification {
  const reasons: string[] = [];
  let status: BandStatus = "accepted";
  const overlapGroup: string[] = [];
  if (ev.maxIntensity >= ev.saturationThreshold) {
    status = "candidate";
    reasons.push("saturated");
  }
  if (ev.trailingScore > 0.5) {
    status = "candidate";
    reasons.push("trailing");
  }
  for (const other of neighbors) {
    if (other.id === ev.id || other.laneId !== ev.laneId) continue;
    const dy = Math.abs(other.center.value - ev.center.value);
    if (dy < MIN_BAND_SEPARATION_PX) {
      status = "interval";
      reasons.push("overlap");
      overlapGroup.push(other.id);
    }
  }
  return { status, reasons, overlapGroup: overlapGroup.sort() };
}
