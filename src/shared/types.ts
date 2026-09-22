// ============================================================================
// 胶道标尺工作台 —— 核心领域类型
// 分层：materials（不可变原始材料） / events（追加式决定与来源事实）
//       / derivations（可重算的派生产物，内容寻址） / diagnostics（带位置诊断）
// 所有领域量携带单位或坐标基准；原始表示保留在 raw，派生层才规范化。
// ============================================================================

// ---- 量值：单位随值携带，原始表示保留 -------------------------------------
export type Unit =
  | 'bp'            // 核酸长度（ladder 标称）
  | 'kDa'           // 蛋白分子量
  | 'pixel'         // 像素
  | 'degree'        // 角度（拍摄方向）
  | 'second'        // 曝光时间
  | 'graylevel'     // 灰度/吸光度相关
  | 'fraction'      // 无量纲比例
  | 'index';        // 序号（泳道号）

export type CoordinateFrame = 'image_px' | 'oriented_px' | 'lane_arc';

export interface TaggedQuantity {
  value: number;
  unit: Unit;
  frame?: CoordinateFrame;
  raw?: RawRepresentation;
}

export interface RawRepresentation {
  text?: string;
  number?: number;
  unitText?: string;
  sourceRef: string; // 材料 id + 字段路径
}

export function q(value: number, unit: Unit, frame?: CoordinateFrame): TaggedQuantity {
  return { value, unit, ...(frame ? { frame } : {}) };
}

// ---- 像素级来源点 -----------------------------------------------------------
export interface SourcedPoint {
  x: number; // image_px
  y: number; // image_px
  frame: CoordinateFrame;
  provenance: SourceProvenance;
}

export interface SourceProvenance {
  origin: 'image_pixel' | 'manual_pixel' | 'derived';
  imageMaterialId: string;
  eventId?: string;
  derivationId?: string;
  method?: string;
}

// ---- 泳道（lane 边界保留像素级来源）----------------------------------------
export type Polyline = SourcedPoint[];

export interface Lane {
  id: string;
  laneIndex: number; // 1-based, 左→右（oriented）
  center: Polyline;  // 沿迁移方向的中线，image_px
  leftEdge: Polyline;
  rightEdge: Polyline;
  halfWidthPx: number;
  role: 'sample' | 'ladder';
  status: 'proposed' | 'accepted' | 'rejected';
  origin: 'auto' | 'manual' | 'revised';
  parentId?: string; // 修订来源 lane
  diagnosticCodes: string[];
}

// ---- 条带 ------------------------------------------------------------------
export type BandStatus =
  | 'candidate'
  | 'accepted'
  | 'rejected'
  | 'ambiguous';

export interface Band {
  id: string;
  laneId: string;
  center: SourcedPoint;       // 峰值点 image_px
  halfWidthPx: number;         // 沿迁移方向半宽
  lateralHalfWidthPx: number;  // 横跨泳道半宽
  peakAbsorbance: number;      // 0..1
  saturated: boolean;
  saturatedPlateauPx?: number; // 饱和平台沿弧长的跨度
  tailingAsymmetry: number;    // 右侧半宽/左侧半宽；>1 拖尾
  overlapGroupId?: string;
  migrationS: TaggedQuantity;  // lane_arc，距加样口弧长 pixel
  status: BandStatus;
  origin: 'auto' | 'manual' | 'revised';
  parentId?: string;
  diagnosticCodes: string[];
}

// ---- Ladder 标称 -----------------------------------------------------------
export interface LadderBandSpec {
  nominal: TaggedQuantity; // bp / kDa
  rank: number;            // 1 = 加样口最近（最大片段）
  present?: boolean;       // 标称缺失标注（缺带场景的来源事实）
}

export interface LadderSpec {
  id: string;
  unit: 'bp' | 'kDa';
  bands: LadderBandSpec[];
  sourceRef: string;
  rawText?: string;
}

export type CalibrationStatus =
  | 'valid'
  | 'non_monotonic'
  | 'insufficient_points'
  | 'local_invalid';

export interface CalibrationSegment {
  id: string;
  rankA: number;
  rankB: number;
  sA: number; // pixel along lane arc
  sB: number;
  logMA: number;
  logMB: number;
  valid: boolean;
  validRegion: ValidRegion;
  invalidReasonCode?: string;
  ruleVersion: string;
  parentDerivationId: string;
}

export interface ValidRegion {
  frame: CoordinateFrame;
  sStart: number; // pixel, lane_arc, 闭区间
  sEnd: number;
  xStartPx?: number; // image_px 包围多边形/区间（微笑局部标尺）
  xEndPx?: number;
}

export interface Calibration {
  id: string;
  laneId: string;
  ladderSpecId: string;
  status: CalibrationStatus;
  segments: CalibrationSegment[];
  globalResiduals: FitResidual[];
  pairing: LadderPairing[];
  paramsVersion: string;
  ruleVersion: string;
  diagnosticCodes: string[];
}

export interface LadderPairing {
  rank: number;
  bandId: string;
  nominalValue: number;
  s: number;
  matched: boolean;
  invalidReasonCode?: string;
}

export interface FitResidual {
  bandId: string;
  s: number;
  observedLogM: number;
  predictedLogM: number;
  residualLogM: number;
  inValidRegion: boolean;
}

// ---- 分子量推断 ------------------------------------------------------------
export interface MolecularWeightEstimate {
  id: string;
  bandId: string;
  laneId: string;
  calibrationId: string;
  segmentId?: string;
  primary?: MolecularWeightValue;
  interval?: { low: MolecularWeightValue; high: MolecularWeightValue };
  candidates: MolecularWeightValue[];
  status: 'unique' | 'interval' | 'ambiguous' | 'unresolved';
  reasonCodes: string[];
  paramsVersion: string;
  ruleVersion: string;
}

export interface MolecularWeightValue {
  value: number;
  unit: 'bp' | 'kDa';
  sPx: number;
  segmentId: string;
  validRegion: ValidRegion;
  confidence: 'high' | 'candidate';
  derivationId: string;
}

// ---- 诊断：带位置，三种失败严格区分 ----------------------------------------
export type DiagnosticSeverity = 'error' | 'warning' | 'info';
export type FailureClass = 'format_corrupt' | 'semantic_impossible' | 'budget_exhausted';

export interface Diagnostic {
  code: string;
  severity: DiagnosticSeverity;
  message: string;
  failureClass?: FailureClass;
  at?: string; // JSON Pointer 风格位置
  subjectId?: string;
  expected?: unknown;
  actual?: unknown;
}

export interface PositionedInputError {
  failureClass: FailureClass;
  diagnostics: Diagnostic[];
}

// ---- 不可变材料 -------------------------------------------------------------
export interface AcquisitionFacts {
  orientationDegrees: number; // 拍摄方向（顺时针 EXIF 等价）
  exposure: {
    durationS?: number;
    gainIso?: number;
    rawText?: string;
  };
}

export interface ImageMaterial {
  id: string;
  filename: string;
  byteLength: number;
  sha256: string;
  mediaType: string;
  acquisition: AcquisitionFacts;
  widthPx?: number;
  heightPx?: number;
}

export type Material =
  | ({ kind: 'image' } & ImageMaterial)
  | ({ kind: 'ladder_spec' } & LadderSpec);

// ---- 事件（追加式，决定历史，分支）-----------------------------------------
export type EventKind =
  | 'project.created'
  | 'material.image.registered'
  | 'material.ladder.registered'
  | 'acquisition.facts.recorded'
  | 'lanes.auto.proposed'
  | 'lanes.revised'
  | 'bands.auto.proposed'
  | 'bands.centers.revised'
  | 'ladder.assigned'
  | 'ladder.bands.paired'
  | 'calibration.computed'
  | 'mw.computed'
  | 'decision.recorded'
  | 'params.revised'
  | 'finding.recorded'
  | 'branch.created';

export type DecisionVerb = 'accept' | 'reject' | 'adjust' | 'conflict_marked';

export interface Decision {
  verb: DecisionVerb;
  subjectType: 'lane' | 'band' | 'mw_estimate' | 'calibration_segment';
  subjectId: string;
  paramsDiff?: Record<string, unknown>;
  supersedesEventId?: string;
  note?: string;
}

export type FindingKind =
  | 'smile_local_ruler'
  | 'saturated_candidate'
  | 'tailing_candidate'
  | 'overlap_interval'
  | 'missing_ladder_band'
  | 'non_monotonic_ruler'
  | 'orientation_mismatch'
  | 'revision_local_invalidation'
  | 'adopted_result'
  | 'rejected_result';

export interface FindingPayload {
  kind: FindingKind;
  basisRuleId: string;        // 机器可读规则
  basisRuleVersion: string;
  affectedObjectIds: string[];
  adoptedObjectIds: string[];
  rejectedObjectIds: string[];
  evidence: Record<string, unknown>;
  narrative: string;
}

export interface ProjectEvent {
  id: string;
  projectId: string;
  branchId: string;
  seq: number;      // 分支内序号
  lineSeq: number;  // 导入线性顺序（等价输入稳定顺序）
  kind: EventKind;
  timestamp: string;
  parentEventIds: string[]; // 父级依赖
  inputSummary: string;     // 输入摘要（哈希或结构化摘要）
  paramsVersion?: string;
  payload: unknown;
  findings?: FindingPayload[];
  author?: string;
}

// ---- 派生（内容寻址，可丢弃重算）-------------------------------------------
export type DerivationKind =
  | 'image.decoded'
  | 'image.oriented'
  | 'lanes.detected'
  | 'bands.detected'
  | 'calibration.fitted'
  | 'mw.estimated'
  | 'residuals.reported';

export interface DerivationRecord {
  id: string;             // 内容寻址稳定 id
  kind: DerivationKind;
  ruleVersion: string;
  paramsVersion: string;
  inputSummary: string;
  parentDerivationIds: string[];
  createdAt: string;
  outputJson: string;
}

// ---- 项目 / 分支 / 状态 -----------------------------------------------------
export interface Branch {
  id: string;
  name: string;
  forkedFromBranchId?: string;
  forkPointEventId?: string;
  headEventId?: string;
}

export interface ParamSet {
  version: string;
  detector: Record<string, number>;
  calibration: Record<string, number | string>;
}

export interface ProjectState {
  projectId: string;
  name: string;
  branchId: string;
  branches: Branch[];
  materials: Record<string, Material>;
  ladderLaneAssignment?: { laneId: string; ladderSpecId: string; eventId: string };
  lanes: Record<string, Lane>;
  bands: Record<string, Band>;
  calibration?: Calibration;
  mwEstimates: Record<string, MolecularWeightEstimate>;
  params: ParamSet;
  events: ProjectEvent[];
  diagnostics: Diagnostic[];
  findings: FindingPayload[];
}

// ---- 引擎统一结果 -----------------------------------------------------------
export interface EngineResult<T> {
  ok: boolean;
  value?: T;
  diagnostics: Diagnostic[];
  derivations?: DerivationRecord[];
  failureClass?: FailureClass;
}

// ---- 导入 / 导出 -------------------------------------------------------------
export interface ExportBundle {
  format: 'gel-ladder-bench-archive';
  formatVersion: 1;
  exportedAt: string;
  project: {
    id: string;
    name: string;
    params: ParamSet;
  };
  branches: Branch[];
  events: ProjectEvent[];
  materials: Array<Material & { blobBase64?: string }>;
  dossier?: Dossier;
  manifest: {
    materialCount: number;
    eventCount: number;
    branchCount: number;
    inputHash: string;
  };
}

// ---- 反例档案 ---------------------------------------------------------------
export interface DossierVariant {
  id: string;
  branchId: string;
  title: string;
  directSourceChanged: string; // 只改动的一个直接来源
  fromEventId: string;
  baselineEventIds: string[];
  adoptedResultIds: string[];
  rejectedResultIds: string[];
  expectedInvariant: string;   // 机器可读判定依据
  impactScope: string[];       // 受影响对象
  events: ProjectEvent[];
}

export interface Dossier {
  id: string;
  title: string;
  baselineDescription: string;
  pixelProvenanceRequired: boolean;
  variants: DossierVariant[];
  invariants: Array<{ id: string; machineRule: string; narrative: string }>;
}
