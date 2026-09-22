/**
 * 胶道标尺工作台 —— 共享领域类型。
 *
 * 分层原则：
 *  - Material（不可变材料）：原图、拍摄方向、曝光、ladder 标称值、lane 边界、band 中心，
 *    全部保留像素级来源（provenance），永不被覆盖；修订 = 追加新材料 + 决策事件。
 *  - Decision（可修改决定）：自动/人工标定结果的接受、否定、参数调整，记录父级依赖。
 *  - Derived（派生计算）：输入摘要 + 参数版本 + 父级依赖，可从事件重放。
 */

export type Unit = 'bp' | 'kDa' | 'px' | 'arc_px' | 'deg' | 'ms' | 'gray8' | 'ratio';

/** 带单位与坐标基准的领域量。导入时保留 originalText，无法转换时留在原位置并附诊断。 */
export interface ScalarWithUnit {
  value: number;
  unit: Unit;
  frame?: string;
  originalText?: string;
  conversionDiagnostic?: Diagnostic;
}

export type Severity = 'error' | 'warning' | 'info';

/** 带位置的诊断：输入不完整时返回诊断，不得用空值/默认值伪装成功。 */
export interface Diagnostic {
  code: string;
  severity: Severity;
  message: string;
  /** 定位：可以指向材料字段、像素坐标、插值段索引等。 */
  location?: {
    materialId?: string;
    field?: string;
    x?: number;
    y?: number;
    segmentIndex?: number;
    bandId?: string;
  };
}

export type MaterialKind =
  | 'acquisition' // 原图 + 拍摄方向 + 曝光（像素级来源）
  | 'ladder_spec' // ladder 标称值（bp/kDa，带原始文本）
  | 'lane' // lane 边界曲线（像素坐标）
  | 'band'; // band 中心（像素坐标）

export type ProvenanceSource = 'import' | 'manual' | 'auto' | 'revision';

/** 像素级来源：任何派生坐标都能追溯到哪张图、哪段原始像素证据。 */
export interface Provenance {
  source: ProvenanceSource;
  acquisitionId: string;
  /** 来源图像坐标系：每个 acquisition 有独立像素框（旋转产生新框）。 */
  frame: string;
  createdAt: string;
  detectorVersion?: string;
  /** 支持该坐标的像素区域（旋转/局部修订只影响其覆盖范围）。 */
  supportRegion?: { x0: number; y0: number; x1: number; y1: number };
  parentMaterialIds?: string[];
  note?: string;
}

export interface AcquisitionMaterial {
  id: string;
  kind: 'acquisition';
  /** 原始图像字节（PNG），永不修改；旋转生成新 acquisition。 */
  blobName: string;
  width: number;
  height: number;
  /** 拍摄方向，单位 deg；原始表示保留。 */
  orientation: ScalarWithUnit;
  /** 曝光，单位 ms；原始表示保留。 */
  exposure: ScalarWithUnit;
  sha256: string;
  provenance: Provenance;
}

export interface LadderBandNominal {
  /** 该标称带在 ladder 中的稳定身份。 */
  bandRef: string;
  mw: ScalarWithUnit;
  /** 导入时的原始文本，无法转换时保留并附诊断。 */
  originalText: string;
  /** 是否缺失（胶图 ladder 上找不到对应带）。 */
  missing?: boolean;
}

export interface LadderSpecMaterial {
  id: string;
  kind: 'ladder_spec';
  name: string;
  bands: LadderBandNominal[];
  provenance: Provenance;
}

export type Point = { x: number; y: number };

/**
 * Lane 边界：左、右两条像素曲线 + 顶部井口线。
 * 中心线由边界导出；迁移距离沿中心线做弧长（arc_px），
 * 因此“微笑”弯曲时同一像素高度不等于同一迁移距离/分子量。
 */
export interface LaneMaterial {
  id: string;
  kind: 'lane';
  laneIndex: number;
  label: string;
  leftBoundary: Point[];
  rightBoundary: Point[];
  /** 顶部井口线（迁移起点），像素 y。 */
  wellLineY: number;
  provenance: Provenance;
}

export type BandShape = 'compact' | 'saturated' | 'smear' | 'overlap';

export interface BandMaterial {
  id: string;
  kind: 'band';
  laneId: string;
  /** band 中心，像素坐标，带支撑区域。 */
  center: Point;
  widthPx: number;
  /** 饱和区：强度平台高度（gray8）与平台宽度。 */
  plateau?: { level: number; widthPx: number };
  shape: BandShape[];
  /** 重叠对象：与另一条带共享同一候选区域。 */
  overlapsWith?: string[];
  provenance: Provenance;
}

export type Material =
  | AcquisitionMaterial
  | LadderSpecMaterial
  | LaneMaterial
  | BandMaterial;

export type ParameterSetName = 'calibration.v1' | 'inference.v1';

export interface ParameterSet {
  name: ParameterSetName;
  version: number;
  values: Record<string, number | string | boolean>;
}

/** 局部标尺的一段：迁移距离 -> log(MW) 的插值段，带有效区域。 */
export interface RulerSegment {
  segmentIndex: number;
  /** 有效迁移距离区间（沿 ladder lane 中心线弧长，arc_px）。 */
  migrationStart: number;
  migrationEnd: number;
  /** 有效像素 y 区间（用于叠层展示）。 */
  yStart: number;
  yEnd: number;
  mwStart: number;
  mwEnd: number;
  unit: Unit;
  /** 产生该段的两个 ladder band 稳定身份。 */
  fromBandRef: string;
  toBandRef: string;
  /** 参与 ladder band 的 band 材料 id（用于点击回溯）。 */
  fromBandMaterialId: string;
  toBandMaterialId: string;
}

export interface CalibrationResult {
  calibrationId: string;
  ladderLaneId: string;
  acquisitionId: string;
  unit: Unit;
  segments: RulerSegment[];
  /** 整把尺子的有效区域（最外两个实测带之间）；超出只能外推/不可推断。 */
  validRegion: { migrationMin: number; migrationMax: number; yMin: number; yMax: number };
  /** 残差（实测 ladder 点相对拟合/分段线，logMW 域）。 */
  residuals: { bandMaterialId: string; bandRef: string; observed: number; fitted: number; residual: number }[];
  diagnostics: Diagnostic[];
  inputSummary: {
    ladderSpecHash: string;
    ladderLaneHash: string;
    acquisitionHash: string;
    bandHashes: string[];
  };
  parameterVersion: string;
  parentEventId: string | null;
  /** 标尺是否非单调（非单调 => 语义无解，不产生可用段）。 */
  monotonic: boolean;
}

export type CandidateStatus = 'candidate' | 'interval' | 'unique' | 'rejected' | 'out_of_range';

export interface MwCandidate {
  candidateId: string;
  bandMaterialId: string;
  laneId: string;
  /** 像素中心沿 lane 中心线换算出的迁移距离（arc_px）。 */
  migrationArcPx: number;
  /** 该 lane 在 band 像素高度处的局部有效区域（横向/迁移方向）。 */
  localValidRegion: { migrationMin: number; migrationMax: number };
  /** 唯一 MW（bp/kDa）；区间结果为中点。 */
  mw: number | null;
  mwLow?: number;
  mwHigh?: number;
  unit: Unit;
  status: CandidateStatus;
  /** 支撑该结果的插值段；点击 MW 回到这里。 */
  segmentIndex?: number;
  diagnostics: Diagnostic[];
}

export interface InferenceResult {
  inferenceId: string;
  acquisitionId: string;
  calibrationId: string;
  candidates: MwCandidate[];
  diagnostics: Diagnostic[];
  inputSummary: {
    calibrationHash: string;
    laneHashes: string[];
    bandHashes: string[];
  };
  parameterVersion: string;
  parentEventId: string | null;
}

export type EventType =
  | 'project_created'
  | 'material_added'
  | 'auto_detected'
  | 'calibration_computed'
  | 'inference_computed'
  | 'decision_accept'
  | 'decision_reject'
  | 'parameter_adjusted'
  | 'validation_recorded'
  | 'case_scenario_recorded'
  | 'export_recorded';

export interface EventBase {
  id: string;
  projectId: string;
  seq: number;
  type: EventType;
  parentEventId: string | null;
  /** 输入摘要（内容哈希）与参数版本。 */
  inputSummary?: Record<string, string>;
  parameterVersion?: string;
  /** 本次决定/计算所依赖的材料或结果 id（父级依赖）。 */
  dependencies?: string[];
  branch: string;
  createdAt: string;
  payload: unknown;
}

export interface DecisionPayload {
  targetId: string;
  targetKind: 'candidate' | 'calibration' | 'inference' | 'material';
  action: 'accept' | 'reject' | 'adjust';
  /** 被采纳与未被采纳的结果都保留：未采纳结果的候选列表。 */
  acceptedCandidateId?: string;
  rejectedCandidateIds?: string[];
  note?: string;
  /** 冲突决定：与同一对象上的既有决定矛盾。 */
  conflictsWithEventId?: string;
}

export interface ParameterAdjustPayload {
  parameterSet: ParameterSetName;
  oldVersion: number;
  newVersion: number;
  changes: Record<string, { from: number | string | boolean; to: number | string | boolean }>;
  /** 受影响对象（局部失效传播）。 */
  affectedResultIds: string[];
}

export type FailureClass = 'resource_budget_exhausted' | 'format_corrupt' | 'semantic_unsolvable';

export interface FailureResult {
  failureClass: FailureClass;
  message: string;
  diagnostics: Diagnostic[];
}

export interface CaseScenarioRecord {
  scenarioId: string;
  name: string;
  description: string;
  baselineEventId: string;
  changedSource: string;
  affectedObjectIds: string[];
  expected: string;
  observed: string;
  contained: boolean;
}

export interface ProjectState {
  projectId: string;
  name: string;
  headEventId: string | null;
  events: EventBase[];
  materials: Record<string, Material>;
  calibrations: Record<string, CalibrationResult>;
  inferences: Record<string, InferenceResult>;
  parameters: Record<ParameterSetName, ParameterSet>;
  decisions: EventBase[];
  scenarios: CaseScenarioRecord[];
}
