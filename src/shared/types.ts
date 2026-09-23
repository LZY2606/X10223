/**
 * 领域模型：不可变材料 / 事件 / 派生结果。
 * 分层原则：
 *  - material：原始证据（原图、拍摄方向、曝光、ladder 标称值、lane 边界、band 中心），
 *    全部保留像素级来源与原始表示，一经写入不可修改。
 *  - event：可修改的决定层（导入、检测、接受/否定/参数修订/源替换/分支），
 *    形成只追加（append-only）链；派生结果以事件为父级、内容寻址、不可变。
 *  - derived：由 material + 参数版本 + 父级依赖确定的计算结果。
 * 所有领域量携带单位或坐标基准；原始值留在 raw，派生层才规范化。
 */

export type Unit = 'bp' | 'kDa' | 'ms' | 'pixel' | 'arc_len' | 'fraction';

/** 带单位/基准的量。rawValue 保留导入时原始表示（可能无法转换）。 */
export interface QuantitativeValue {
  value: number | null;
  unit: Unit | null;
  rawValue: string;
  rawUnit?: string;
  diagnostic?: Diagnostic;
}

export interface PixelPoint {
  x: number; // px，原点=图像左上角，x 向右
  y: number; // px，y 向下
}

/** 像素级来源：定位到帧、材料、可选轮廓/段。 */
export interface PixelProvenance {
  frameId: string;
  materialId: string;
  point?: PixelPoint;
  polyline?: PixelPoint[];
  contourId?: string;
  segmentIndex?: number;
  method: 'imported' | 'manual' | 'auto_detect' | 'transformed';
  transformPath?: string[]; // 例如 ['rotate:90cw']
  note?: string;
}

export type DiagnosticCode =
  | 'INCOMPLETE_INPUT'
  | 'UNPARSEABLE_VALUE'
  | 'UNCONVERTIBLE_UNIT'
  | 'FORMAT_CORRUPT'
  | 'SEMANTIC_UNRESOLVABLE'
  | 'BUDGET_EXHAUSTED'
  | 'OUT_OF_VALID_RANGE'
  | 'MISSING_LADDER_BAND'
  | 'NONMONOTONIC_SCALE'
  | 'SATURATED_BAND'
  | 'TAILING_BAND'
  | 'OVERLAPPING_BANDS'
  | 'SMILE_DETECTED'
  | 'AMBIGUOUS_MATCH'
  | 'ROTATION_APPLIED'
  | 'LOCAL_CALIBRATION_INVALID';

export interface Diagnostic {
  code: DiagnosticCode;
  message: string;
  /** 带位置的定位：JSON Pointer 风格路径 + 像素位置。 */
  path?: string;
  at?: PixelPoint;
  laneRef?: string;
  segmentIndex?: number;
}

export type MaterialKind =
  | 'image'
  | 'capture_metadata'
  | 'ladder_spec'
  | 'lane_annotation'
  | 'band_annotation';

export interface ImageMaterial {
  id: string;
  kind: 'image';
  blobId: string; // 指向 blobs 表（原始字节）
  mediaType: string;
  width: number; // px
  height: number; // px
  channels: number;
  importedAt: string; // ISO，来自导入清单（确定性回放中由事件提供）
  rawRepresentation: { fileName: string; byteLength: number };
}

/** 拍摄方向与曝光：原始表示保留，规范化仅在派生层。 */
export interface CaptureMetadataMaterial {
  id: string;
  kind: 'capture_metadata';
  imageId: string;
  /** orientation: 拍摄方向，0/90/180/270 度顺时针；raw 保留原字符串。 */
  orientationDegRaw: string;
  orientationDeg: number | null; // 规范化结果
  /** 曝光：如 "250 ms"；无法转换时 value=null 并附诊断。 */
  exposure: QuantitativeValue;
  runDuration?: QuantitativeValue;
  diagnostics: Diagnostic[];
  rawRepresentation: Record<string, unknown>;
}

export interface LadderEntry {
  ordinal: number;
  label: QuantitativeValue; // 标称分子量，如 "1500 bp"
  expectedRank: number; // 迁移距离升序排名（bp 大→迁得慢→rank 小）
}

export interface LadderSpecMaterial {
  id: string;
  kind: 'ladder_spec';
  ladderLaneRef: string;
  unit: Unit;
  entries: LadderEntry[]; // 按 expectedRank 升序
  rawRepresentation: Record<string, unknown>;
}

export interface LaneAnnotationMaterial {
  id: string;
  kind: 'lane_annotation';
  imageId: string;
  frameId: string;
  lanes: LaneGeom[];
  rawRepresentation: Record<string, unknown>;
}

export interface LaneGeom {
  laneRef: string;
  role: 'ladder' | 'sample';
  /** 弯曲泳道以折线表示，像素级来源保留在 provenance。 */
  centerline: PixelPoint[];
  leftBoundary: PixelPoint[];
  rightBoundary: PixelPoint[];
  provenance: PixelProvenance[];
}

export interface BandAnnotationMaterial {
  id: string;
  kind: 'band_annotation';
  imageId: string;
  frameId: string;
  bands: MarkedBand[];
  rawRepresentation: Record<string, unknown>;
}

export interface MarkedBand {
  bandRef: string; // 稳定身份：L{laneOrdinal}-B{rank}
  laneRef: string;
  center: PixelPoint;
  widthPx: number | null;
  saturation: number; // 0..1，1=完全饱和
  tailing: number; // 0..1，拖尾程度
  overlapGroupId: string | null;
  provenance: PixelProvenance;
}

export type Material =
  | ImageMaterial
  | CaptureMetadataMaterial
  | LadderSpecMaterial
  | LaneAnnotationMaterial
  | BandAnnotationMaterial;

/** ---- 事件（决定层，append-only）---- */

export type EventType =
  | 'IMPORT_BUNDLE'
  | 'RUN_DETECTION'
  | 'RUN_CALIBRATION'
  | 'RUN_INFERENCE'
  | 'ACCEPT_RESULT'
  | 'REJECT_RESULT'
  | 'REVISE_PARAMS'
  | 'REPLACE_SOURCE'
  | 'MARK_FINDING'
  | 'BRANCH'
  | 'CHECKOUT'
  | 'EXPORT'
  | 'IMPORT_PROJECT';

export interface Event {
  id: string; // 内容寻址：hash(prevId + branchId + seq + payload)
  branchId: string;
  seq: number; // 该分支链上的序号（fork 点继承父链）
  parentEventId: string | null;
  forkFromEventId: string | null; // 新分支首事件指向父分支分叉事件
  type: EventType;
  at: string; // ISO 时间基准
  actor: 'auto' | 'reviewer' | 'system';
  payload: Record<string, unknown>;
  /** 本次事件产生或失效的派生结果 id，构成依赖边。 */
  produces: string[];
  invalidates: string[];
}

export interface Branch {
  id: string;
  name: string;
  parentBranchId: string | null;
  forkEventId: string | null;
  createdAt: string;
}

/** ---- 派生结果（内容寻址，不可变）---- */

export interface DetectedBand extends MarkedBand {
  peakIntensity: number;
  plateau: boolean;
  status: 'detected' | 'saturated' | 'tailing' | 'overlapping';
  confidence: number; // 0..1
}

export interface DetectionResult {
  id: string;
  kind: 'detection';
  frameId: string;
  bandMaterialId: string | null; // 若有外部条带标注
  paramsVersion: string;
  parentIds: string[]; // 材料 id
  bands: DetectedBand[];
  laneProfiles: LaneProfile[];
  diagnostics: Diagnostic[];
  inputSummary: Record<string, unknown>;
}

export interface LaneProfile {
  laneRef: string;
  /** 沿中心线弧长 s(px) → 平均强度；用于叠加轮廓。 */
  samples: { s: number; intensity: number }[];
}

export interface LadderMappingPoint {
  bandRef: string;
  entryOrdinal: number;
  s: number; // 沿 ladder 泳道中心线的弧长 px
  center: PixelPoint;
  nominal: QuantitativeValue;
  residual: number | null; // 拟合残差（log 空间）
  valid: boolean;
}

export interface CalibrationSegment {
  index: number;
  fromEntryOrdinal: number;
  toEntryOrdinal: number;
  /** 有效区域：沿 sample 泳道中心线弧长分数 f=s/L 的闭区间。 */
  validRange: { sMin: number; sMax: number; fMin: number; fMax: number };
  logIntercept: number;
  logSlope: number; // d(log10 MW)/df
  ladderPointIds: string[];
}

export interface CalibrationResult {
  id: string;
  kind: 'calibration';
  frameId: string;
  ladderLaneRef: string;
  unit: Unit;
  paramsVersion: string;
  parentIds: string[];
  ladderPoints: LadderMappingPoint[];
  segments: CalibrationSegment[];
  /** 候选配对：缺带时保留全部合法候选。 */
  pairingCandidates: { preferred: boolean; assignment: { bandRef: string; entryOrdinal: number }[]; score: number }[];
  diagnostics: Diagnostic[];
  inputSummary: Record<string, unknown>;
}

export type InferenceStatus =
  | 'unique'
  | 'candidate'
  | 'interval'
  | 'interval'
  | 'out_of_range'
  | 'unresolved';

export interface MwCandidate {
  value: number;
  unit: Unit;
  segmentIndex: number;
  ladderPointIds: string[];
}

export interface InferenceResult {
  id: string;
  kind: 'inference';
  frameId: string;
  calibrationId: string;
  paramsVersion: string;
  parentIds: string[];
  perBand: InferredBand[];
  diagnostics: Diagnostic[];
  inputSummary: Record<string, unknown>;
}

export interface InferredBand {
  bandRef: string;
  laneRef: string;
  center: PixelPoint;
  arcLength: number; // px
  fraction: number; // f=s/L
  status: InferenceStatus;
  point: MwCandidate | null; // 唯一解
  candidates: MwCandidate[]; // 无法唯一决定时的全部合法候选
  interval: { low: number; high: number; unit: Unit } | null; // 饱和/拖尾/重叠→区间
  reasons: DiagnosticCode[];
  segmentIndex: number | null;
}

export type DerivedResult = DetectionResult | CalibrationResult | InferenceResult;

/** 带稳定身份的显示值：界面上每个数字都能回溯。 */
export interface DisplayValue {
  id: string; // 稳定身份
  value: number | null;
  unit: Unit | null;
  source:
    | { kind: 'material'; materialId: string; path: string }
    | { kind: 'derived'; resultId: string; path: string }
    | { kind: 'event'; eventId: string; path: string };
  valid: boolean;
  invalidReason?: DiagnosticCode;
}

export type ErrorKind =
  | 'BUDGET_EXHAUSTED'
  | 'FORMAT_CORRUPT'
  | 'SEMANTIC_UNRESOLVABLE';

export interface AppError {
  kind: ErrorKind;
  message: string;
  diagnostics: Diagnostic[];
}
