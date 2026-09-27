// 胶道标尺工作台 —— 领域类型定义
// 分层：materials(不可变材料) / observations(带像素来源的观测) / params(版本化参数) / events(追加决定) / derived(派生结果)

export type Rotation = 0 | 90 | 180 | 270;

export type UnitSystem = 'bp' | 'kDa';

/** 任意领域量：保留原始表示，派生层才规范化；无法转换的值留在原位置并附诊断 */
export interface Q {
  text: string;
  unit: string;
  value: number | null;
  normUnit: string | null;
  diagnostic?: Diag;
}

export interface PixelPoint {
  x: number;
  y: number;
  /** 坐标所在帧：shot=原始拍摄帧；upright=按拍摄方向转正后的帧 */
  frame: 'shot' | 'upright';
}

export interface Location {
  kind: 'image' | 'pixel' | 'lane' | 'band' | 'ladder' | 'segment' | 'parameter';
  imageId?: string;
  laneIndex?: number;
  point?: PixelPoint;
  bandCandidateId?: string;
  ladderBandId?: string;
  segmentId?: string;
  paramSetId?: string;
}

export interface Diag {
  code: string;
  severity: 'error' | 'warning' | 'info';
  message: string;
  at?: Location;
  /** 触发该诊断的机器可读规则编号 */
  rule?: string;
}

/** 像素级来源：任何 lane 边界 / band 中心都能回到图像像素、方法与事件 */
export interface Provenance {
  origin: 'auto' | 'manual' | 'material';
  method: string;
  eventId: string;
  /** 原始拍摄帧中的像素位置（转正来源的直接证据） */
  shotPoint?: PixelPoint;
  confidence?: number;
}

// ---------- 第 0 层：不可变材料（内容寻址） ----------

export interface ExposureInfo {
  /** 原始表示，例如 "80 ms"、"1/30 s"、"自动" */
  rawText: string;
  /** 规范化为毫秒；无法转换时为 null 并保留 rawText */
  ms: number | null;
  unit: 'ms' | 's' | 'fraction-s' | 'unknown';
  convertible: boolean;
  diagnostic?: Diag;
}

export interface ImageMaterial {
  kind: 'image';
  id: string;
  mediaType: 'image/png';
  blobSha256: string;
  width: number;
  height: number;
  channels: 1;
  bitDepth: 8;
  /** 不可变事实：照片拍摄方向（相对正向的旋转角） */
  shotRotation: Rotation;
  /** 转正所需旋转（等于 -shotRotation 的规范化角） */
  uprightRotation: Rotation;
  exposure: ExposureInfo;
  /** 时间基准：ISO-8601 UTC */
  capturedAt: string;
  note?: string;
}

export interface NominalLadderBand {
  id: string;
  /** 原始标签，如 "1500"、"1.5 kbp"、"unknown" */
  label: string;
  nominal: Q;
  /** 自胶顶部(小孔)起的顺序，1 起 */
  rank: number;
}

export interface LadderMaterial {
  kind: 'ladder';
  id: string;
  name: string;
  unitSystem: UnitSystem;
  bands: NominalLadderBand[];
  note?: string;
}

export type Material = ImageMaterial | LadderMaterial;

// ---------- 第 1 层：观测（不可变，由事件产生；修订即新增，旧观测保留） ----------

export interface LaneObservation {
  kind: 'lane';
  id: string;
  imageId: string;
  laneIndex: number;
  /** 泳道中心线（upright 像素帧，像素级折线） */
  center: PixelPoint[];
  left: PixelPoint[];
  right: PixelPoint[];
  curved: boolean;
  provenance: Provenance;
}

export interface BandObservation {
  kind: 'band';
  id: string;
  imageId: string;
  laneIndex: number;
  /** 条带中心（upright 像素帧） */
  center: PixelPoint;
  /** 像素包围盒 */
  box: { x0: number; y0: number; x1: number; y1: number };
  provenance: Provenance;
}

export type Observation = LaneObservation | BandObservation;

// ---------- 第 2 层：版本化参数（不可变） ----------

export interface ParamSet {
  id: string;
  version: string;
  supersedes: string | null;
  createdAt: string;
  note: string;
  values: {
    /** 自适应基线之上的峰阈值（灰度 0..255） */
    bandThreshold: number;
    /** 峰最小间距（像素） */
    minPeakDistance: number;
    /** 饱和判定：峰内达到该灰度即视为饱和 */
    saturationFloor: number;
    /** 半峰宽超过该值（像素）视为拖尾 */
    smearWidthMax: number;
    /** 双峰间谷底低于峰高的该比例以下才允许分开，否则判为重叠 */
    overlapValleyRatio: number;
    /** log10(MW) 单调性容差 */
    monotonicTolerance: number;
    /** 微笑弯曲度上限（弧长/直线长 - 1），超出后局部标尺仅在有效区内可用 */
    maxSmileCurvature: number;
    /** 资源预算：单泳道最多候选条带数 */
    maxBandsPerLane: number;
  };
}

// ---------- 第 3 层：事件（append-only，支持分支与回放） ----------

export type EventType =
  | 'case-created'
  | 'image-added'
  | 'ladder-added'
  | 'auto-analysis'
  | 'params-revised'
  | 'lane-revised'
  | 'bands-revised'
  | 'ladder-band-disabled'
  | 'decision'
  | 'branch-created';

export interface ScopeRef {
  kind: 'image' | 'lane' | 'band' | 'ladder' | 'parameter' | 'global';
  imageId?: string;
  laneIndex?: number;
  bandObsId?: string;
  ladderBandId?: string;
  paramSetId?: string;
  id?: string;
}

export interface InputSummary {
  engineVersion: string;
  imageSha256?: string;
  ladderId?: string;
  observationSetHash: string;
  paramSetId: string;
  parentResultIds: string[];
}

export interface DecisionPayload {
  subjectId: string;
  subjectKind: 'band-inference' | 'lane' | 'calibration';
  action: 'accept' | 'reject' | 'select-candidate';
  /** 选中的候选 inference 变体 id（select-candidate 时） */
  selectedInferenceId?: string;
  rationale: string;
}

export type EventPayload =
  | { kind: 'case-created'; title: string; resultId?: string }
  | { kind: 'image-added'; imageId: string }
  | { kind: 'ladder-added'; ladderId: string }
  | {
      kind: 'auto-analysis';
      imageId: string;
      ladderId: string | null;
      paramSetId: string;
      resultId: string;
      /** 相对父结果保持同一身份（未受影响）的派生对象 id */
      unchangedIds?: string[];
      /** 本次受影响范围 */
      affectedScope?: ScopeRef[];
      /** 该次分析主动停用的 ladder 标称带 */
      disabledLadderBands?: string[];
    }
  | { kind: 'params-revised'; newParamSetId: string }
  | { kind: 'lane-revised'; imageId: string; laneIndex: number; newLaneObsId: string; resultId: string; affectedScope: ScopeRef[]; unchangedIds: string[] }
  | { kind: 'bands-revised'; imageId: string; newBandObsIds: string[]; resultId: string; affectedScope: ScopeRef[]; unchangedIds: string[] }
  | { kind: 'ladder-band-disabled'; imageId: string; ladderBandId: string; reason: string; resultId: string; affectedScope: ScopeRef[]; unchangedIds: string[] }
  | ({ kind: 'decision' } & DecisionPayload)
  | { kind: 'branch-created'; newBranchId: string; name: string };

export interface GelEvent {
  id: string;
  /** 全局单调序号（稳定顺序） */
  seq: number;
  branchId: string;
  parentIds: string[];
  prevId: string | null;
  /** Lamport 时钟，跨分支单调 */
  clock: number;
  /** 时间基准：ISO-8601 UTC */
  ts: string;
  actor: string;
  type: EventType;
  payload: EventPayload;
  inputSummary?: InputSummary;
  note?: string;
}

export interface Branch {
  id: string;
  name: string;
  parentBranchId: string | null;
  forkEventId: string | null;
  createdAt: string;
  note?: string;
}

// ---------- 第 4 层：派生结果 ----------

export interface DetectedLane {
  id: string;
  laneIndex: number;
  laneObsId: string;
  lengthPx: number;
  chordPx: number;
  /** 弯曲度 = 弧长/弦长 - 1 */
  curvature: number;
  geometryStatus: 'straight' | 'curved-ok' | 'smile-outside-region';
  validMRange: { m0: number; m1: number };
}

export interface BandCandidate {
  id: string;
  laneIndex: number;
  bandObsId: string;
  center: PixelPoint;
  /** 沿本泳道曲线的归一化迁移位置 0(孔)..1(底) */
  m: number;
  intensity: number;
  halfWidthPx: number;
  saturated: boolean;
  smeared: boolean;
  /** 饱和平台对应的迁移范围（无法唯一决定中心） */
  plateauMRange?: { mLo: number; mHi: number };
  /** 拖尾区间 */
  smearMRange?: { mLo: number; mHi: number };
  /** 重叠/合并峰覆盖的迁移范围（无法唯一定位中心） */
  mRange?: { mLo: number; mHi: number };
  /** 重叠组：同组保留全部合法候选 */
  overlapGroup?: { id: string; members: string[] };
  quality: 'unique' | 'candidate' | 'interval-only';
}

export interface CalibrationPoint {
  id: string;
  laneIndex: number;
  bandCandidateId: string;
  ladderBandId: string;
  label: string;
  m: number;
  mw: Q;
  logMW: number | null;
  valid: boolean;
  reason?: string;
  rule?: string;
}

export interface CalibrationSegment {
  id: string;
  ladderLaneIndex: number;
  startPointId: string;
  endPointId: string;
  /** 有效区域：归一化迁移闭区间（局部标尺只在该区域内有效） */
  validRegion: { m0: number; m1: number };
  /** 有效区域对应的 upright 像素 y 范围（ladder 泳道） */
  validRegionPx: { y0: number; y1: number };
  mw0: number;
  mw1: number;
  /** log10(MW) = slope * m + intercept */
  slope: number;
  intercept: number;
  valid: boolean;
  reason?: string;
  rule?: string;
}

export interface FitResidual {
  pointId: string;
  mObserved: number;
  mFitted: number;
  residualM: number;
  residualPx: number;
}

export type InferenceKind = 'unique' | 'interval' | 'candidate-set' | 'open-interval' | 'unresolved';

export interface MwCandidate {
  inferenceVariantId: string;
  mw: Q;
  segmentId: string | null;
  reason: string;
}

export interface MwInference {
  id: string;
  bandCandidateId: string;
  laneIndex: number;
  kind: InferenceKind;
  uniqueMw: Q | null;
  interval: { lo: Q; hi: Q; openLo: boolean; openHi: boolean } | null;
  candidates: MwCandidate[];
  segmentIds: string[];
  valid: boolean;
  diagnostics: Diag[];
  /** 计算结果记录输入摘要、参数版本与父级依赖 */
  inputSummary: InputSummary;
  parents: string[];
}

export type AnalysisStatus = 'ok' | 'incomplete' | 'unresolved';

export interface AnalysisResult {
  id: string;
  imageId: string;
  ladderId: string | null;
  status: AnalysisStatus;
  lanes: DetectedLane[];
  bands: BandCandidate[];
  calibPoints: CalibrationPoint[];
  segments: CalibrationSegment[];
  inferences: MwInference[];
  residuals: FitResidual[];
  diagnostics: Diag[];
  inputSummary: InputSummary;
  parents: string[];
}

export interface DecisionRecord {
  subjectId: string;
  subjectKind: DecisionPayload['subjectKind'];
  action: DecisionPayload['action'];
  selectedInferenceId?: string;
  rationale: string;
  eventId: string;
  seq: number;
  ts: string;
  actor: string;
}
