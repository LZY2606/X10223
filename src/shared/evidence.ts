export const EVIDENCE_CODES = {
  SMILE_SAME_HEIGHT_DIFFERENT_MW: "GEL-SMILE-001",
  LOCAL_RULER_VALID_REGION: "GEL-RULER-002",
  SATURATED_BAND_CANDIDATE_OR_INTERVAL: "GEL-SAT-003",
  TAILING_BAND_CANDIDATE: "GEL-TAIL-004",
  OVERLAPPING_BANDS_CANDIDATES: "GEL-OVERLAP-005",
  LADDER_MISSING_BAND_GAP: "GEL-LADDER-MISSING-006",
  NONMONOTONIC_RULER_SEGMENT: "GEL-RULER-NONMONO-007",
  REVISION_LOCAL_INVALIDATION: "GEL-REVISION-LOCAL-008",
  OUT_OF_VALID_REGION: "GEL-RULER-OUTRANGE-009",
  ROTATED_FRAME_PROVENANCE: "GEL-ROTATION-010",
  UNCONVERTABLE_VALUE_PRESERVED: "GEL-QTY-011"
} as const;

export type EvidenceCode = (typeof EVIDENCE_CODES)[keyof typeof EVIDENCE_CODES];

export interface EvidenceEvent {
  code: EvidenceCode | string;
  severity: "info" | "warning" | "error";
  statement: string;
  basis: string;
  frame: string;
  affectedObjectIds: string[];
  computationId: string;
  parametersVersion: string;
  positions: { x?: number; y?: number; laneId?: string; bandId?: string; segmentId?: string }[];
}
