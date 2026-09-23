import type { LaneCurve } from "./geometry.ts";
import { smileOffset } from "./geometry.ts";
import type { Ruler } from "./ruler.ts";
import { evalRuler } from "./ruler.ts";
import type { BandEvidence, BandClassification } from "./bands.ts";

export type InferenceValue =
  | { kind: "point"; mw: number; logMw: number; unit: "bp"; residual: number }
  | { kind: "interval"; lo: number; hi: number; unit: "bp"; reason: string }
  | { kind: "candidates"; options: number[]; unit: "bp"; reason: string };

export interface Inference {
  bandId: string;
  laneId: string;
  /** effective migration distance after smile correction, px, basis image-norm */
  dEff: number;
  smileCorrection: number;
  validRegion: { dMin: number; dMax: number; unit: "px"; basis: "image-norm" };
  status: BandClassification["status"];
  reasons: string[];
  value: InferenceValue;
}

/**
 * Infer molecular weight for one band on one lane using that lane's LOCAL ruler.
 * The smile correction makes "same height != same molecular weight" explicit:
 * d_eff = y_norm - smileOffset(laneCurve, y_norm).
 */
export function inferMw(band: BandEvidence, cls: BandClassification, curve: LaneCurve, ruler: Ruler, yNorm: number): Inference {
  const corr = smileOffset(curve, yNorm);
  const dEff = yNorm - corr;
  const validRegion = { dMin: ruler.dMin, dMax: ruler.dMax, unit: "px" as const, basis: "image-norm" as const };
  const ev = evalRuler(ruler, dEff);
  let value: InferenceValue;
  if (cls.status === "interval" && cls.reasons.includes("overlap")) {
    // overlapping bands: keep every legal candidate, never collapse to one number
    const options = [dEff - 3, dEff, dEff + 3].map((d) => {
      const e = evalRuler(ruler, Math.min(Math.max(d, ruler.dMin), ruler.dMax));
      return e.kind === "point" ? e.mw : e.lo;
    });
    value = { kind: "candidates", options, unit: "bp", reason: "overlap" };
  } else if (cls.status === "candidate") {
    value = ev.kind === "point"
      ? { kind: "candidates", options: [ev.mw], unit: "bp", reason: cls.reasons.join("+") }
      : { kind: "interval", lo: ev.lo, hi: ev.hi, unit: "bp", reason: ev.reason };
  } else if (ev.kind === "interval") {
    value = { kind: "interval", lo: ev.lo, hi: ev.hi, unit: "bp", reason: ev.reason };
  } else {
    const residual = ruler.residuals.reduce((s, r) => s + r * r, 0) / ruler.residuals.length;
    value = { kind: "point", mw: ev.mw, logMw: ev.logMw, unit: "bp", residual: Math.sqrt(residual) };
  }
  return { bandId: band.id, laneId: band.laneId, dEff, smileCorrection: corr, validRegion, status: cls.status, reasons: cls.reasons, value };
}
