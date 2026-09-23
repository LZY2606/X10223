/**
 * 胶道标尺工作台 —— 核心领域类型
 *
 * 分层原则：
 *  - Material（不可变材料）：导入即固化，content-addressed id，永不就地修改
 *  - Event（事件）：追加式决定历史，身份由 (seq, project, parents, canonicalPayload) 决定
 *  - Analysis（派生计算）：记录输入摘要 + 参数版本 + 父级依赖，可丢弃重放
 */

export type Unit = 'bp' | 'kDa' | 'nt';

/** 带单位的量：保留导入时的原始表示(raw)，派生层才规范化 */
export interface Quantity {
  /** 规范化后的数值（成功转换时存在），如 bp 或 kDa */
  value: number | null;
  unit: Unit;
  /** 导入时的原始字符串，绝不丢失 */
  raw: string;
  /** 无法转换时留在原位置的诊断；value 必须为 null */
  conversion?: Diagnostic;
}

export interface Diagnostic {
  code: string;
  message: string;
  /** 带位置的诊断：指向材料/坐标/字段 */
  at?: SourceRef;
  severity: 'error' | 'warning';
}

/** 像素级来源引用 */
export interface SourceRef {
  materialId: MaterialId;
  /** 材料内字段名，如 'laneCurves[0].points[3].x' */
  path?: string;
  /** 像素坐标（图像坐标基准，左上原点，x→右 y→下） */
  x?: number;
  y?: number;
}

export type MaterialId = string;

export type MaterialKind =
  | 'gel-image'
  | 'capture-meta'
  | 'ladder-spec'
  | 'lane-geometry'
  | 'band-marks';

export interface MaterialBase {
  id: MaterialId;
  kind: MaterialKind;
  /** 导入时的原始表示（JSON 可序列化），原样保留 */
  original: unknown;
  /** 规范化视图；无法转换的字段保留 null 并在 diagnostics 中记录 */
  normalized: unknown;
  sha256: string;
  importedAt: string;
  origin: {
    filename?: string;
    /** 导入批次 id */
    importId: string;
    mediaType?: string;
  };
  diagnostics: Diagnostic[];
}

export interface GelImageMaterial extends MaterialBase {
  kind: 'gel-image';
  normalized: {
    width: number;
    height: number;
    channels: number;
    /** 灰度像素 0..255（条带为亮），长度 = width*height */
    pixels: number[];
    bytesSha256: string;
  };
}

/** 拍摄方向与曝光：不可变来源材料 */
export interface CaptureMetaMaterial extends MaterialBase {
  kind: 'capture-meta';
  normalized: {
    /** 相对于原始字节的拍摄方向，角度 ∈ {0,90,180,270} */
    orientationDeg: 0 | 90 | 180 | 270;
    /** 曝光，单位毫秒 */
    exposureMs: number | null;
    exposureRaw: string;
    /** 时间基准 ISO 8601；可为空并附诊断 */
    capturedAt: string | null;
    timeBasis: string;
    bitDepth: number;
    /** 饱和阈值（像素值 ≥ 该值视为饱和） */
    saturationLevel: number;
  };
}

export interface LadderBandNominal {
  /** 行号，带位置诊断用 */
  index: number;
  molecularWeight: Quantity;
  /** 原始行对象 */
  raw: unknown;
}

export interface LadderSpecMaterial extends MaterialBase {
  kind: 'ladder-spec';
  normalized: {
    name: string;
    unit: Unit;
    bands: LadderBandNominal[];
    /** 标称值是否随迁移距离单调（大→小）。非单调标尺在此标诊断 */
    monotonic: boolean;
  };
}

/** lane 中心线/边界曲线，全部像素坐标，保留控制点级来源 */
export interface LaneCurve {
  laneId: string;
  label: string;
  /** 中心线控制点（像素） */
  center: Pt[];
  /** 左右边界控制点（像素） */
  leftBoundary: Pt[];
  rightBoundary: Pt[];
  source: 'auto' | 'human';
}

export interface Pt {
  x: number;
  y: number;
}

export interface LaneGeometryMaterial extends MaterialBase {
  kind: 'lane-geometry';
  normalized: {
    imageId: MaterialId;
    lanes: LaneCurve[];
  };
}

export interface MarkedBand {
  bandId: string;
  laneId: string;
  /** 条带中心点（像素），像素级来源 */
  center: Pt;
  /** 人工给定的半高宽（像素），可空（自动检测） */
  halfWidthPx?: number;
  source: 'auto' | 'human';
  /** 是否在饱和区 */
  saturated?: boolean;
  note?: string;
}

export interface BandMarksMaterial extends MaterialBase {
  kind: 'band-marks';
  normalized: {
    imageId: MaterialId;
    marks: MarkedBand[];
  };
}

export type Material =
  | GelImageMaterial
  | CaptureMetaMaterial
  | LadderSpecMaterial
  | LaneGeometryMaterial
  | BandMarksMaterial;

// ---------------------------------------------------------------------------
// 事件（追加式决定历史）
// ---------------------------------------------------------------------------

export type BranchId = string;

export type EventType =
  | 'project-created'
  | 'material-imported'
  | 'parameter-revision'
  | 'source-revised'
  | 'analysis-run'
  | 'decision'
  | 'branch-forked'
  | 'export-record';

export interface ParameterSet {
  /** 参数版本，语义化递增 */
  paramVersion: string;
  /** 平滑窗（像素），用于条带轮廓 */
  smoothingWindowPx: number;
  /** 饱和判定阈值（像素值）；null 表示用拍摄元数据 */
  saturationLevel: number | null;
  /** 重叠判定：两峰距离 < 此值*平均半宽 视为重叠 */
  overlapHalfWidthRatio: number;
  /** 插值方法 */
  interpolation: 'piecewise-linear' | 'local-monotone';
  /** 校准模型（残差展示用） */
  calibrationModel: 'piecewise' | 'log-linear';
  /** 弧形投影采样步长（像素） */
  arcStepPx: number;
}

export type DecisionKind = 'accept' | 'reject' | 'parameter-adjust' | 'conflict';

export interface AnalysisRunPayload {
  runId: string;
  ruleVersion: string;
  params: ParameterSet;
  inputs: InputDigest[];
  lanes: LaneAnalysis[];
  diagnostics: Diagnostic[];
  status: 'ok' | 'partial' | 'unresolved';
}

export interface InputDigest {
  role:
    | 'image'
    | 'capture'
    | 'ladder'
    | 'lanes'
    | 'bands';
  materialId: MaterialId;
  sha256: string;
}

export interface SegmentRef {
  /** 相邻两个 ladder 点形成的插值段 */
  laneId: string;
  fromBandId: string;
  toBandId: string;
  /** 该段在弧长坐标上的有效区间 [s0,s1] */
  sRange: [number, number];
}

export interface MWCandidate {
  candidateId: string;
  value: number | null;
  unit: Unit;
  status: 'unique' | 'candidate' | 'interval' | 'out-of-range' | 'unknown';
  /** 候选值列表（无法唯一决定时保留全部合法候选） */
  alternatives: { value: number; probability: number }[];
  interval?: [number, number];
  sourceSegment: SegmentRef | null;
  reasons: string[];
  /** 用于点击回跳：最近的 ladder 点 */
  ladderPointRefs: SourceRef[];
}

export interface BandAnalysis {
  bandId: string;
  centerPx: Pt;
  /** 在 lane 弧长坐标上的位置 */
  arcS: number;
  peakIntensity: number;
  saturated: boolean;
  smear: boolean;
  overlapWith: string[];
  /** 条带轮廓（垂直剖面强度），用于叠加绘制 */
  profile: { s: number; intensity: number }[];
  /** 沿中心线的横向宽度（像素） */
  widthPx: number;
  mw: MWCandidate;
}

export interface LadderPoint {
  bandId: string;
  nominal: number;
  unit: Unit;
  arcS: number;
  centerPx: Pt;
  sourceRef: SourceRef;
}

export interface LadderCalibration {
  laneId: string;
  points: LadderPoint[];
  /** 每点相对校准模型的残差（log MW 或 MW 空间），用于残差叠加层 */
  residuals: { bandId: string; residual: number; arcS: number }[];
  segments: SegmentRef[];
  /** 局部标尺的有效区域（弧长）；缺带会使区间断裂 */
  validRanges: [number, number][];
  rmsResidual: number;
}

export interface LaneAnalysis {
  laneId: string;
  isLadder: boolean;
  calibration: LadderCalibration | null;
  bands: BandAnalysis[];
  diagnostics: Diagnostic[];
}

export interface DecisionPayload {
  decision: DecisionKind;
  target: { kind: 'band' | 'lane' | 'run' | 'parameter'; id: string };
  /** 被接受/否定的候选 id；conflict 时列出两个互相冲突的选择 */
  candidateIds: string[];
  note: string;
  /** 冲突时：另一条未采纳决定链 */
  conflictsWithEventId?: string;
  accepted: boolean;
}

export interface SourceRevisionPayload {
  /** 被替换的直接来源材料（只改一个直接来源） */
  replacesMaterialId: MaterialId;
  newMaterialId: MaterialId;
  reason: string;
  /** 影响范围标签 */
  scope: 'rotation' | 'lane-warp' | 'ladder-missing' | 'saturation' | 'overlap' | 'nonmonotonic' | 'local-invalidation';
}

export type EventPayloadMap = {
  'project-created': { name: string; casePackVersion: string };
  'material-imported': { materialId: MaterialId; kind: MaterialKind; sha256: string; role?: string };
  'parameter-revision': { params: ParameterSet; reason: string };
  'source-revised': SourceRevisionPayload;
  'analysis-run': AnalysisRunPayload;
  'decision': DecisionPayload;
  'branch-forked': { fromBranch: BranchId; newBranch: BranchId; atEventSeq: number };
  'export-record': { exportSha256: string; itemCount: number };
};

export interface GelEvent<T extends EventType = EventType> {
  /** 稳定身份：项目内确定性派生，导入导出保持不变 */
  id: string;
  seq: number;
  projectId: string;
  branch: BranchId;
  type: T;
  payload: EventPayloadMap[T];
  /** 父级依赖事件 id（含分支分叉点） */
  parents: string[];
  /** 时钟时间戳，不参与身份计算（保证等价输入顺序稳定） */
  at: string;
  /** 该事件可见结论依赖的参数版本 */
  paramVersion?: string;
}

export interface ProjectState {
  projectId: string;
  branch: BranchId;
  materials: Record<MaterialId, Material>;
  /** 分支头事件链（本分支可见） */
  events: GelEvent[];
  heads: Record<BranchId, number>;
  params: ParameterSet;
  /** 每分支最新一次分析 */
  latestRunByBranch: Record<BranchId, AnalysisRunPayload | null>;
  decisions: DecisionPayload[];
  conflicts: string[];
}

export interface CaseScenario {
  key: string;
  title: string;
  branch: BranchId;
  description: string;
  trigger: SourceRevisionPayload['scope'] | 'conflict';
}

export type FailureKind =
  | 'ResourceBudgetExhausted'
  | 'FormatCorrupt'
  | 'SemanticallyUnresolvable';

export class DomainFailure extends Error {
  constructor(
    public kind: FailureKind,
    message: string,
    public diagnostics: Diagnostic[] = [],
  ) {
    super(message);
    this.name = kind;
  }
}
