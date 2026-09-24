// 胶道标尺工作台 —— 核心领域类型
// 分层原则：不可变材料（material）与可修改决定（decision/event）严格分离；
// 所有派生结果记录输入摘要、参数版本与父级依赖。

export type Unit =
  | 'pixel'
  | 'degree'
  | 'millisecond'
  | 'bp'
  | 'kDa'
  | 'dimensionless';

export type CoordinateFrame = 'raw-image' | 'oriented-image';

export type DiagnosticKind =
  | 'incomplete-input'   // 输入不完整：带位置，禁止以空值/默认值伪装成功
  | 'corrupt-format'     // 格式损坏：无法解析
  | 'semantic-impossible'// 语义无解：如非单调标尺
  | 'budget-exhausted'   // 资源预算耗尽
  | 'warning'
  | 'info';

export interface Diagnostic {
  code: string;
  kind: DiagnosticKind;
  message: string;
  // 带位置：材料/派生标识 + 像素或条目位置
  location?: {
    materialId?: string;
    derivationId?: string;
    x?: number;
    y?: number;
    frame?: CoordinateFrame;
    unit?: Unit;
    field?: string;
    laneId?: string;
    bandId?: string;
  };
}

export type Provenance = 'auto' | 'human' | 'casepack';

export interface ProvenanceInfo {
  origin: Provenance;
  recordedAt: string; // ISO-8601 时间基准
  agent?: string;
}

// ---------------- 不可变材料层 ----------------

export interface RawImageMaterial {
  kind: 'raw-image';
  id: string;
  filename: string;
  mediaType: 'image/png';
  // 原始表示：base64 承载的像素字节，导入时保留
  base64Bytes: string;
  declaredWidth: number;
  declaredHeight: number;
  // 原始/不可转换单位留在原位置
  rawExposureNote?: string;
  provenance: ProvenanceInfo;
}

export interface OrientationMaterial {
  kind: 'orientation';
  id: string;
  imageId: string;
  rotationCw: 0 | 90 | 180 | 270; // 度（degree）
  flipH: boolean;
  provenance: ProvenanceInfo;
}

export interface ExposureMaterial {
  kind: 'exposure';
  id: string;
  imageId: string;
  exposureMs: number | null; // 毫秒；null = 无法转换，留在原位置并附诊断
  rawValue: string;         // 导入时的原始表示
  iso?: number | null;
  provenance: ProvenanceInfo;
}

export interface LadderSpec {
  kind: 'ladder-spec';
  id: string;
  laneCode: string;
  unit: 'bp' | 'kDa';
  // 标称值自上而下（短迁移→长迁移顺序不做假设，按 nominalMigrationOrder 给）
  bands: Array<{ label: string; mass: number; order: number }>;
  provenance: ProvenanceInfo;
}

export interface LaneBoundary {
  kind: 'lane-boundary';
  id: string;
  laneCode: string;
  role: 'ladder' | 'sample';
  // 弯曲泳道：左/右边界为图像坐标系下的折线（pixel, oriented-image）
  polygon: { x: number; y: number }[]; // [leftTop..leftBottom, rightBottom..rightTop]
  frame: CoordinateFrame;
  provenance: ProvenanceInfo;
}

export interface BandCenter {
  kind: 'band-center';
  id: string;
  laneCode: string;
  x: number;
  y: number;
  frame: CoordinateFrame;
  // 像素级来源：原图中的亮度证据窗
  evidencePatch: { x0: number; y0: number; x1: number; y1: number };
  profileAlong: number[]; // 沿泳道方向的亮度轮廓采样（pixel 基准）
  provenance: ProvenanceInfo;
}

export type Material =
  | RawImageMaterial
  | OrientationMaterial
  | ExposureMaterial
  | LadderSpec
  | LaneBoundary
  | BandCenter;

// ---------------- 参数版本 ----------------

export interface CalibrationParams {
  paramVersion: string; // 内容哈希派生的稳定版本号
  band: {
    windowHalfWidthPx: number;
    bandHalfWidthPx: number;
    minProminence: number;
    saturationLevel: number; // 0..255
    overlapCenterDeltaPx: number;
    tailRatio: number;
  };
  calibration: {
    matchTolerance: number; // 归一化位置容差
    minMatchedBands: number;
    maxCandidates: number;  // 资源预算
  };
  budget: {
    maxBandsPerLane: number;
    maxProfileSamples: number;
  };
}

// ---------------- 派生层 ----------------

export interface DerivationBase {
  id: string;
  type: string;
  parentIds: string[];       // 父级依赖（材料/参数/上一代派生的稳定身份）
  inputDigest: string;       // 输入摘要（canonical JSON 哈希）
  paramVersion: string;      // 参数版本
  computedAt: string;
  diagnostics: Diagnostic[];
}

export interface LaneCurvePoint {
  x: number;
  y: number;
  s: number; // 自顶部起的弧长 pixel
  width: number;
}

export interface LaneProfileResult extends DerivationBase {
  type: 'lane-profile';
  laneCode: string;
  curve: LaneCurvePoint[];
  profile: number[]; // 与 curve 同长的平均亮度
  validRegion: { s0: number; s1: number }; // 局部标尺/证据的有效区域 pixel
}

export interface MassCandidate {
  value: number;
  unit: 'bp' | 'kDa';
  segmentId: string | null; // 回到插值段
  ladderPointIds: string[]; // 回到 ladder 点
  confidence: 'unique' | 'candidate' | 'interval' | 'invalid';
  interval?: { low: number; high: number; unit: 'bp' | 'kDa' };
  invalidReason?: string;
}

export interface BandCandidateResult extends DerivationBase {
  type: 'band-candidates';
  laneCode: string;
  bands: Array<{
    id: string;
    center: { x: number; y: number };
    s: number;          // 泳道弧长位置 pixel
    intensity: number;  // 0..255
    saturated: boolean;
    tailing: boolean;
    overlapWith: string[];
    evidencePatch: { x0: number; y0: number; x1: number; y1: number };
    judgmentCodes: string[];
  }>;
}

export interface CalibrationSegment {
  id: string;
  ladderPointIds: [string, string];
  s0: number;
  s1: number;
  a: number; // log(mass) = a*s + b
  b: number;
  residual: number[]; // 各 ladder 点拟合残差（log 空间）
  validRegion: { s0: number; s1: number };
}

export interface CalibrationResult extends DerivationBase {
  type: 'calibration';
  laneCode: string;
  unit: 'bp' | 'kDa';
  segments: CalibrationSegment[];
  ladderAssignments: Array<{
    ladderPointId: string;
    bandId: string;
    nominalMass: number;
    s: number;
    matched: boolean;
  }>;
  nonMonotonic: boolean;
  fitResiduals: Array<{ s: number; residual: number; ladderPointId: string }>;
}

export interface MassInferenceResult extends DerivationBase {
  type: 'mass-inference';
  laneCode: string;
  items: Array<{
    id: string;
    bandId: string;
    accepted: boolean;              // 人工修订状态见 decision 事件
    status: 'unique' | 'candidate' | 'interval' | 'invalid';
    primary: MassCandidate | null;
    candidates: MassCandidate[];    // 无法唯一决定时保留全部合法候选
    judgmentCodes: string[];
  }>;
}

export type Derivation =
  | LaneProfileResult
  | BandCandidateResult
  | CalibrationResult
  | MassInferenceResult;

// ---------------- 结构化判定（机器可读事件） ----------------

export interface Judgment {
  code:
    | 'SMILE_CURVE_SAME_Y_DIFFERENT_MW'
    | 'LOCAL_RULER_VALID_REGION'
    | 'SATURATED_BAND_CANDIDATE_ONLY'
    | 'TAILING_BAND_CANDIDATE_ONLY'
    | 'OVERLAPPING_BANDS_INTERVAL_OR_CANDIDATES'
    | 'MISSING_LADDER_BAND'
    | 'NONMONOTONIC_RULER'
    | 'REVISION_LOCAL_INVALIDATION'
    | 'ROTATION_APPLIED'
    | 'BAND_OUTSIDE_VALID_REGION';
  message: string;
  severity: 'info' | 'warning' | 'error';
  evidence: Record<string, unknown>;
  affectedObjectIds: string[];
}

// ---------------- 事件层（可追加 / 可分支 / 可回放） ----------------

export type EventType =
  | 'project-created'
  | 'material-added'
  | 'params-revised'
  | 'derived'
  | 'decision'
  | 'decision-conflict'
  | 'branch-created';

export interface EventBase {
  id: string;
  seq: number;
  projectId: string;
  branch: string;
  type: EventType;
  parentEventId: string | null;
  timestamp: string;
  inputDigest?: string;
  paramVersion?: string;
}

export interface MaterialAddedEvent extends EventBase {
  type: 'material-added';
  material: Material;
  diagnostics: Diagnostic[]; // 无法转换的值留位诊断
}

export interface ParamsRevisedEvent extends EventBase {
  type: 'params-revised';
  params: CalibrationParams;
  reason: string;
}

export interface DerivedEvent extends EventBase {
  type: 'derived';
  derivation: Derivation;
  judgments: Judgment[];
  invalidatedIds: string[]; // 父级变化导致局部失效的对象
}

export interface DecisionEvent extends EventBase {
  type: 'decision';
  action: 'accept' | 'reject' | 'adjust';
  targetId: string;
  itemId?: string;
  chosenMass?: { value: number; unit: 'bp' | 'kDa' };
  adjustedCenter?: { x: number; y: number; frame: CoordinateFrame };
  note?: string;
  supersedesEventId?: string;
}

export interface DecisionConflictEvent extends EventBase {
  type: 'decision-conflict';
  existingEventId: string;
  attempted: string; // 冲突决定摘要
  resolution: 'kept-existing' | 'superseded' | 'both-retained';
}

export interface ProjectCreatedEvent extends EventBase {
  type: 'project-created';
  name: string;
}

export interface BranchCreatedEvent extends EventBase {
  type: 'branch-created';
  branchName: string;
  fromEventId: string;
}

export type GelEvent =
  | ProjectCreatedEvent
  | MaterialAddedEvent
  | ParamsRevisedEvent
  | DerivedEvent
  | DecisionEvent
  | DecisionConflictEvent
  | BranchCreatedEvent;

// ---------------- 项目 / 归档 ----------------

export interface ProjectState {
  projectId: string;
  name: string;
  branches: Record<string, { headEventId: string | null; createdAt: string }>;
  events: GelEvent[];
}

export interface ArchiveFormat {
  format: 'gelbench-archive';
  formatVersion: 1;
  projectId: string;
  name: string;
  createdAt: string;
  branches: ProjectState['branches'];
  events: GelEvent[];
  files: Record<string, { mediaType: string; base64Bytes: string; sha256: string }>;
  checksums: { eventsSha256: string; payloadSha256: string };
}

export type PipelineOutcome<T> =
  | { ok: true; value: T; diagnostics: Diagnostic[] }
  | { ok: false; diagnostics: Diagnostic[] };
