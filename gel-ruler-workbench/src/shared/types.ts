// 核心领域类型：所有材料分层、单位、坐标基准与事件结构都在这里集中声明。

export type MWUnit = 'bp' | 'kDa';

export interface RawQuantity {
  /** 导入时保留的原始表示，不规范化 */
  raw: string;
  unit: MWUnit;
  /** 规范化后的数值；无法转换时为 null，并在 diagnoses 里给位置诊断 */
  value: number | null;
  diagnoses: Diagnostic[];
}

export interface Diagnostic {
  code: string;
  severity: 'error' | 'warning';
  message: string;
  /** 带位置的定位信息（原始行/字段/对象 id/像素） */
  location?: string;
}

export type CoordFrame = 'source' | 'rotated';

export interface Point {
  x: number; // 像素（原始图像坐标系）
  y: number;
}

export interface Polyline {
  frame: CoordFrame;
  points: Point[];
}

export interface PixelProvenance {
  /** 像素级来源：所有坐标均为原始图像像素坐标 */
  sourceImageId: string;
  frame: CoordFrame;
  kind:
    | 'ladder-point'
    | 'lane-boundary-left'
    | 'lane-boundary-right'
    | 'lane-center'
    | 'band-center';
  x: number;
  y: number;
  /** 人工修订时指向上一版来源点 */
  derivedFrom?: string;
  note?: string;
}

export interface ImageAsset {
  id: string;
  filename: string;
  mediaType: 'image/png';
  width: number;
  height: number;
  /** 16 进制 sha256（源图字节内容），稳定身份的根 */
  sha256: string;
  bytesB64: string;
}

export type Orientation = 'as-shot' | 'rotate-90' | 'rotate-180' | 'rotate-270';

export interface ExposureInfo {
  /** 原始表示保留（如 "1.2s", "auto"），无法解析不丢弃 */
  raw: string;
  seconds: number | null;
  saturated: boolean | null;
  diagnoses: Diagnostic[];
}

export interface LadderNominal {
  id: string;
  nominal: RawQuantity;
}

export interface LadderPoint {
  id: string;
  nominalId: string;
  center: Point; // source 像素
  provenanceId: string;
  saturated: boolean;
}

export interface Lane {
  id: string;
  role: 'ladder' | 'sample';
  name: string;
  left: Polyline;
  right: Polyline;
  center: Polyline;
  /** 弯曲幅度（像素），微笑泳道 > 0 */
  bow: number;
  provenanceIds: string[];
}

export interface BandCandidate {
  id: string;
  laneId: string;
  center: Point; // source 像素
  s: number; // 沿 lane center 的弧长（像素）
  intensity: number; // 0..1
  saturated: boolean;
  /** 0..1，越大拖尾越明显 */
  tailAsymmetry: number;
  /** 重叠分组 id；同组表示无法唯一拆分 */
  overlapGroupId?: string;
  status: 'candidate' | 'accepted' | 'rejected' | 'interval';
  /** 区间标注时的上下界（bp/kDa），见 inference */
}

export interface CalibrationPoint {
  ladderPointId: string;
  nominalId: string;
  s: number; // 沿 ladder lane center 的弧长
  logMW: number;
  nominalMW: number;
}

export interface CalibrationSegment {
  index: number;
  fromPointId: string;
  toPointId: string;
  sMin: number;
  sMax: number;
  /** logMW = a*s + b，单调递减（s 随迁移增大，MW 减小） */
  a: number;
  b: number;
  valid: boolean;
  invalidReason?: string;
  /** 有效区域：仅覆盖 [sMin,sMax]，局部失效时该段 invalid */
}

export interface LadderCalibration {
  laneId: string;
  points: CalibrationPoint[];
  segments: CalibrationSegment[];
  /** 缺带造成的覆盖空洞（迁移区间，像素） */
  coverageGaps: { sMin: number; sMax: number; reason: string }[];
  diagnoses: Diagnostic[];
}

export interface MWInference {
  bandId: string;
  laneId: string;
  s: number;
  /** 区间推断时给出 [low, high]；唯一点估计时 low==high */
  mwLow: number;
  mwHigh: number;
  pointMW: number | null;
  unit: MWUnit;
  segmentIndex: number | null;
  state: 'point' | 'interval' | 'candidate' | 'unresolved';
  reasons: string[];
  /** 重叠时保留全部合法候选身份 */
  legalCandidates?: { bandId: string; mwLow: number; mwHigh: number; s: number }[];
}

export interface ParamVersion {
  paramVersion: number;
  saturationThreshold: number; // 0..1
  overlapDistancePx: number;
  tailAsymmetryThreshold: number;
  laneWidthPx: number;
  note: string;
}

export type EventType =
  | 'project-created'
  | 'image-imported'
  | 'orientation-set'
  | 'exposure-set'
  | 'ladder-nominals-imported'
  | 'ladder-lane-marked'
  | 'lane-boundaries-marked'
  | 'band-candidates-detected'
  | 'params-set'
  | 'analysis-published'
  | 'decision-made';

export interface DecisionPayload {
  bandId: string;
  action: 'accept' | 'reject' | 'revise' | 'adjust-params';
  /** revise 时人工指定的区间/点 */
  manualMW?: { low: number; high: number; unit: MWUnit };
  revisedCenter?: Point;
  note?: string;
}

export interface AnalysisPayload {
  paramVersion: number;
  inputSummary: string; // 输入摘要（内容哈希）
  parentEventIds: string[]; // 父级依赖
  ladderLaneId: string;
  sampleLaneIds: string[];
  calibration: LadderCalibration;
  inferences: MWInference[];
  events: AnalysisEvent[]; // 机器可读取的判定事件
}

/** 机器可读取的证据事件（判断依据），不只是文字日志 */
export interface AnalysisEvent {
  kind:
    | 'smile-local-ruler'
    | 'saturation-candidate'
    | 'tailing-candidate'
    | 'overlap-interval'
    | 'missing-band-gap'
    | 'non-monotonic-segment'
    | 'localized-invalidation';
  severity: 'warning' | 'error';
  message: string;
  objects: string[]; // 受影响对象 id
  validRegion?: { sMin: number; sMax: number; laneId: string };
  data?: Record<string, number | string | boolean>;
}

export interface EventPayloads {
  'project-created': { name: string; description: string };
  'image-imported': { image: ImageAsset };
  'orientation-set': { orientation: Orientation; reason: string };
  'exposure-set': { exposure: ExposureInfo };
  'ladder-nominals-imported': { unit: MWUnit; nominals: LadderNominal[] };
  'ladder-lane-marked': { laneId: string; points: LadderPoint[] };
  'lane-boundaries-marked': { lanes: Lane[] };
  'band-candidates-detected': { bands: BandCandidate[] };
  'params-set': { params: ParamVersion };
  'analysis-published': AnalysisPayload;
  'decision-made': DecisionPayload;
}

export interface EventEnvelope<T extends EventType = EventType> {
  id: string;
  projectId: string;
  branch: string;
  seq: number; // 分支内序号（等价输入 -> 等价顺序）
  type: T;
  payload: EventPayloads[T];
  parents: string[]; // 父级依赖事件 id
  inputSummary?: string; // 计算结果记录输入摘要
  paramVersion?: number; // 计算结果记录参数版本
  timestamp: string;
  /** 链：前一事件的 id（分支内），用于半写检测与重放 */
  prevId: string | null;
  /** 内容身份：canonicalJSON(type,payload,parents) 的哈希，不含 id/seq/timestamp */
  contentHash: string;
}

export interface ProjectMeta {
  id: string;
  name: string;
  description: string;
  createdAt: string;
}
