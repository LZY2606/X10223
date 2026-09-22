// ---------------------------------------------------------------------------
// 胶道标尺工作台 — 领域类型
// 分层约定：
//   1) 不可变材料 (materials): 原图/方向/曝光/ladder 标称/lane 几何/band 中心，全部携带像素级来源
//   2) 决定 (decisions): 人工修订、接受、否定、参数版本 —— 独立成层，永不覆写材料
//   3) 派生 (derived): 强度剖面、标定结果、分子量推断 —— 记录输入摘要+参数版本+父级依赖
// ---------------------------------------------------------------------------

export type Unit = 'px' | 'bp' | 'arc-px' | 'us' | 'ratio' | 'ev' | 'byte' | 'deg';

export interface TypedValue {
  value: number;
  unit: Unit;
  /** 导入时保留的原始表示；规范化只发生在派生层 */
  raw?: string;
}

export interface PixelPoint {
  x: number; // px，图像左上角为原点，x 向右
  y: number; // px，y 向下（迁移方向）
  frame: 'raw' | 'rot90cw' | 'rot180' | 'rot270cw';
}

export interface CoordinateFrame {
  frame: PixelPoint['frame'];
  width: number; // px
  height: number; // px
  origin: 'top-left';
}

export interface Exposure {
  exposureTimeUs: number; // 微秒（成像仪曝光时长），0/未知必须显式给出
  isoGain: number | null;
  dynamicRange: '8-bit' | '12-bit' | '16-bit' | 'unknown';
  saturationValue: number; // 该动态范围下的饱和码值
  raw: { exposure: string; gain: string };
}

export type Orientation = 'upright' | 'rot90cw' | 'rot180' | 'rot270cw';

export interface RawImage {
  imageId: string;
  blobSha256: string;
  byteLength: number;
  width: number;
  height: number;
  coordinateFrame: CoordinateFrame;
  orientation: Orientation; // 拍摄方向（原图方向标记，不静默旋转）
  exposure: Exposure;
  pixelSource: 'imported-png-decode';
}

export interface LadderSpec {
  specId: string;
  name: string;
  /** 标称分子量，单位 bp，自小到大仅在声明时如此，实际分配可能非单调 */
  nominalSizesBp: number[];
  sourceNote: string;
}

/** lane 边界：两条折线 + 中心线折线，均为像素坐标序列 */
export interface LaneGeometry {
  laneId: string;
  role: 'ladder' | 'sample';
  leftBoundary: PixelPoint[];
  centerLine: PixelPoint[];
  rightBoundary: PixelPoint[];
  /** 井线（上样端）在中心线上的起点像素 y */
  wellY: number;
}

export type BandKind = 'sharp' | 'saturated' | 'tailed' | 'overlapped';

export interface BandObservation {
  bandId: string;
  laneId: string;
  center: PixelPoint; // 条带中心，像素级来源
  /** 边界半宽（px），由图像强度直接估计 */
  halfWidthPx: number;
  kindHint: BandKind;
  origin: 'auto-candidate' | 'human-revised';
  sourceImageId: string;
  /** 重叠组：同组条带无法唯一拆分 */
  overlapGroup?: string;
}

export interface IntensitySample {
  s: number; // 沿中心线自井线起算的弧长，arc-px
  y: number; // 对应像素 y（原始坐标系）
  intensity: number; // 0..1
}

export interface BandProfile {
  bandId: string;
  laneId: string;
  peakS: number; // arc-px
  peakIntensity: number;
  saturated: boolean;
  saturatedFraction: number;
  tailing: boolean;
  overlapWith?: string[];
  /** 候选区间（弧长，arc-px）—— 无法唯一决定时给出区间 */
  interval?: { sLo: number; sHi: number };
  samples: IntensitySample[]; // 条带轮廓
  residual?: number; // 与拟合峰形的残差 RMS
}

export interface ProfileComputation {
  inputImageSha256: string;
  parameterVersion: number;
  parentLaneId: string;
  profiles: BandProfile[];
  laneSamples: IntensitySample[]; // 整条 lane 的轮廓（残差叠加用）
}

export interface CalibrationParameters {
  version: number;
  interpolation: 'linear-log10';
  minOverlapSeparationPx: number; // 小于该间距视为重叠
  saturationFractionThreshold: number; // 饱和像素占比阈值
  tailingAsymmetryThreshold: number; // 拖尾不对称度阈值
  arcStepPx: number; // 沿曲线采样步长
  resourceBudgetPixels: number; // 资源预算（像素数），超出 => budget-exhausted
  notes: string;
}

export interface LadderAssignment {
  bandId: string;
  point: PixelPoint;
  s: number; // arc-px
  nominalBp: number | null; // 缺带 => null
  missing: boolean;
  assignedRank: number | null;
  warning?: string;
}

export interface RulerSegment {
  segmentId: string;
  fromBandId: string;
  toBandId: string;
  sLo: number;
  sHi: number;
  bpLo: number | null;
  bpHi: number | null;
  /** 有效区域（像素 y），局部标尺只在该区域内有效 */
  validY: { min: number; max: number };
  validLaneId: string;
  valid: boolean;
  invalidReason?: string;
}

export interface FitPointResidual {
  bandId: string;
  s: number;
  observedLogMw: number | null;
  fittedLogMw: number;
  residual: number | null;
}

export interface Ruler {
  rulerId: string;
  laneId: string;
  specId: string;
  parameterVersion: number;
  status: 'valid' | 'non-monotonic' | 'insufficient' | 'locally-invalidated';
  assignments: LadderAssignment[];
  segments: RulerSegment[];
  residuals: FitPointResidual[];
  globalFit: { method: 'log10-linear'; intercept: number | null; slope: number | null; rmse: number | null };
  diagnostics: Diagnostic[];
  /** 输入摘要 + 父级依赖 */
  inputSummary: { imageSha256: string; laneBandIds: string[]; ladderSpecId: string };
}

export interface MwCandidate {
  bp: number;
  segmentId: string;
  interpolationRange: { sLo: number; sHi: number };
}

export interface BandInference {
  bandId: string;
  laneId: string;
  status: 'unique' | 'interval' | 'candidate-set' | 'out-of-range' | 'unresolved';
  s: number;
  mwBp: number | null;
  /** 区间（bp）—— 饱和/拖尾/重叠只能给区间或候选集 */
  intervalBp?: { lo: number; hi: number };
  candidates?: MwCandidate[]; // 无法唯一决定时保留全部合法候选
  segmentId: string | null;
  reasonCodes: string[];
  validRegionY?: { min: number; max: number };
  rulerVersion: string; // rulerId（含参数版本）
}

export interface Diagnostic {
  code: string; // 例: LADDER.NON_MONOTONIC
  severity: 'error' | 'warning' | 'info';
  message: string;
  /** 带位置的诊断：指向材料/事件/像素位置，绝不使用空值伪装 */
  location: {
    kind: 'pixel' | 'lane' | 'band' | 'event' | 'ruler' | 'project' | 'parameter';
    ref: string;
    point?: PixelPoint;
  };
  affectedObjectIds: string[];
}

export type DecisionKind = 'accept' | 'reject' | 'revise-band' | 'revise-lane' | 'adjust-parameter' | 'conflict';

export interface DecisionRecord {
  decisionId: string;
  kind: DecisionKind;
  targetId: string;
  note: string;
  conflictingWith?: string[]; // 互相冲突的人工决定
  payload?: Record<string, unknown>;
}

/** 机器可读取的规则判定事件依据 */
export interface RuleFinding {
  findingCode:
    | 'SMILE.SAME_HEIGHT_DIFFERENT_MW'
    | 'RULER.LOCAL_VALID_REGION'
    | 'BAND.SATURATED_CANDIDATE_ONLY'
    | 'BAND.TAIL_CANDIDATE_OR_INTERVAL'
    | 'BAND.OVERLAP_CANDIDATE_SET'
    | 'LADDER.MISSING_BAND'
    | 'LADDER.NON_MONOTONIC'
    | 'IMAGE.ROTATED_PROVENANCE'
    | 'REVISION.LOCAL_INVALIDATION';
  evidence: Record<string, unknown>;
  affectedObjectIds: string[];
  adopted: boolean; // 被采纳 / 未采纳都保留
}

// ---------------------------------------------------------------------------
// 事件（append-only）。所有计算结果携带 inputSummary / parameterVersion / parentDeps
// ---------------------------------------------------------------------------

interface EventBase {
  id: string;
  seq: number;
  branchId: string;
  parentId: string | null;
  at: string; // ISO-8601，Asia/Tokyo 由服务端写入
  author: 'auto' | 'human';
  inputSummary?: Record<string, unknown>;
  parameterVersion?: number;
  parentDeps?: string[]; // 父级事件 id
}

export interface ProjectCreatedEvent extends EventBase {
  type: 'project.created';
  name: string;
}
export interface ImageImportedEvent extends EventBase {
  type: 'image.imported';
  image: RawImage;
}
export interface ImageRotatedEvent extends EventBase {
  type: 'image.rotated';
  sourceImageId: string;
  newImageId: string;
  rotationDeg: 90 | 180 | 270;
  newFrame: CoordinateFrame;
  transform: { cos: number; sin: number; swapAxes: boolean };
}
export interface LadderSpecRegisteredEvent extends EventBase {
  type: 'ladder.spec-registered';
  spec: LadderSpec;
}
export interface LaneGeometrySetEvent extends EventBase {
  type: 'lane.geometry-set';
  lane: LaneGeometry;
  supersedesLaneId: string | null;
}
export interface BandObservedEvent extends EventBase {
  type: 'band.observed';
  band: BandObservation;
  supersedesBandId: string | null;
}
export interface ProfilesComputedEvent extends EventBase {
  type: 'profiles.computed';
  computation: ProfileComputation;
  ruleFindings: RuleFinding[];
}
export interface RulerBuiltEvent extends EventBase {
  type: 'ruler.built';
  ruler: Ruler;
  ruleFindings: RuleFinding[];
}
export interface MwInferredEvent extends EventBase {
  type: 'mw.inferred';
  inferences: BandInference[];
  ruleFindings: RuleFinding[];
}
export interface DecisionMadeEvent extends EventBase {
  type: 'decision.made';
  decision: DecisionRecord;
  ruleFindings: RuleFinding[];
}
export interface ParameterRevisedEvent extends EventBase {
  type: 'parameter.revised';
  fromVersion: number;
  parameters: CalibrationParameters;
}
export interface BranchCreatedEvent extends EventBase {
  type: 'branch.created';
  newBranchId: string;
  label: string;
  reason: string;
  forkedFromEventId: string;
}
export interface BundleImportedEvent extends EventBase {
  type: 'bundle.imported';
  bundleFormat: string;
  sourceExportId: string;
  remap: Record<string, string>;
}

export type GelEvent =
  | ProjectCreatedEvent
  | ImageImportedEvent
  | ImageRotatedEvent
  | LadderSpecRegisteredEvent
  | LaneGeometrySetEvent
  | BandObservedEvent
  | ProfilesComputedEvent
  | RulerBuiltEvent
  | MwInferredEvent
  | DecisionMadeEvent
  | ParameterRevisedEvent
  | BranchCreatedEvent
  | BundleImportedEvent;

export interface Branch {
  branchId: string;
  label: string;
  parentBranchId: string | null;
  forkedFromEventId: string | null;
  createdAt: string;
}

export interface ProjectState {
  projectId: string;
  name: string;
  branchIds: string[];
  branches: Record<string, Branch>;
  heads: Record<string, string>; // branchId -> eventId
  image: RawImage | null;
  ladderSpec: LadderSpec | null;
  lanes: Record<string, LaneGeometry>;
  laneOrder: string[];
  activeLaneBySupersession: Record<string, string | null>;
  bands: Record<string, BandObservation>;
  activeBandBySupersession: Record<string, string | null>;
  latestProfiles: ProfileComputation | null;
  latestRuler: Ruler | null;
  latestInferences: BandInference[] | null;
  parameters: CalibrationParameters;
  decisions: DecisionRecord[];
  findings: RuleFinding[];
  diagnostics: Diagnostic[];
  events: GelEvent[];
}

// ---------------------------------------------------------------------------
// 导出/导入包
// ---------------------------------------------------------------------------

export interface GelRulerBundle {
  format: 'gel-ruler-bundle';
  formatVersion: 1;
  exportId: string;
  exportedAt: string;
  project: { projectId: string; name: string };
  branches: Branch[];
  events: GelEvent[];
  blobs: { sha256: string; mediaType: string; bytesBase64: string }[];
}

export interface ImportOutcome {
  projectId: string;
  eventsApplied: number;
  blobsApplied: number;
  status: 'committed';
  warnings: Diagnostic[];
}
