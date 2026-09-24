/** Shared domain types. All domain quantities carry a unit or a coordinate basis. */

export interface Diagnostic {
  code: string;
  /** Location of the offending input, e.g. "lanes[2].bands[0].center". */
  path: string;
  message: string;
  objectIds: string[];
}

export interface PixelPoint {
  x: number;
  y: number;
  basis: "image-pixel";
  /** Material id of the gel image this point refers to. */
  image: string;
}

export interface Quantity {
  value: number;
  unit: string;
  /** Original representation exactly as imported; never rewritten. */
  raw?: string;
}

export interface MaterialRow {
  id: string;
  projectId: string;
  kind: string;
  payload: Record<string, unknown>;
  digest: string;
  createdSeq: number;
}

export interface EventRow {
  projectId: string;
  seq: number;
  id: string;
  type: string;
  payload: Record<string, unknown>;
  parents: string[];
  createdAt: string;
}

export interface DerivedRow {
  id: string;
  projectId: string;
  slot: string;
  rule: string;
  ruleVersion: string;
  inputDigest: string;
  parents: string[];
  status: string;
  payload: Record<string, unknown>;
  createdSeq: number;
  supersededBy: string | null;
}

export interface Params {
  ruleVersion: string;
  interp: string;
  saturationThreshold: number;
  maxBands: number;
  maxOps: number;
}

export const DEFAULT_PARAMS: Params = {
  ruleVersion: "ruler.v1",
  interp: "log-linear-global",
  saturationThreshold: 0.98,
  maxBands: 500,
  maxOps: 200000,
};

export const PARAMS_RULE = "gel-ruler-params";
export const RULER_V2 = "ruler.v2";
