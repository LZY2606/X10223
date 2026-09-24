/**
 * 机器可读取的判断事件负载。
 * 规则判断（微笑弯曲、饱和、拖尾、重叠、缺带、非单调、局部失效）
 * 都以结构化事件落库，而不是只写日志。
 */
export interface JudgmentPayload {
  rule:
    | "smile-curvature"
    | "saturated-band"
    | "smear-tail"
    | "overlapping-bands"
    | "ladder-band-missing"
    | "non-monotonic-ruler"
    | "local-invalidation";
  conclusion:
    | "local-ruler-with-valid-region"
    | "candidate-only"
    | "interval-only"
    | "segment-degraded"
    | "unsolvable"
    | "scoped-invalidation";
  subjectIds: string[];
  validRegion?: { yMin: number; yMax: number; basis: "image-px" };
  intervalBp?: { min: number; max: number; unit: "bp" };
  rationale: string;
  details?: Record<string, unknown>;
}

export interface EventEnvelope {
  id: string;
  seq: number;
  type:
    | "casepack.seeded"
    | "materials.imported"
    | "params.revised"
    | "material.revised"
    | "pipeline.completed"
    | "judgment"
    | "decision.recorded"
    | "project.exported"
    | "project.imported"
    | "export.recovered-half-write";
  branchId: string;
  payload: unknown;
  parents: string[];
  inputDigest: string | null;
  paramVersion: string | null;
  createdAt: string; // ISO8601 UTC
}
