import { stableId, canonicalJson, sha256Hex } from '../shared/ids';
import type { BandAnnotation, LaneAnnotation } from '../core/types';
import type { AnalysisResult } from '../core/analyze';
import type { Diagnostic } from '../shared/diagnostic';

/**
 * 事件溯源：所有决定都是只追加事件。
 * 回到任意旧事件 = 用当时参数版本重放，而不是用最新结果覆盖历史。
 */
export type EventType =
  | 'project-created'
  | 'materials-imported' // L0 不可变材料（原图/方向/曝光/ladder 标称）
  | 'lanes-annotated' // L1 lane 边界（像素来源）
  | 'bands-annotated' // L1 band 中心（像素来源）
  | 'auto-analysis' // L2 自动候选 + 派生
  | 'parameter-revised' // 参数修订（产生新版本）
  | 'decision' // 人工接受/否定某个候选或分子量
  | 'source-mutated' // 只改一个直接来源（反例）
  | 'branch-created'
  | 'evidence-judgment' // 机器可读判断（微笑/饱和/拖尾/重叠/有效区域）
  | 'note';

/**
 * 机器可读判断事件载荷。把关键裁决（而不是仅写日志）结构化：
 * - smile: 同一像素高度不等于同一分子量 → 局部标尺必须带有效区域
 * - saturated/tail/overlap: 只能标为候选或区间，重叠保留全部合法候选
 */
export interface EvidenceJudgmentPayload {
  ruleId:
    | 'smile-needs-local-scale'
    | 'saturated-candidate-only'
    | 'tail-interval-only'
    | 'overlap-candidate-set'
    | 'missing-span-coarse-interval'
    | 'non-monotonic-unresolvable'
    | 'outside-valid-region-unresolvable'
    | 'orientation-content-mismatch';
  ruleVersion: string;
  subjectKind: 'lane' | 'band' | 'segment' | 'inference';
  subjectId: string;
  severity: 'error' | 'warning' | 'info';
  /** 量化证据（带单位/坐标基准）。 */
  measurements: Record<string, { value: number; unit: string; frame?: string }>;
  /** 有效区域（局部标尺）。 */
  validRegion?: { sMin: number; sMax: number; yMin: number; yMax: number; frame: string };
  /** 裁决动作：允许/降级为候选/降级为区间/拒绝。 */
  verdict: 'allow-unique' | 'downgrade-candidates' | 'downgrade-interval' | 'reject';
  /** 受影响对象（影响范围必须被正确限制）。 */
  affectedObjectIds: string[];
  message: string;
}

export interface EventRefs {
  /** 父级依赖（事件/材料/计算结果身份）。 */
  parents: string[];
}

export interface ProvenanceEvent {
  eventId: string;
  seq: number;
  branchId: string;
  type: EventType;
  timestamp: string;
  /** 参数版本（决策时固定）。 */
  paramVersion: string;
  payload: Record<string, unknown>;
  parents: string[];
  /** 前一事件哈希，形成防篡改链。 */
  prevHash: string;
  selfHash: string;
}

export interface DecisionDetail {
  decisionId: string;
  action: 'accept' | 'reject' | 'adjust';
  targetKind: 'band' | 'lane' | 'molecular-weight' | 'parameter';
  targetId: string;
  /** 对候选的选择；adjust 时带新参数。 */
  acceptedCandidateId?: string;
  rejectedCandidateIds?: string[];
  adjustment?: Record<string, unknown>;
  reason: string;
}

export interface AnalysisSnapshot {
  snapshotId: string;
  producerEventId: string;
  result: AnalysisResult;
  /** 被采纳的候选（决策决定）；未采纳候选仍保留在 result 中。 */
  adopted: Record<string, string | undefined>; // bandId -> candidateId
  createdAt: string;
}

export function hashEvent(e: Omit<ProvenanceEvent, 'selfHash'>): string {
  const body = canonicalJson({
    eventId: e.eventId,
    seq: e.seq,
    branchId: e.branchId,
    type: e.type,
    timestamp: e.timestamp,
    paramVersion: e.paramVersion,
    payload: e.payload,
    parents: e.parents,
    prevHash: e.prevHash,
  });
  return sha256Hex(body);
}

export function makeEvent(args: {
  seq: number;
  branchId: string;
  type: EventType;
  paramVersion: string;
  payload: Record<string, unknown>;
  parents: string[];
  prevHash: string;
  timestamp: string;
}): ProvenanceEvent {
  const eventId = stableId(
    'evt',
    args.seq,
    args.branchId,
    args.type,
    args.paramVersion,
    canonicalJson(args.payload),
    args.parents,
    args.prevHash,
  );
  const without = { eventId, ...args };
  const selfHash = hashEvent(without);
  return { ...without, selfHash };
}

export interface BranchState {
  branchId: string;
  parentBranchId: string | null;
  forkedFromEventId: string | null;
  lanes: LaneAnnotation[];
  bands: BandAnnotation[];
  latestAnalysis: AnalysisSnapshot | null;
  adopted: Record<string, string | undefined>;
  decisions: DecisionDetail[];
  diagnostics: Diagnostic[];
  /** 冲突决定（同一对象互相矛盾且未调和）。 */
  conflicts: { targetId: string; decisions: string[] }[];
  paramVersion: string;
}
