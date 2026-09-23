// 胶道标尺工作台 —— 领域类型
// 分层原则：
//   不可变材料(Material*) 与可修改决定(Decision*) 分离；
//   所有派生结果(Derivation)记录输入摘要、参数版本、父级依赖；
//   所有领域量携带单位或坐标基准；无法转换的值留在原位置并附诊断。

export type Brand<K, T> = K & { readonly __brand: T };

/** 稳定身份（导入导出后保持不变）。 */
export type Id = string;

/** 内容摘要（sha256 十六进制）。 */
export type Sha256 = Brand<string, 'sha256'>;

/** 语义版本，例如 "1.0.0"。 */
export type SemVer = string;

export const RULE_VERSION: SemVer = '1.0.0';

// ---------- 单位与坐标基准 ----------

export type LengthUnit = 'px';
export type TimeUnit = 's' | 'ms';
export type MassUnit = 'bp' | 'kDa';
export type GrayUnit = 'gray8';

/** 带单位的量；raw 保留导入时的原始表示（规范化前）。 */
export interface Quantity<V = number, U extends string = string> {
  value: V;
  unit: U;
  /** 原始表示（字符串形式或原值），导入时保留。 */
  raw?: string;
}

/** 以图像左上角为原点的像素坐标；x 向右、y 向下。图像旋转后须声明基准。 */
export interface PixelPoint {
  x: number; // px
  y: number; // px
}

/** 像素长度。 */
export interface PixelLength {
  value: number;
  unit: 'px';
}

export interface Transform2D {
  /** 行主序 2x3 仿射： [a,b,tx, c,d,ty]，作用于旧坐标 -> 当前图像坐标 */
  a: number; b: number; tx: number;
  c: number; d: number; ty: number;
  sourceImageId: Id;
  targetImageId: Id;
}

export interface ValidRegion {
  /** 弧长迁移坐标的有效区间（px，自加样端）。 */
  sMin: Quantity<number, LengthUnit>;
  sMax: Quantity<number, LengthUnit>;
  reason?: string;
}

// ---------- 材料（不可变） ----------

export interface MaterialImage {
  kind: 'image';
  id: Id;
  name: string;
  width: number;
  height: number;
  channels: 1 | 3;
  /** PNG 字节（灰度或 RGB）。 */
  bytesBase64: string;
  bytesSha256: Sha256;
  exposure: Quantity<number, TimeUnit>;
  /** 拍摄方向：图像顶部相对凝胶加样端的方向。 */
  orientation: 'wells-at-top' | 'wells-at-bottom' | 'wells-at-left' | 'wells-at-right' | 'unknown';
  /** 旋转角（度，逆时针为正），0 表示原图。 */
  rotationDeg: number;
  transformFrom?: Transform2D;
  capturedAt: string; // ISO-8601
  note?: string;
}

export interface LadderNominal {
  rungId: Id;
  /** 标称分子量（bp 或 kDa）。 */
  nominal: Quantity<number, MassUnit>;
  /** 标签，例如 "1500bp"。 */
  label: string;
}

export interface MaterialLadderSpec {
  kind: 'ladderSpec';
  id: Id;
  name: string;
  /** 标称值按分子量降序（凝胶自上而下）。 */
  rungs: LadderNominal[];
  /** 非单调标尺标记：测试用，故意把某一档写成破坏单调性的值。 */
  nonMonotonic?: { rungId: Id; expectedOrder: 'descending-by-mass' };
  rawText?: string;
}

export interface MaterialLaneBoundary {
  kind: 'laneBoundary';
  id: Id;
  imageId: Id;
  laneIndex: number;
  /** 左/右边界曲线（像素折线，图像坐标）。像素级来源。 */
  left: PixelPoint[];
  right: PixelPoint[];
  /** 中脊（由边界推出，用于弧长参数化）。 */
  spine: PixelPoint[];
  source: 'auto-candidate' | 'manual';
}

export interface MaterialBandCenter {
  kind: 'bandCenter';
  id: Id;
  imageId: Id;
  laneId: Id;
  /** 条带中心（图像像素坐标）。 */
  center: PixelPoint;
  /** 自动检测给出的轮廓（沿中脊采样的灰度剖面）。 */
  profile: { s: number; gray: number }[];
  /** 沿中脊自加样端的弧长（px）。 */
  arcLength: Quantity<number, LengthUnit>;
  peakGray: number; // gray8
  saturated: boolean;
  tailing: boolean;
  source: 'auto-candidate' | 'manual';
  /** 与相邻重叠条带的配对 id。 */
  overlapsWith?: Id[];
  /** 半高宽 px。 */
  fwhm: Quantity<number, LengthUnit>;
}

export type Material =
  | MaterialImage
  | MaterialLadderSpec
  | MaterialLaneBoundary
  | MaterialBandCenter;

export type MaterialKind = Material['kind'];

// ---------- 决定（可修订、可冲突） ----------

export type DecisionType =
  | 'accept-ladder-assignment'
  | 'reject-band'
  | 'accept-band'
  | 'choose-mw-candidate'
  | 'override-interpolation'
  | 'parameter-revision'
  | 'note';

export interface DecisionEvent {
  kind: 'decision';
  id: Id;
  caseId: Id;
  seq: number;
  /** 稳定顺序键：(seq, id)，等价输入得到稳定顺序。 */
  orderKey: string;
  at: string;
  author: string;
  type: DecisionType;
  /** 被作用对象（band / lane / rung / calibration 的稳定 id）。 */
  targetId: Id;
  payload: Record<string, unknown>;
  /** 决定所依据的派生结果（读回时恢复当时版本）。 */
  basedOnDerivationId?: Id;
  /** 冲突的决定 id（互相冲突的人工决定同时保留）。 */
  conflictsWith?: Id[];
  supersedes?: Id[];
  note?: string;
}

export interface MaterialEvent {
  kind: 'material';
  id: Id;
  caseId: Id;
  seq: number;
  orderKey: string;
  at: string;
  material: Material;
  /** 修订来源：只改动一个直接来源时，指向被取代的材料事件 id。 */
  supersededEventId?: Id;
  /** 来源描述（像素级来源等）。 */
  provenance: string;
  note?: string;
}

export type Event = MaterialEvent | DecisionEvent;

// ---------- 诊断（带位置，不用空值伪装成功） ----------

export type Severity = 'error' | 'warning' | 'info';

export interface Diagnostic {
  code:
    | 'missing-input'
    | 'unconvertible-value'
    | 'missing-ladder-band'
    | 'saturated-band'
    | 'tailed-band'
    | 'overlapping-bands'
    | 'non-monotonic-ruler'
    | 'outside-valid-region'
    | 'local-validity-failed'
    | 'multiple-candidates'
    | 'format-corrupt'
    | 'semantic-impossible'
    | 'resource-budget-exhausted'
    | 'conflicting-decision';
  severity: Severity;
  message: string;
  /** 带位置：材料/对象 id 与像素坐标（如适用）。 */
  at?: { materialId?: Id; bandId?: Id; laneId?: Id; rungId?: Id; point?: PixelPoint; eventSeq?: number };
}

// ---------- 派生结果（不可变，内容寻址） ----------

export interface CalibrationRungResult {
  rungId: Id;
  label: string;
  nominal: Quantity<number, MassUnit>;
  /** 对应检测到的 ladder 条带 id；缺带时为 null（绝不用默认值伪装）。 */
  bandId: Id | null;
  s: Quantity<number, LengthUnit> | null;
  residualLog: number | null;
  status: 'matched' | 'missing' | 'ambiguous';
  candidates?: Id[];
}

export interface CalibrationSegment {
  id: Id;
  fromRungId: Id;
  toRungId: Id;
  /** log(mass) 关于 s 的线性段参数（弧长空间）。 */
  slope: number;
  intercept: number;
  massUnit: MassUnit;
  /** 该插值段覆盖的弧长区间与有效区域。 */
  sMin: number;
  sMax: number;
  valid: boolean;
  invalidReason?: string;
}

export interface DerivationCalibration {
  kind: 'calibration';
  ladderLaneId: Id;
  rungs: CalibrationRungResult[];
  segments: CalibrationSegment[];
  /** 局部标尺有效区域（弧长）。 */
  validRegion: ValidRegion;
  /** 忽略弯曲、直接用图像 y 的“朴素”标尺，供证据对比。 */
  naiveSegments: CalibrationSegment[];
  status: 'ok' | 'degraded' | 'failed';
}

export interface MWCandidate {
  mass: Quantity<number, MassUnit>;
  segmentId: Id;
  /** 候选来源：弧长局部标尺 / 区间 / 朴素y（仅证据对照）。 */
  basis: 'local-arc-ruler' | 'interval' | 'naive-y' | 'manual';
  /** 区间质量上下界（饱和/重叠/拖尾只能给区间或候选）。 */
  range?: { min: Quantity<number, MassUnit>; max: Quantity<number, MassUnit> };
}

export interface DerivationBandMW {
  kind: 'band-mw';
  bandId: Id;
  laneId: Id;
  /** 全部合法候选；无法唯一决定时不强行收敛。 */
  candidates: MWCandidate[];
  acceptedCandidate?: MWCandidate;
  status: 'unique' | 'candidate-set' | 'interval-only' | 'outside-valid-region' | 'failed';
  failureReason?: string;
  /** 自动候选值；人工修订值（若有）。 */
  auto?: MWCandidate;
  manual?: MWCandidate;
  diagnostics: Diagnostic[];
}

export type DerivationBody = DerivationCalibration | DerivationBandMW;

export interface Derivation<B extends DerivationBody = DerivationBody> {
  id: Id; // 内容寻址：derivation:<sha256(规范JSON)>
  ruleVersion: SemVer;
  paramsVersion: Id;
  inputsSha256: Sha256[];
  parents: Id[];
  body: B;
  diagnostics: Diagnostic[];
}

// ---------- 事件流快照投影 ----------

export interface CaseState {
  caseId: Id;
  title: string;
  /** 当前生效的图像（考虑旋转材料链）。 */
  currentImageId: Id | null;
  images: Record<Id, MaterialImage>;
  ladderSpec: MaterialLadderSpec | null;
  lanes: Record<Id, MaterialLaneBoundary>;
  bands: Record<Id, MaterialBandCenter>;
  /** 每条 lane 的最新检测结果（按 laneId）。 */
  calibrations: Record<Id, Derivation<DerivationCalibration>>;
  bandMW: Record<Id, Derivation<DerivationBandMW>>;
  /** 所有历史派生（内容寻址，永不被覆盖）。 */
  derivations: Record<Id, Derivation>;
  decisions: DecisionEvent[];
  /** 当前事件序列编号上界（回放到某 seq 的视图）。 */
  headSeq: number;
  diagnostics: Diagnostic[];
}

// ---------- 案例包（离线领域材料） ----------

export interface CaseMeta {
  id: Id;
  code: string;
  title: string;
  narrative: string;
  tags: string[];
  phase: number;
}

export interface CaseFile {
  format: 'gel-ruler-case';
  formatVersion: SemVer;
  case: CaseMeta;
  events: Event[];
  /** 派生结果随包保存（被采纳与未采纳都保留）。 */
  derivations: Derivation[];
  createdAt: string;
  packSha256?: Sha256;
}

export interface CaseLibraryFile {
  format: 'gel-ruler-library';
  formatVersion: SemVer;
  cases: CaseFile[];
  packSha256?: Sha256;
}
