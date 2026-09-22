// GelBench 领域模型：材料(L0 不可变) / 事件(决定) / 派生(L1-L2) 三层。
// 所有像素量携带 coordinateBasis；所有领域量携带 unit。禁止用空值伪装成功。

export type Unit =
  | 'pixel'
  | 'radian'
  | 'bp'
  | 'kDa'
  | 'second'
  | 'ms'
  | 'u'            // 灰度/强度（任意单位）
  | 'ratio'        // Rf 相对迁移率
  | 'degree'
  | 'dimensionless';

export interface Qn<V = number> {
  value: V;
  unit: Unit;
}

/** 坐标基准：像素原点与轴方向。旋转后的像素必须指向对应 canonicalImageId 的基准。 */
export interface CoordinateBasis {
  kind: 'pixel-image';
  imageId: string;
  origin: 'top-left';
  xAxis: 'right';
  yAxis: 'down';
}

export interface PixelPoint {
  x: number; // pixel
  y: number; // pixel
  basis: CoordinateBasis;
}

export interface PixelBox {
  x: number;
  y: number;
  width: number;  // pixel
  height: number; // pixel
  basis: CoordinateBasis;
}

/** 像素级来源：材料字段 -> 原始载荷字节偏移/字段路径，可往返核对。 */
export interface PixelProvenance {
  sourceMaterialId: string;
  field: string;
  rawRepresentation: string;            // 导入时的原始表示（字符串保真）
  byteOffset?: number;
  confidence?: 'auto' | 'human' | 'scripted';
}

export type MaterialKind =
  | 'image'
  | 'capture'
  | 'ladderSpec'
  | 'lane'
  | 'band'
  | 'ladderLink';

export interface ImageMaterial {
  kind: 'image';
  id: string;
  role: 'original' | 'rotated';
  contentType: 'image/png';
  width: number;   // pixel
  height: number;  // pixel
  blobSha256: string;
  pixelSha256: string;
  sourceEventId: string;
  derivedFromImageId?: string;
  rotationDeg?: number;
  createdAt: string;
}

export interface CaptureMaterial {
  kind: 'capture';
  id: string;
  imageId: string;
  /** 拍摄方向：相对电泳方向（向下迁移）的顺时针角度，度数。 */
  orientationDeg: Qn<number>;
  /** 曝光：毫秒；另有饱和提示。 */
  exposureMs: Qn<number>;
  capturedAt: string; // ISO8601 时间基准
  device: string;
  rawNotation: string; // 原始表示保真
  sourceEventId: string;
}

export interface LadderBandNominal {
  label: string;
  molecularWeight: Qn<number>;
  orderFromTop: number; // 从加样孔起 0
}

export interface LadderSpecMaterial {
  kind: 'ladderSpec';
  id: string;
  name: string;
  unit: 'bp' | 'kDa';
  bands: LadderBandNominal[];
  rawNotation: string;
  sourceEventId: string;
}

export interface LaneControlPoint extends PixelPoint {
  sHint?: number; // 沿曲线弧长提示（pixel）
}

export interface LaneBoundaryProvenance {
  leftBox: PixelBox;
  rightBox: PixelBox;
  centerline: PixelPoint[];
}

export interface LaneMaterial {
  kind: 'lane';
  id: string;
  laneIndex: number;
  imageId: string;
  label: string;
  controlPoints: LaneControlPoint[];
  widthPx: number;
  boundary: LaneBoundaryProvenance;
  role: 'sample' | 'ladder';
  status: 'active' | 'retracted';
  revisesLaneId?: string;
  origin: 'auto' | 'human';
  rawNotation: string;
  sourceEventId: string;
  createdAt: string;
}

export interface BandMaterial {
  kind: 'band';
  id: string;
  laneId: string;
  imageId: string;
  center: PixelPoint;
  box: PixelBox;
  peakIntensity: Qn<number>;
  saturated: boolean;
  tailing: 'none' | 'up' | 'down';
  overlapGroupId?: string;
  origin: 'auto' | 'human';
  status: 'active' | 'superseded' | 'retracted';
  revisesBandId?: string;
  rawNotation: string;
  sourceEventId: string;
  createdAt: string;
}

/** 把某 ladder 规格与某 ladder 泳道的观测条带（按 orderFromTop）关联。 */
export interface LadderLinkMaterial {
  kind: 'ladderLink';
  id: string;
  laneId: string;
  ladderSpecId: string;
  /** key = bandId(ladder 泳道条带)，value = orderFromTop；缺带即缺键。 */
  assignments: Record<string, number>;
  missingBands: number[]; // orderFromTop 列表：标称有、观测无
  origin: 'auto' | 'human';
  status: 'active' | 'retracted';
  revisesLinkId?: string;
  rawNotation: string;
  sourceEventId: string;
  createdAt: string;
}

export type Material =
  | ImageMaterial
  | CaptureMaterial
  | LadderSpecMaterial
  | LaneMaterial
  | BandMaterial
  | LadderLinkMaterial;

// ---- 事件（不可变决定流）----

export type EventType =
  | 'projectCreated'
  | 'imageCommitted'
  | 'captureCommitted'
  | 'ladderSpecCommitted'
  | 'laneAutoCommitted'
  | 'laneRevised'
  | 'laneRetracted'
  | 'bandsAutoCommitted'
  | 'bandRevised'
  | 'bandRetracted'
  | 'ladderLinkCommitted'
  | 'parameterSet'
  | 'decisionRecorded'
  | 'branchCreated'
  | 'noteAdded';

export interface GelEvent {
  id: string;
  projectId: string;
  seq: number;
  branch: string;
  parentEventId: string | null;
  type: EventType;
  at: string;
  actor: 'auto' | 'human';
  summary: string;
  payload: Record<string, unknown>;
  inputSummary: Record<string, string>; // 输入哈希摘要
  parameterVersion: string;
  parentDependencies: string[];        // 材料/派生 id
}

// ---- 派生层 ----

export type SegmentStatus =
  | 'valid'
  | 'gap-missing-band'
  | 'invalid-nonmonotonic'
  | 'revision-local-fail';

export interface CalibrationAnchor {
  bandId: string;
  orderFromTop: number;
  s: number;          // 沿泳道中心弧长 pixel
  center: PixelPoint;
  molecularWeight: Qn<number>;
  present: boolean;
  logMW: number | null;
  residualLog?: number;
}

export interface CalibrationSegment {
  id: string;
  anchorA: string;
  anchorB: string;
  sA: number;
  sB: number;
  logA: number;
  logB: number;
  slope: number;
  status: SegmentStatus;
  reasonCode?: string;
  /** 有效区域：s 区间（pixel，该泳道图像基准）。 */
  validRegion: { sMin: number; sMax: number } | null;
}

export interface LaneCalibration {
  kind: 'laneCalibration';
  id: string;
  laneId: string;
  ladderSpecId: string;
  ladderLinkId: string;
  parameterVersion: string;
  basis: CoordinateBasis;
  anchors: CalibrationAnchor[];
  segments: CalibrationSegment[];
  residuals: { bandId: string; residualLog: number }[];
  diagnostics: Diagnostic[];
}

export type InferenceStatus =
  | 'accepted'        // 唯一、落在 valid 段内
  | 'candidate'       // 饱和/拖尾/重叠/缺带间隙/外推，无法唯一决定
  | 'interval'        // 重叠解卷积只能给区间
  | 'rejected'
  | 'uncalibrated'
  | 'revision-local-fail';

export interface MwHypothesis {
  id: string;
  molecularWeight: Qn<number>;
  segmentId: string;
  s: number;
  logMW: number;
  withinValidRegion: boolean;
}

export interface BandInference {
  kind: 'bandInference';
  id: string;
  bandId: string;
  laneId: string;
  calibrationId: string;
  status: InferenceStatus;
  primary: MwHypothesis | null;
  hypotheses: MwHypothesis[];
  interval: { low: Qn<number>; high: Qn<number> } | null;
  reasonCodes: string[];
  diagnostic?: string;
  parameterVersion: string;
}

export type Derivation = LaneCalibration | BandInference;

export interface Diagnostic {
  code: string;
  severity: 'error' | 'warning' | 'info';
  message: string;
  position?: {
    materialKind?: MaterialKind;
    materialId?: string;
    field?: string;
    point?: PixelPoint;
    byteOffset?: number;
  };
}

// ---- 判定事件（机器可读的规则判断依据）----

export interface JudgmentRecord {
  ruleId:
    | 'R-SMILE-LOCAL-RULER'
    | 'R-SATURATED-CANDIDATE'
    | 'R-TAIL-CANDIDATE'
    | 'R-OVERLAP-INTERVAL'
    | 'R-MISSING-BAND-GAP'
    | 'R-NONMONOTONIC-INVALID'
    | 'R-REVISION-LOCAL-FAIL'
    | 'R-EXTRAPOLATION-CANDIDATE'
    | 'R-UNCALIBRATED';
  subjectId: string;
  status: 'fired' | 'cleared';
  reasonCodes: string[];
  evidenceRefs: string[];
  at: string;
}

export interface ParameterSet {
  version: string;
  detection: {
    bandThresholdRatio: number; // 相对泳道峰值
    minBandWidthPx: number;
    maxBandWidthPx: number;
    overlapSeparationPx: number;
    saturationLevel: number;    // 灰度饱和阈值
    tailAsymmetryRatio: number;
  };
  calibration: {
    model: 'piecewise-linear-log';
    maxGapOrder: number;        // 缺带跨多少阶仍允许（0=不允许跨缺带）
  };
}

export interface DecisionState {
  acceptedBandIds: string[];
  rejectedBandIds: string[];
  parameterOverrides: Record<string, number>;
  note: string;
}
