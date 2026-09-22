// 机器可读“判定依据”事件载荷（findings）：被采纳与未采纳的结果都保留。
import { RULE_VERSIONS } from '../../shared/versions.js';
import type { FindingPayload } from '../../shared/types.js';

export function finding(
  kind: FindingPayload['kind'],
  affectedObjectIds: string[],
  narrative: string,
  evidence: Record<string, unknown> = {},
  adoptedObjectIds: string[] = [],
  rejectedObjectIds: string[] = [],
): FindingPayload {
  const ruleIdByKind: Record<FindingPayload['kind'], string> = {
    smile_local_ruler: 'RULE_SMILE_LOCAL_RULER',
    saturated_candidate: 'RULE_SATURATED_CANDIDATE_ONLY',
    tailing_candidate: 'RULE_TAILING_CANDIDATE_ONLY',
    overlap_interval: 'RULE_OVERLAP_KEEP_ALL_LEGAL_CANDIDATES',
    missing_ladder_band: 'RULE_MISSING_BAND_NO_EXTRAPOLATION',
    non_monotonic_ruler: 'RULE_NON_MONOTONIC_SEGMENT_INVALID',
    orientation_mismatch: 'RULE_ORIENTATION_SOURCE_OF_TRUTH',
    revision_local_invalidation: 'RULE_REVISION_INVALIDATES_LOCAL_DEPENDENTS',
    adopted_result: 'RULE_DECISION_ADOPTED',
    rejected_result: 'RULE_DECISION_REJECTED',
  };
  return {
    kind,
    basisRuleId: ruleIdByKind[kind],
    basisRuleVersion: RULE_VERSIONS.calibration,
    affectedObjectIds,
    adoptedObjectIds,
    rejectedObjectIds,
    evidence,
    narrative,
  };
}
