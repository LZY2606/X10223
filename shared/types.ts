/**
 * 领域核心类型。所有领域量都携带单位或坐标基准；
 * 导入保留原始表示（raw* 字段），派生层才做规范化。
 */

// ---------- 单位 / 基准 ----------
export type TimeUnit = "ms";
export type LengthUnit = "px" | "mm";
export type MassUnit = "kDa" | "bp" | "nt";
export type AngleUnit = "deg";
export type PixelUnit = "px";
export type CoordinateFrameId = string;

export interface Unit {
  kind: "time" | "length" | "mass" | "angle" | "pixel" | "dimensionless";
  symbol: string;
}

/** 带单位、带原始表示的标量。无法转换时 value=null 并保留 raw + 诊断。 */
export interface Quantity {
  value: number | null;
  unit: string;
  raw: string;
  /** 原始字符串出现的位置（字节/行/列/字段路径），用于带位置诊断。 */
  loc?: SourceLoc;
  note?: string;
}

export interface SourceLoc {
  path: string;
  line?: number;
  col?: number;
  offset?: number;
  field?: string;
}

// ---------- 坐标基准 ----------
/**
 * 像素坐标系：原点左上，x 向右，y 向下，单位 px。
 * 图像旋转/重采样后生成新 frame，旧标注引用旧 frame，不静默重投影。
 */
export interface CoordinateFrame {
  id: CoordinateFrameId;
  origin: "top-left";
  axisX: "right";
  axisY: "down";
  unit: PixelUnit;
  width: number;
  height: number;
  /** 从父 frame 到本 frame 的有依据变换；原图 parentFrameId=null。 */
  transform?: {
    parentFrameId: CoordinateFrameId;
    type: "rotate90cw" | "rotate90ccw" | "rotate180";
    /** 变换依据事件 id。 */
    reasonEventId: string;
  };
}

// ---------- 图像 / 拍摄方向 / 曝光（不可变材料）----------
export interface OrientationInfo {
  /** 拍摄方向：胶孔在图像中的方位。 */
  wellsSide: "top" | "bottom" | "left" | "right" | "unknown";
  /** 相对标准方向（孔在上）需要旋转的角度，单位 deg，0/90/180/270。 */
  rotationToStandard: Quantity;
  raw: string;
  loc?: SourceLoc;
}

export interface ExposureInfo {
  /** 曝光时长，ms；无法转换保留 raw + 诊断。 */
  duration: Quantity;
  gain: Quantity;
  bitDepth: number;
  saturatedValue: number;
  raw: string;
  loc?: SourceLoc;
}

export interface GelImageMaterial {
  id: string;
  kind: "gelImage";
  filename: string;
  mediaType: string;
  width: number;
  height: number;
  frameId: CoordinateFrameId;
  blobRef: BlobRef;
  pixelHash: string;
  orientation: OrientationInfo;
  exposure: ExposureInfo;
  importedAt: string;
  loc?: SourceLoc;
}

export interface BlobRef {
  blobId: string;
  sha256: string;
  byteLength: number;
}

// ---------- ladder 标称值（不可变材料，导入原样保留）----------
export interface LadderNominalEntry {
  id: string;
  /** 标称分子量原始表示，例如 "100 kDa"、"75"、"abc"。 */
  nominal: Quantity;
  /** 该标称带在 ladder 泳道中自上而下的序号（从 1 开始）；未知为 null。 */
  rankFromTop: number | null;
  loc?: SourceLoc;
}

export interface LadderNominalMaterial {
  id: string;
  kind: "ladderNominal";
  name: string;
  massUnit: MassUnit;
  entries: LadderNominalEntry[];
  rawText: string;
  loc?: SourceLoc;
}

// ---------- 泳道曲线（候选 / 已接受 均为带状态的结构）----------
/** 泳道中心线：以弧长参数化的 Catmull-Rom 曲线，点坐标在某 frame 内。 */
export interface LaneCurve {
  id: string;
  laneIndex: number;
  isLadder: boolean;
  /** 控制点（px，frame 坐标），自上而下（迁移方向）。 */
  points: PixelPoint[];
  /** 泳道边界（半宽，px），可逐点变化；来自材料或检测。 */
  halfWidths: number[];
  frameId: CoordinateFrameId;
  status: LaneStatus;
  origin: OriginRef;
}

export type LaneStatus = "candidate" | "accepted" | "rejected" | "superseded";

export interface PixelPoint {
  x: number;
  y: number;
}

export interface OriginRef {
  /** 自动检测 / 材料导入 / 人工修订 */
  source: "auto" | "material" | "manual";
  materialId?: string;
  eventId: string;
  /** 人工修订时所基于的上游 lane/band id（父级依赖）。 */
  basedOn?: string;
  loc?: SourceLoc;
}

// ---------- 条带中心（像素级来源）----------
export interface Band {
  id: string;
  laneId: string;
  /** 中心（px，frame 坐标）。 */
  center: PixelPoint;
  /** 沿泳道中心线的弧长坐标 s（px），从最靠孔端起算。 */
  s: number;
  frameId: CoordinateFrameId;
  status: BandStatus;
  origin: OriginRef;
  evidence: BandEvidence;
  /** 多解时所属候选组；同组内所有合法候选都保留。 */
  ambiguityGroup?: string;
  /** 分子量结论（派生，带有效区间）。 */
  call?: BandCall;
}

export type BandStatus =
  | "candidate"
  | "accepted"
  | "rejected"
  | "superseded"
  | "saturated-candidate"
  | "smear-interval"
  | "overlap-group";

export interface BandEvidence {
  /** 轮廓（背景扣除后强度沿 s 的采样，用于叠加显示与重算）。 */
  profile: ProfileSample[];
  peakIntensity: number;
  /** 饱和：峰附近是否存在 >= saturatedValue 的像素。 */
  saturated: boolean;
  saturatedPixels: number;
  /** 拖尾：高于尾部阈值的延展长度（px）。 */
  tailLengthPx: number | null;
  /** 重叠：与相邻条带轮廓的重叠面积占比（0..1），无则 null。 */
  overlapRatio: number | null;
  /** 轮廓所在像素区域（frame 坐标），支持回到像素级来源。 */
  bbox: { x0: number; y0: number; x1: number; y1: number };
  /** 残差（检测/拟合阶段）。 */
  fitResidual: number;
}

export interface ProfileSample {
  s: number;
  intensity: number;
}

export interface BandCall {
  /** 唯一结论的分子量；区间或多解时为 null。 */
  value: Quantity | null;
  /** 合法区间（kDa/bp，端点开/闭由 inclusive 控制）。 */
  interval?: { low: Quantity; high: Quantity; inclusive: boolean };
  /** 无法唯一决定时的全部合法候选（每个带稳定身份）。 */
  candidates?: BandCandidate[];
  /** 该结论用到的插值段（ladder 点身份对）。 */
  segment: CalibrationSegmentId | null;
  /** 是否落在标尺有效区域内。 */
  withinValidRegion: boolean;
  state: CallState;
  reasons: string[];
  /** 输入摘要 + 参数版本 + 父级依赖（派生记录的三要素，见 compute 层）。 */
  derivationId?: string;
}

export type CallState = "unique" | "interval" | "ambiguous-candidates" | "out-of-range" | "invalid";

export interface BandCandidate {
  id: string;
  value: Quantity;
  reasons: string[];
  segment: CalibrationSegmentId | null;
}

export interface CalibrationSegmentId {
  calibrationId: string;
  index: number;
}

// ---------- 标尺 / 校准（派生，含有效区域）----------
export interface LadderPoint {
  id: string;
  nominalEntryId: string;
  bandId: string;
  s: number;
  nominal: Quantity;
}

export interface CalibrationSegment {
  index: number;
  lowPointId: string;
  highPointId: string;
  /** 段内插值模型 log(mass) ~ s 的线性参数。 */
  slope: number;
  intercept: number;
  /** 段是否单调有效；非单调标尺会产生失效段。 */
  valid: boolean;
  invalidReason?: string;
}

export interface ValidRegion {
  /** 弧长有效范围（px）。 */
  sMin: number;
  sMax: number;
  massMin: Quantity;
  massMax: Quantity;
  /** 缺带造成的内部洞：这些 s 区间内不插值（外推/内插均拒绝）。 */
  holes: { sLo: number; sHi: number; reason: string }[];
}

export interface CalibrationResult {
  id: string;
  laneId: string;
  ladderNominalId: string;
  gelImageId: string;
  ladderPoints: LadderPoint[];
  segments: CalibrationSegment[];
  validRegion: ValidRegion | null;
  state: CalibrationState;
  diagnostics: Diagnostic[];
  /** 输入摘要。 */
  inputs: InputDigest[];
  /** 参数版本。 */
  paramsVersion: string;
  params: CalibrationParams;
  /** 父级依赖（上游结构 id 与校准 id）。 */
  parents: string[];
  computedAt: string;
  /** 非单调/缺带等结构问题的机器可读事件。 */
  events: DomainEventRecord[];
}

export type CalibrationState = "ok" | "degraded" | "semantic-unsolvable";

export interface CalibrationParams {
  interpolation: "linear-in-log-mass";
  /** 超出最外侧 ladder 点是否允许外推；默认 false，禁止外推。 */
  extrapolate: boolean;
  /** 峰/饱和/重叠判定阈值版本化。 */
  saturationQuantile: number;
  overlapRatioThreshold: number;
  tailRatioThreshold: number;
  /** 资源预算（像素数），耗尽返回 budget-exhausted。 */
  maxPixels: number;
}

export const DEFAULT_PARAMS_VERSION = "calib-1.0.0";

export function defaultParams(): CalibrationParams {
  return {
    interpolation: "linear-in-log-mass",
    extrapolate: false,
    saturationQuantile: 1,
    overlapRatioThreshold: 0.25,
    tailRatioThreshold: 0.08,
    maxPixels: 64_000_000,
  };
}

export interface InputDigest {
  role: "gelImage" | "ladderNominal" | "laneSet" | "params";
  id: string;
  sha256: string;
}

// ---------- 诊断（带位置；三类失败互斥）----------
export type FailureClass = "budget-exhausted" | "format-corrupt" | "semantic-unsolvable" | null;

export interface Diagnostic {
  code: string;
  severity: "info" | "warning" | "error";
  message: string;
  loc?: SourceLoc;
  failureClass: FailureClass;
  subjectIds?: string[];
}

// ---------- 机器可读领域事件（结构化状态，非日志）----------
export type DomainEventType =
  | "image.rotated"
  | "lane.bent"
  | "lane.revised"
  | "ladder.band-missing"
  | "band.saturated"
  | "band.smear"
  | "bands.overlap"
  | "ruler.non-monotonic"
  | "ruler.valid-region"
  | "calibration.locally-invalidated"
  | "call.candidate-only"
  | "call.interval-only"
  | "decision.accepted"
  | "decision.rejected"
  | "decision.parameter-revision"
  | "decision.conflict";

export interface DomainEventRecord {
  type: DomainEventType;
  at: string;
  subjectIds: string[];
  payload: Record<string, unknown>;
}

// ---------- 追加式事件（决定历史 / 分支）----------
export type AppendEvent =
  | { type: "project-created"; projectId: string; name: string; at: string }
  | { type: "material-added"; at: string; material: GelImageMaterial | LadderNominalMaterial; parentId: string | null }
  | {
      type: "auto-candidates-committed";
      at: string;
      gelImageId: string;
      lanes: LaneCurve[];
      bands: Band[];
      diagnostics: Diagnostic[];
      paramsVersion: string;
      derivationId: string;
      inputs: InputDigest[];
    }
  | {
      type: "lane-revised";
      at: string;
      lane: LaneCurve;
      supersededLaneId: string;
      movedBandIds: { oldBandId: string; band: Band }[];
      reason: string;
    }
  | {
      type: "decision";
      at: string;
      decisionId: string;
      branchId: string;
      subject: { kind: "lane" | "band" | "calibration"; id: string };
      action: "accept" | "reject" | "adjust";
      fromState: string;
      toState: string;
      note?: string;
      basedOnEventId: string | null;
    }
  | {
      type: "params-revised";
      at: string;
      revisionId: string;
      branchId: string;
      oldVersion: string;
      newVersion: string;
      patch: Partial<CalibrationParams>;
      reason: string;
    }
  | {
      type: "branch-created";
      at: string;
      branchId: string;
      parentBranchId: string;
      fromEventId: string;
      name: string;
    }
  | {
      type: "computation-published";
      at: string;
      branchId: string;
      calibration: CalibrationResult;
      calls: { bandId: string; call: BandCall }[];
      basedOnEventId: string;
    };

export interface StoredEvent {
  id: string;
  projectId: string;
  branchId: string;
  seq: number;
  parentEventId: string | null;
  at: string;
  payload: AppendEvent;
  hash: string;
}

export interface ProjectExport {
  format: "gel-ruler-workbench";
  formatVersion: 1;
  exportedAt: string;
  projectId: string;
  name: string;
  blobs: { blobId: string; sha256: string; mediaType: string; bytesB64: string }[];
  events: StoredEvent[];
  branches: { branchId: string; name: string; parentBranchId: string | null; createdAt: string }[];
}

export interface ProjectState {
  projectId: string;
  name: string;
  materials: Map<string, GelImageMaterial | LadderNominalMaterial>;
  blobs: Map<string, { sha256: string; mediaType: string }>;
  lanes: Map<string, LaneCurve>;
  bands: Map<string, Band>;
  frames: Map<string, CoordinateFrame>;
  calibrations: Map<string, CalibrationResult>;
  latestCalibrationByLane: Map<string, string>;
  callsByBand: Map<string, BandCall>;
  branchHeads: Map<string, string>;
  currentBranch: string;
  decisionsBySubject: Map<string, string[]>;
}
