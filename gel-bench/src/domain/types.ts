/**
 * 领域类型。分层原则：
 *  - Material（不可变材料）：原图/拍摄方向/曝光/ladder 标称值/lane 曲线/band 中心，
 *    全部保留像素级来源与原始表示(raw)，导入时不做规范化。
 *  - Event（可修改决定）：append-only 的决定历史，支持分支与回放。
 *  - Derived（派生结果）：由 材料+事件+参数版本+父依赖 确定，带输入摘要与失效原因。
 */

export type UnitName = 'bp' | 'kDa' | 'px' | 'deg' | 'ms' | 'ratio' | 'uint16' | 'count';

export interface Qty {
  value: number;
  unit: UnitName;
}

export interface PixelPoint {
  x: number; // px, 图像坐标系
  y: number; // px
}

/** 坐标基准：所有像素量必须能追溯到某帧、原点与方向 */
export interface CoordBasis {
  frameId: string;
  origin: 'top-left';
  axisConvention: 'x-right,y-down';
  rotationAppliedDeg: number;
}

export type MaterialType =
  | 'image'
  | 'orientation'
  | 'exposure'
  | 'ladder_nominal'
  | 'lane_trace'
  | 'band_center';

export interface MaterialBase {
  id: string;
  projectId: string;
  type: MaterialType;
  /** 导入时的原始表示，不规范化、不丢弃无法转换的值 */
  raw: Record<string, unknown>;
  /** raw 中结构化字段的来源路径（像素级来源/原始键路径） */
  provenance: Record<string, string>;
  importedAs: string; // 原始单位/表示，例如 "uint16"、"degCCW"
  createdAtLogical: number; // 逻辑时钟，仅用于排序展示
}

export interface ImageMaterial extends MaterialBase {
  type: 'image';
  blobSha256: string;
  width: number;
  height: number;
  channels: number;
  bitDepth: number; // 每通道位数，如 16
  format: string; // 'png'
}

export interface OrientationMaterial extends MaterialBase {
  type: 'orientation';
  imageId: string;
  rotationDeg: number; // 顺时针旋转到“加样孔在上”所需角度，单位 deg
  flipped: boolean;
}

export interface ExposureMaterial extends MaterialBase {
  type: 'exposure';
  imageId: string;
  exposureMs: number | null; // 无法转换时为 null，诊断保留在 raw/diagnostics
  gain: number | null;
  maxEncoded: number; // 编码上限，如 65535
  saturatedPixels: PixelPoint[]; // 像素级饱和区来源
}

export interface LadderBandNominal {
  rank: number; // 从加样孔方向数，1 = 最大分子量
  molecularWeight: Qty; // 标称值，如 {value:1000,unit:'bp'}
  rawLabel: string; // 导入原始表示，如 "1.0 kb"
}

export interface LadderNominalMaterial extends MaterialBase {
  type: 'ladder_nominal';
  name: string;
  unit: UnitName;
  bands: LadderBandNominal[]; // 标称值必须单调（按迁移方向），非单调 -> 语义无解
}

export interface LaneTraceMaterial extends MaterialBase {
  type: 'lane_trace';
  frameId: string; // 该曲线所在图像帧
  laneIndex: number;
  role: 'ladder' | 'sample';
  ladderNominalId?: string;
  /** 弯曲中心线：样条控制点（像素坐标）。“微笑”时同一 y 在不同 lane 对应不同迁移 */
  centerline: PixelPoint[];
  boundaryLeft: PixelPoint[];
  boundaryRight: PixelPoint[];
  origin: PixelPoint; // 加样孔/原点（像素）
}

export type BandStatus = 'auto_candidate' | 'manual' | 'superseded' | 'rejected';

export interface BandCenterMaterial extends MaterialBase {
  type: 'band_center';
  laneId: string;
  frameId: string;
  /** 条带中心（像素，lane 中心线坐标） */
  center: PixelPoint;
  /** 条带轮廓（沿迁移轴的强度采样，用于叠加显示与拖尾判断） */
  profile: { s: number; intensity: number }[];
  widthPx: number;
  saturated: boolean; // 中心区是否触顶
  tailing: boolean; // 是否拖尾
  overlapWith?: string; // 重叠的另一条带 id
  status: BandStatus;
  author: 'auto' | 'human';
}

export type Material =
  | ImageMaterial
  | OrientationMaterial
  | ExposureMaterial
  | LadderNominalMaterial
  | LaneTraceMaterial
  | BandCenterMaterial;

export type EventType =
  | 'project_created'
  | 'material_imported'
  | 'parameter_revision'
  | 'source_replaced'
  | 'auto_analysis'
  | 'accept_candidate'
  | 'reject_candidate'
  | 'manual_edit'
  | 'conflicting_decision'
  | 'checkout_view'
  | 'annotation';

export interface DecisionEvent {
  id: string;
  projectId: string;
  seq: number;
  parentId: string | null;
  branch: string;
  type: EventType;
  payload: Record<string, unknown>;
  author: 'auto' | 'human' | 'system';
  /** 决定依据（机器可读） */
  rationale: Record<string, unknown>;
  logicalClock: number;
}

export type Severity = 'error' | 'warning' | 'info';

export type DiagnosticCode =
  | 'INCOMPLETE_INPUT'
  | 'UNCONVERTIBLE_VALUE'
  | 'FORMAT_CORRUPT'
  | 'SEMANTIC_NO_SOLUTION'
  | 'BUDGET_EXHAUSTED'
  | 'NON_MONOTONIC_SCALE'
  | 'MISSING_LADDER_BAND'
  | 'SATURATED_BAND'
  | 'TAILING_BAND'
  | 'OVERLAPPING_BANDS'
  | 'SMILE_LOCAL_SCALE'
  | 'OUT_OF_CALIBRATION_RANGE'
  | 'LOCAL_DEPENDENCY_INVALID'
  | 'CONFLICTING_DECISIONS'
  | 'ROTATION_FRAME_SHIFT';

export interface Diagnostic {
  code: DiagnosticCode;
  severity: Severity;
  message: string;
  /** 带位置的诊断：材料/事件/坐标 */
  location?: {
    materialId?: string;
    eventId?: string;
    laneId?: string;
    bandId?: string;
    at?: PixelPoint;
    jsonPath?: string;
  };
}

export interface InputSummary {
  materialIds: string[];
  eventIds: string[];
  paramVersion: string;
  parentDerivedIds: string[];
  materialHashes: Record<string, string>;
}

export type DerivedKind = 'detection' | 'calibration' | 'inference';
export type ResultState = 'ok' | 'candidate_set' | 'interval' | 'invalid';

export interface CalibrationSegment {
  ladderBandId: string;
  rank: number;
  /** 沿 lane 中心线的弧长迁移距离（px，以 origin 为 0） */
  migrationPx: number;
  normalizedMigration: number; // ratio，[0,1] 相对有效量程
  nominal: Qty;
  /** 该锚点参与的插值段有效区域（归一化迁移） */
  validRegion: { from: number; to: number };
}

export interface InferenceCandidate {
  bandId: string;
  molecularWeight?: Qty; // 唯一定论时给出
  interval?: { low: Qty; high: Qty }; // 饱和/拖尾/重叠 -> 区间
  state: ResultState;
  normalizedMigration: number;
  segmentRefs: string[]; // 回到插值段/ladder 点
  diagnostics: Diagnostic[];
}

export interface DerivedRecord {
  id: string;
  projectId: string;
  kind: DerivedKind;
  branch: string;
  atEventId: string;
  subjectId: string; // lane/band/frame id
  state: ResultState;
  inputSummary: InputSummary;
  paramVersion: string;
  parentDerivedIds: string[];
  value: Record<string, unknown>;
  diagnostics: Diagnostic[];
  /** 本地失效：哪个源改动导致该结果不再被当前视图采纳 */
  invalidatedBy?: { sourceMaterialId: string; reason: DiagnosticCode };
  logicalClock: number;
}
