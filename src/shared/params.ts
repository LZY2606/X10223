import { contentId } from "./ids.js";

export const RULE_PACK_VERSION = "gel-rulepack-1.0.0";

export interface ParamPack {
  version: string;
  saturationIntensity: number;
  tailSkewRatio: number;
  overlapSeparationPx: number;
  bandDetectionThreshold: number;
  centerUncertaintyPx: number;
  allowExtrapolation: boolean;
  model: "log-linear-global" | "log-linear-piecewise";
  anchorArcTolerancePx: number;
  migrationIntercept: number;
  migrationLogBase: number;
  migrationSlope: number;
  migrationTolerancePx: number;
}

export const DEFAULT_PARAMS: ParamPack = {
  version: "params-1.0.0",
  saturationIntensity: 255,
  tailSkewRatio: 1.6,
  overlapSeparationPx: 10,
  bandDetectionThreshold: 0.22,
  centerUncertaintyPx: 1.5,
  allowExtrapolation: false,
  model: "log-linear-piecewise",
  anchorArcTolerancePx: 4,
  migrationIntercept: 40,
  migrationLogBase: 4,
  migrationSlope: 150,
  migrationTolerancePx: 26
};

export function paramsWithVersion(patch: Partial<ParamPack>): ParamPack {
  const next = { ...DEFAULT_PARAMS, ...patch };
  const { version: _omit, ...core } = next;
  next.version = contentId("params", core);
  return next;
}

export function reviseParams(base: ParamPack, patch: Partial<ParamPack>): ParamPack {
  return paramsWithVersion({ ...base, ...patch, version: undefined } as Partial<ParamPack>);
}

export function paramsDigest(p: ParamPack): string {
  const { version: _omit, ...core } = p;
  return contentId("params", core);
}
