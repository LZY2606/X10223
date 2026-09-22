/**
 * 胶道标尺工作台领域模型。
 *
 * 分层原则：
 *  - 不可变材料层：原图字节、拍摄方向、曝光、ladder 标称值（只增不改）；
 *  - 可修改决定层：lane 边界、条带中心、接受/否定/参数调整（每次修订新版本，身份不变）；
 *  - 计算层：记录输入摘要、参数版本、父级依赖，内容寻址、可重放；
 *  - 事件层：append-only，所有判断依据写成机器可读事件。
 */
import type { PixelPoint, Quantity } from './units.js';

export type { PixelPoint, Quantity };

export type MaterialKind =
  | 'rawImage'
  | 'derivedImage'
  | 'orientation'
  | 'exposure'
  | 'ladderSpec';

/** 像素级来源：几何对象必须记录其像素坐标与所参照的帧 */
export interface PixelProvenance {
  capturedAt: string | null;
  device: string | null;
  originalFilename: string;
  /** 该材料在导入包中的字节范围（像素级来源可回溯） */
  byteOffset?: [number, number];
  note?: string;
}

export interface RawImageMaterial {
  identity: string;
  kind: 'rawImage' | 'derivedImage';
  revision: number;
  blobId: string;
  sha256: string;
  mediaType: 'image/png';
  width: number;
  height: number;
  bitDepth: 8;
  channels: 1;
  provenance: PixelProvenance;
  /** derivedImage 时记录变换（旋转角度等）与父图像 */
  transform?: {
    type: 'rotate' | 'crop';
    angleDeg?: number;
    parentBlobSha: string;
  };
}

export interface OrientationMaterial {
  identity: string;
  kind: 'orientation';
  revision: number;
  /** 相对原图的拍摄方向：角度 + 翻转，保留原始表示 */
  angleDeg: Quantity;
  flipH: boolean;
  flipV: boolean;
  rawRepresentation: string;
  source: string;
}

export interface ExposureMaterial {
  identity: string;
  kind: 'exposure';
  revision: number;
  /** 曝光时长（携带单位） */
  time: Quantity;
  gain: Quantity | null;
  /** 饱和灰度阈值（8 位 0-255），无法确定时为 null 并附诊断 */
  saturationLevel: number | null;
  rawRepresentation: string;
  source: string;
}

export interface LadderNominal {
  /** 稳定身份 */
  identity: string;
  /** 标称分子量，保留原始表示与单位 */
  mw: Quantity;
  /** 标称顺序（自上样孔向下，1 开始） */
  ordinal: number;
  /** 该标称带在胶图中缺失（缺带情形），缺失也是一种输入，不删除材料 */
  observed: boolean;
  rawRepresentation: string;
}

export interface LadderSpecMaterial {
  identity: string;
  kind: 'ladderSpec';
  revision: number;
  laneIdentity: string;
  supplier: string | null;
  lot: string | null;
  bands: LadderNominal[];
  rawRepresentation: string;
}

export type Material =
  | RawImageMaterial
  | OrientationMaterial
  | ExposureMaterial
  | LadderSpecMaterial;

/** 可修改决定：泳道几何（边界为像素折线，微笑弯曲可表达） */
export interface LaneGeometryRevision {
  identity: string;
  revision: number;
  label: string;
  frame: string;
  isLadderLane: boolean;
  left: PixelPoint[];
  right: PixelPoint[];
  source: 'auto' | 'manual';
  confidence: number | null;
}

/** 可修改决定：条带中心（像素坐标 + 采样窗） */
export interface BandCenterRevision {
  identity: string;
  revision: number;
  laneIdentity: string;
  center: PixelPoint;
  /** 强度轮廓采样窗，像素级来源 */
  window: { x0: number; y0: number; x1: number; y1: number; frame: string };
  source: 'auto' | 'manual';
  confidence: number | null;
}

export type DecisionStatus =
  | 'accepted'
  | 'rejected'
  | 'param-adjusted'
  | 'superseded';

export interface DecisionRecord {
  id: string;
  targetType: 'band' | 'lane' | 'calibration' | 'compute';
  targetIdentity: string;
  status: DecisionStatus;
  fromResultId: string;
  note: string | null;
  paramDiff: Record<string, number | string | boolean>;
}

export type FailureClass =
  | 'resource-exhausted'
  | 'format-corrupt'
  | 'semantic-unsolvable';

export interface Diagnostic {
  code: string;
  severity: 'error' | 'warning' | 'info';
  message: string;
  /** 带位置的诊断；输入不完整时指向具体字段/像素/泳道 */
  location?: {
    frame?: string;
    x?: number;
    y?: number;
    laneId?: string;
    bandId?: string;
    segmentIndex?: number;
    field?: string;
  };
  /** 无法唯一决定时保留的全部合法候选身份 */
  candidates?: string[];
  failureClass?: FailureClass;
}

/** 机器可读判断事件（不是给人看的日志，而是结构化状态） */
export interface MachineEvent {
  code:
    | 'SMILE_HEIGHT_NOT_MW'
    | 'RULER_LOCAL_VALID_REGION'
    | 'SATURATION_ONLY_CANDIDATE'
    | 'TAILING_ONLY_CANDIDATE'
    | 'OVERLAP_ONLY_INTERVAL'
    | 'LADDER_MISSING_BAND'
    | 'NON_MONOTONIC_RULER'
    | 'ROTATION_FRAME_CHANGED'
    | 'LOCAL_INVALIDATION_AFTER_REVISION'
    | 'CANDIDATES_KEPT_AMBIGUOUS'
    | 'REVISION_SUPERSEDES_AUTO';
  objectRefs: string[];
  data: Record<string, number | string | boolean>;
  message: string;
}

export interface MWCandidate {
  lo: number;
  hi: number;
  point?: number;
  unit: string;
  /** 点击分子量可回到的 ladder 点 */
  ladderPointIds: string[];
  /** 插值段编号（从 0 开始） */
  segmentIndex: number | null;
  inValidRegion: boolean;
}

export interface BandEvidence {
  /** 沿泳道中心线的弧长位置（px，frame 基准） */
  migrationNorm: number | null;
  peakIntensity: number;
  clippedFraction: number;
  asymmetry: number;
  resolvedPeaks: number;
  residual: number | null;
  /** 轮廓摘要（供前端叠加） */
  profileRef: string;
}

export type BandStatus = 'definite' | 'interval' | 'candidate' | 'invalid';

export interface BandInference {
  bandId: string;
  laneId: string;
  center: PixelPoint;
  status: BandStatus;
  /** 无法唯一决定时的全部合法候选；确定时仅一个点候选 */
  mwCandidates: MWCandidate[];
  saturated: boolean;
  tailed: boolean;
  overlappedWith: string[];
  evidence: BandEvidence;
  diagnostics: Diagnostic[];
}

export interface CalibrationModel {
  laneId: string;
  /** 标尺点：迁移弧长(px) -> 分子量(bp)，单调时才有效 */
  points: { ladderPointId: string; u: number; mw: number }[];
  /** 插值段：[u0,u1, mw0,mw1]（线性插值，不做段外推） */
  segments: [number, number, number, number][];
  validRegion: { uStart: number; uEnd: number } | null;
  nonMonotonic: boolean;
  /** 微笑曲率（中心线横向偏移极差 px）：同一高度不等于同一分子量 */
  smileCurvaturePx: number;
  residualRms: number | null;
}

export interface LaneInference {
  laneId: string;
  calibration: CalibrationModel | null;
  bands: BandInference[];
}

export interface ParentRef {
  kind: 'material' | 'lane' | 'band' | 'rule' | 'compute';
  identity: string;
  revision: number | null;
  sha?: string;
}

export interface ComputeResult {
  /** 内容寻址：等价输入 => 相同 id */
  id: string;
  ruleVersion: string;
  inputSummary: Record<string, string>;
  params: Record<string, number | string | boolean>;
  parents: ParentRef[];
  lanes: LaneInference[];
  machineEvents: MachineEvent[];
  diagnostics: Diagnostic[];
  /** 强度轮廓与残差（按 laneId/bandId），前端叠加用 */
  profiles: Record<string, number[]>;
  fitResiduals: Record<string, number[]>;
}

export interface ComputeOutcome {
  status: 'ok' | 'resource-exhausted' | 'format-corrupt' | 'semantic-unsolvable';
  result?: ComputeResult;
  diagnostic?: Diagnostic;
  diagnostics?: Diagnostic[];
  used?: ResourceBudget;
}

export interface ResourceBudget {
  maxPixels: number;
  maxSegments: number;
  maxOpSteps: number;
}

export type EventType =
  | 'project.created'
  | 'material.registered'
  | 'auto.detected'
  | 'manual.override'
  | 'decision.recorded'
  | 'branch.created'
  | 'compute.completed'
  | 'compute.failed'
  | 'export.recorded'
  | 'import.recorded';

export interface BranchSpec {
  id: string;
  name: string;
  parentBranchId: string | null;
  forkSeq: number;
  purpose: 'main' | 'counterexample';
  /** 反例档案：相对基线只改动的一个直接来源 */
  changedDirectSource: string | null;
}

export interface EventRecord {
  id: string;
  seq: number;
  projectId: string;
  branchId: string;
  parentEventId: string | null;
  type: EventType;
  actor: 'system' | 'auto' | 'reviewer';
  payload: unknown;
  inputSummary: Record<string, string>;
  paramVersion: string;
  parents: ParentRef[];
  resultId: string | null;
  outcomeClass?: 'ok' | FailureClass;
  decision?: DecisionRecord;
}

/** 反例档案中的一条记录：采纳与未采纳结果都保留 */
export interface CounterexampleEntry {
  branchId: string;
  changedDirectSource: string;
  adoptedResultId: string | null;
  rejectedResultIds: string[];
  machineEventCodes: string[];
  affectedObjects: string[];
  expectedScope: string;
  observedScope: string;
}
