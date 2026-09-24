// ============================================================================
// 胶道标尺工作台 —— 领域类型
// 分层：不可变材料(immutable sources) / 可修改决定(decisions) / 派生结果(derived)
// 所有领域量携带单位或坐标基准；原始表示保留在 raw 字段，派生层才规范化。
// ============================================================================

/** 坐标基准：源像素(未旋转) / 显示像素(旋转后)。单位均为 px。 */
export type CoordFrame = "source_px" | "display_px";
/** 迁移方向基准：距加样端的迁移距离，单位 px（沿泳道脊线弧长）。 */

export type PixelPoint = { x: number; y: number };

/** 带单位的标量。unit 为 SI/领域单位，raw 保留导入时的原始表示。 */
export type Quant = {
  value: number;
  unit: string; // "Da" | "kDa" | "bp" | "px" | "rad" | "deg" | "ms" ...
  raw?: string; // 原始文本表示，例如 "1.5 kb"
};

// ---------------------------------------------------------------------------
// 不可变材料
// ---------------------------------------------------------------------------

export interface SourceImage {
  id: string; // img_<hash12>
  pngSha256: string;
  width: number; // source_px
  height: number; // source_px
  channels: 1 | 3;
  bitDepth: 8 | 16;
  /** 像素强度上限（8bit=255, 16bit=65535），饱和判定基准。 */
  maxIntensity: number;
  /** 饱和像素占该带区域比例阈值以上 -> saturated。 */
  saturationFracThreshold: number;
}

/** 拍摄方向：决定 source_px 如何旋转到 display_px。不可变材料。 */
export interface Orientation {
  id: string;
  imageId: string;
  /** 将原图顺时针旋转 0/90/180/270 度后进入审阅视图；单位 deg。 */
  clockwiseDeg: 0 | 90 | 180 | 270;
  /** 加样端(分子量最大侧)在显示图中的方向。 */
  loadingEdge: "top" | "bottom" | "left" | "right";
}

/** 曝光记录（不可变）。 */
export interface Exposure {
  id: string;
  imageId: string;
  durationMs: number; // 单位 ms
  gain?: number; // 无量纲
  instrument: string;
  capturedAt: string; // ISO8601 时间基准
}

/** Ladder 标称值（不可变材料）。 */
export interface LadderBandNominal {
  ordinal: number; // 自加样端起的序号，1 = 迁移最慢
  molecularWeight: Quant; // 原始单位保留
}
export interface LadderSpec {
  id: string;
  name: string;
  /** 标称分子量必须随迁移距离严格单调递减（自加样端）。 */
  bands: LadderBandNominal[];
  /** 期望检出的迁移序号 1..N；缺带检测据此进行。 */
}

// ---------------------------------------------------------------------------
// 泳道与条带（人工可修订；修订生成新事件，不覆盖历史）
// ---------------------------------------------------------------------------

export interface LaneCurve {
  id: string;
  imageId: string;
  label: string;
  /** 控制点，source_px 坐标；自加样端向远端排序。 */
  points: PixelPoint[];
  halfWidthPx: number;
  /** 来源：auto 候选还是 human 修订。 */
  provenance: "auto" | "human";
}

export type BandFlag =
  | "ok"
  | "saturated" // 饱和：只能候选
  | "tailed" // 拖尾：只能候选/区间
  | "overlapping" // 两条带重叠：保留全部合法候选
  | "missing"; // ladder 缺带

export interface BandCenter {
  id: string;
  laneId: string;
  /** 中心位置，source_px。 */
  center: PixelPoint;
  /** 沿泳道脊线的迁移距离 px（派生缓存，可重算）。 */
  intensityPeak: number; // 0..1 归一化峰值
  saturatedFraction: number; // 0..1
  provenance: "auto" | "human";
  flag: BandFlag;
  /** 重叠时：同组重叠带共享 overlapGroupId，各自是合法候选。 */
  overlapGroupId?: string;
  /** 拖尾区间的远端迁移位置 px（候选区间）。 */
  tailExtentPx?: number;
}

// ---------------------------------------------------------------------------
// 诊断：带位置；输入不完整不得伪装成功
// ---------------------------------------------------------------------------

export type DiagnosticKind =
  | "incomplete_input"
  | "format_corrupt" // 资源/格式损坏
  | "semantic_impossible" // 语义无解
  | "budget_exhausted"; // 资源预算耗尽

export interface Diagnostic {
  code: string;
  kind: DiagnosticKind;
  message: string;
  /** 位置：JSON 指针 / 像素位置 / 迁移序号，便于定位。 */
  at: { pointer?: string; pixel?: PixelPoint; ordinal?: number; laneId?: string };
}

// ---------------------------------------------------------------------------
// 派生结果：分子量推断
// ---------------------------------------------------------------------------

export interface CalibrationSegment {
  /** 该插值段使用的两个 ladder 点（迁移距离 px, log MW）。 */
  fromOrdinal: number;
  toOrdinal: number;
  migrationMinPx: number; // 有效区间 [min,max]
  migrationMaxPx: number;
  slope: number; // d(log10 MW)/d(px)
  intercept: number;
}

/** 局部标尺：带有效区域。弯曲/缺带会收窄或分裂有效区域。 */
export interface LocalRuler {
  laneId: string;
  /** 标尺依据的 ladder 带序号集合；缺带时多个候选各自给一组。 */
  basedOnOrdinals: number[];
  segments: CalibrationSegment[];
  /** 有效迁移区间 px（严格内插，不外推）。 */
  validRangePx: { min: number; max: number };
  /** 有效区域之外/局部失效原因。 */
  invalidReason?: string;
  fitResiduals: { ordinal: number; residualLogMw: number; residualPx: number }[];
  rmsResidualLogMw: number;
  candidateIndex: number; // 缺带多候选时的候选编号
  candidateTotal: number;
}

export type MwStatus = "accepted" | "candidate" | "interval" | "invalid";

export interface MwEstimate {
  bandId: string;
  laneId: string;
  /** 沿泳道迁移距离 px（不是全局 y！弯曲时同高 ≠ 同 MW）。 */
  migrationPx: number;
  /** 全部合法候选（缺带/重叠时多于一个）。 */
  possibilities: {
    rulerCandidate: number;
    molecularWeight: Quant;
    /** 拖尾/重叠时给区间，点估计为 undefined。 */
    interval?: { low: Quant; high: Quant };
    withinValidRange: boolean;
  }[];
  status: MwStatus;
  invalidReason?: string;
  /** 回到哪个 ladder 点与哪段插值。 */
  evidence: {
    segmentFromOrdinal: number;
    segmentToOrdinal: number;
    ladderBandPixel: PixelPoint[];
    rulerValidRangePx: { min: number; max: number };
  };
}

// ---------------------------------------------------------------------------
// 事件溯源（结构化状态，不只是日志）
// ---------------------------------------------------------------------------

export type EventType =
  | "project_created"
  | "image_imported"
  | "orientation_set"
  | "exposure_recorded"
  | "ladder_assigned"
  | "lane_auto_detected"
  | "lane_revised"
  | "band_auto_detected"
  | "band_revised"
  | "params_revised"
  | "auto_computed"
  | "decision" // 接受/否定/参数调整等人工决定
  | "branch_opened"
  | "diagnostic_raised";

export interface ParamsVersion {
  detectorVersion: string;
  calibrationVersion: string;
  /** 参数集合，如平滑窗长、峰值阈值、饱和阈值等。 */
  values: Record<string, number | string>;
}

export interface EventBase {
  id: string; // evt_<sha12>，对 payload+prev+时间戳 内容寻址
  projectId: string;
  branch: string; // 分支名，main 为主线
  seq: number; // 分支内单调序号
  timestamp: string;
  /** 父事件 id（分支起点指父分支分叉事件）。 */
  parentId: string | null;
  /** 输入摘要：所用材料/事件的哈希，便于局部失效判定。 */
  inputSummary: Record<string, string>;
  paramsVersion?: string; // 指向 ParamsVersion 的指纹
  type: EventType;
  payload: unknown;
  /** 该事件是否被采纳（冲突人工决定时未采纳的决定仍保留）。 */
  adopted: boolean;
}

export type DecisionVerdict = "accept" | "reject" | "adjust";

export interface DecisionPayload {
  targetType: "band" | "lane" | "molecular_weight" | "ruler";
  targetId: string;
  verdict: DecisionVerdict;
  /** adjust 时记录参数改动。 */
  adjustment?: ParamsVersion;
  reason: string;
  /** 冲突决定：同一 target 若有两个矛盾 verdict，二者都保留并标记。 */
  conflictsWith?: string[];
}

// ---------------------------------------------------------------------------
// 导出包
// ---------------------------------------------------------------------------

export interface GelPack {
  format: "gelbench/gelpack";
  formatVersion: 1;
  exportedAt: string;
  project: ProjectMeta;
  events: EventBase[];
  params: ParamsVersion[];
  blobs: { id: string; mediaType: string; bytesBase64: string; sha256: string }[];
  /** 稳定身份映射，保证往返后 id/顺序/来源关系不变。 */
  identityTable: { id: string; kind: string; bornEvent: string }[];
}

export interface ProjectMeta {
  id: string;
  name: string;
  casePackVersion: string;
  createdAt: string;
}
