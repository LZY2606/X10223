/**
 * 胶道标尺工作台领域模型。
 *
 * 分层原则（不可变材料 / 可修改决定 / 派生计算）：
 *  - Material*：原始材料与像素级来源，一经导入即不可变；修订只新增带 supersedes 的新版本。
 *  - GelEvent：决定历史（append-only），人工接受/否定/调参/冲突标记均形成事件。
 *  - Result*：计算结果，全部携带 inputSummary / paramVersion / parents，可从材料与决定完全重放。
 *  - 所有领域量携带单位或坐标基准；原始表示保留在 raw 字段，派生层才做规范化。
 */

export type UnitMass = 'bp' | 'kDa';

export interface PixelPoint {
  /** 像素坐标，基准 = 原始未旋转图像的左上原点，x 向右、y 向下 */
  x: number;
  y: number;
  frame: 'original';
}

export interface PixelPointView {
  /** 当前查看方向下的坐标，仅供叠加层渲染；证据以 frame=original 的点为准 */
  x: number;
  y: number;
  frame: 'view';
}

export type MaterialKind =
  | 'image'
  | 'orientation'
  | 'exposure'
  | 'ladderNominal'
  | 'lane'
  | 'band';

export interface MaterialBase {
  id: string;
  projectId: string;
  kind: MaterialKind;
  /** auto = 自动检测候选；human = 人工修订；imported = 原始导入材料 */
  origin: 'imported' | 'auto' | 'human';
  createdAt: number;
  /** 被本版本取代的旧材料 id；null 表示首版 */
  supersedes: string | null;
  /** 原始表示：导入时逐字保留，派生层规范化失败时仍留在原处 */
  raw: unknown;
}

export interface ImageMaterial extends MaterialBase {
  kind: 'image';
  /** 原始 PNG 字节的 sha256（hex）；字节本身存于数据库 blob 表 */
  sha256: string;
  widthPx: number;
  heightPx: number;
  bitDepth: number;
  channels: 1 | 3;
}

/** 拍摄方向。rotation90 表示把原图顺时针旋转 90° 后才是“电泳向下”的查看方向。 */
export interface OrientationMaterial extends MaterialBase {
  kind: 'orientation';
  imageId: string;
  rotation90: 0 | 1 | 2 | 3;
  flipH: boolean;
  flipV: boolean;
  /** 判定来源，如 imported-metadata / auto / human */
  rationale: string;
}

/** 曝光参数；全部为可选保留——缺失时分析必须返回带位置的诊断，不能用默认值伪装。 */
export interface ExposureMaterial extends MaterialBase {
  kind: 'exposure';
  imageId: string;
  /** 曝光时长（秒）；原始字符串/数值保留在 raw */
  exposureS: number | null;
  /** 相机增益（无量纲倍数） */
  gain: number | null;
  /** 8/16 位下理论饱和灰度（如 255 / 65535）；无法确定时为 null */
  saturationLevel: number | null;
}

export interface LadderNominalEntry {
  /** 行号（从 1 开始），用于诊断定位 */
  row: number;
  /** 原始 token，例如 "1500bp"、"big?"，逐字保留 */
  token: string;
  /** 解析后的标称值；无法转换时为 null，值留在原位并附诊断 */
  mass: number | null;
  unit: UnitMass | null;
  /** 解析诊断（无法转换时给出原因与字符区间） */
  diagnostic: string | null;
}

export interface LadderNominalMaterial extends MaterialBase {
  kind: 'ladderNominal';
  imageId: string;
  name: string;
  unit: UnitMass | null;
  entries: LadderNominalEntry[];
}

/** 泳道边界：曲线用折线/样条点表示（frame=original 像素），center 为中心线点列 */
export interface LaneMaterial extends MaterialBase {
  kind: 'lane';
  imageId: string;
  laneIndex: number;
  label: string | null;
  role: 'sample' | 'ladder';
  /** 中心曲线点列（原始像素），沿迁移方向（y 增大）排列 */
  center: PixelPoint[];
  /** 左边界点列（原始像素） */
  leftEdge: PixelPoint[];
  rightEdge: PixelPoint[];
  /** 泳道局部宽度（像素），取边界在中心处的横向距离 */
  widthPx: number;
}

export type BandFlag =
  | 'saturated'
  | 'smeared'
  | 'overlap'
  | 'ladder-missing'
  | 'ambiguous';

/** 条带中心（原始像素）与轮廓证据 */
export interface BandMaterial extends MaterialBase {
  kind: 'band';
  imageId: string;
  laneId: string;
  /** 条带中心（原始像素） */
  center: PixelPoint;
  /** 沿泳道方向的强度轮廓（迁移方向像素偏移 -> 0..1 归一化强度），用于复核叠加 */
  profile: { t: number; v: number }[];
  /** 峰值强度（0..1，相对于饱和电平） */
  peak: number;
  /** 是否饱和（峰顶命中饱和电平） */
  saturated: boolean;
  /** 是否拖尾/涂抹（峰两侧不对称或超宽） */
  smeared: boolean;
  /** 半高全宽（沿泳道方向像素） */
  fwhmPx: number;
  flags: BandFlag[];
  /** ladder 泳道中，与标称值的候选匹配（可多个，重叠/歧义时全部保留） */
  nominalCandidates: { entryRow: number; mass: number; unit: UnitMass }[];
  note: string | null;
}

export type Material =
  | ImageMaterial
  | OrientationMaterial
  | ExposureMaterial
  | LadderNominalMaterial
  | LaneMaterial
  | BandMaterial;

/** 分析参数集：每次修订产生新版本 */
export interface ParamSet {
  id: string;
  projectId: string;
  version: number;
  createdAt: number;
  /** 饱和判定阈值（峰值强度 >= 该比例视为饱和） */
  saturationThreshold: number | null;
  /** 最小峰间距（像素） */
  minPeakDistancePx: number | null;
  /** 微笑弯曲容许量（像素）；超过则禁止“同高度=同分子量” */
  smileTolerancePx: number | null;
  /** 标定插值方法 */
  interp: 'log-linear' | 'linear';
  /** 是否允许外推到有效 ladder 段之外 */
  extrapolate: boolean;
  note: string | null;
}

export type EventType =
  | 'project.created'
  | 'material.imported'
  | 'material.revised'
  | 'param.revised'
  | 'decision.accepted'
  | 'decision.rejected'
  | 'decision.conflict'
  | 'result.computed'
  | 'branch.created';

export interface GelEvent {
  id: string;
  projectId: string;
  seq: number;
  branchId: string;
  parentEventId: string | null;
  type: EventType;
  timestamp: number;
  /** 发起者：导入名、用户标识或 auto 分析器 */
  actor: string;
  /** 该事件使用的参数版本（可空：创建/导入事件） */
  paramVersion: number | null;
  payload: unknown;
  /** 人类可读说明 */
  summary: string;
}

export type DecisionVerdict = 'accepted' | 'rejected';

export interface DecisionPayload {
  /** 被判定的结果 id（如某条带的分子量推断） */
  resultId: string;
  verdict: DecisionVerdict;
  /** 人工指定值（接受候选或改写为区间时给出） */
  chosen:
    | { kind: 'point'; mass: number; unit: UnitMass }
    | { kind: 'interval'; low: number; high: number; unit: UnitMass }
    | null;
  reason: string | null;
}

/** 计算结果统一头部：输入摘要、参数版本、父级依赖 */
export interface ResultHeader {
  id: string;
  projectId: string;
  branchId: string;
  kind: 'laneProjection' | 'ladderCalibration' | 'mwInference' | 'diagnostics';
  computedAt: number;
  /** 输入摘要：材料 id -> sha/版本，确保等价输入可复算并比较 */
  inputSummary: Record<string, string>;
  paramVersion: number;
  /** 父级依赖：上游结果 id 与材料 id */
  parents: string[];
  /** 依据的事件 id（回到旧事件即恢复当时结论的锚点） */
  basisEventId: string;
  status: 'ok' | 'incomplete-input' | 'semantic-unresolvable' | 'budget-exhausted';
}

export interface Diagnostic {
  code:
    | 'MISSING_ORIENTATION'
    | 'MISSING_EXPOSURE'
    | 'MISSING_SATURATION_LEVEL'
    | 'UNCONVERTIBLE_VALUE'
    | 'LADDER_NO_VALID_SEGMENT'
    | 'LADDER_NONMONOTONIC_SEGMENT'
    | 'LADDER_MISSING_BAND'
    | 'OUTSIDE_VALID_REGION'
    | 'BAND_SATURATED'
    | 'BAND_OVERLAP'
    | 'BAND_SMEARED'
    | 'SMILE_BEND'
    | 'LOCAL_RULER_INVALIDATED'
    | 'BUDGET_EXHAUSTED';
  message: string;
  /** 带位置的诊断：材料 id / 像素点 / 行号 */
  location:
    | { kind: 'pixel'; imageId: string; x: number; y: number }
    | { kind: 'material'; materialId: string }
    | { kind: 'row'; materialId: string; row: number }
    | { kind: 'parameter'; name: string }
    | null;
}

/** 局部标尺的一段：仅在 [tLow,tHigh] 迁移范围内有效 */
export interface CalibrationSegment {
  id: string;
  ladderBandId: string;
  ladderBandIdNext: string;
  nominalLow: number;
  nominalHigh: number;
  unit: UnitMass;
  /** 迁移参数（沿 lane 曲线弧长，像素） */
  tLow: number;
  tHigh: number;
  /** log(mass) = a*t + b */
  a: number;
  b: number;
  valid: boolean;
  invalidReason: string | null;
}

export interface LaneProjectionResult extends ResultHeader {
  kind: 'laneProjection';
  laneId: string;
  bandProjection: {
    bandId: string;
    /** 原始像素中心 */
    center: PixelPoint;
    /** 投影到中心曲线的弧长（像素） */
    t: number;
    /** 中心到曲线的横向偏移（像素）；|offset| 大说明条带不在泳道内 */
    offsetPx: number;
  }[];
  diagnostics: Diagnostic[];
}

export interface LadderCalibrationResult extends ResultHeader {
  kind: 'ladderCalibration';
  laneId: string;
  ladderNominalId: string;
  segments: CalibrationSegment[];
  /** 每个 ladder 点的拟合残差（log10 标称值与拟合值之差） */
  residuals: { ladderBandId: string; t: number; nominal: number; fitted: number; residual: number }[];
  /** 标尺整体有效迁移范围（像素） */
  validTRange: { low: number; high: number } | null;
  diagnostics: Diagnostic[];
}

export interface MwCandidate {
  mass: number;
  unit: UnitMass;
  /** 产生该候选的插值段 id；区间候选可为 null */
  segmentId: string | null;
  /** 候选类型：唯一点 / 区间 / 歧义多候选 */
  kind: 'point' | 'interval' | 'ambiguous';
  low?: number;
  high?: number;
  reason: string;
}

export interface MwInferenceResult extends ResultHeader {
  kind: 'mwInference';
  bandId: string;
  laneId: string;
  /** 全部合法候选；唯一时长度 1，歧义/区间时保留全部合法候选 */
  candidates: MwCandidate[];
  /** 当前决定（人工或自动采纳）；null = 尚未决定 */
  decision: { eventId: string; verdict: DecisionVerdict; chosen: DecisionPayload['chosen'] } | null;
  diagnostics: Diagnostic[];
}

export interface DiagnosticsResult extends ResultHeader {
  kind: 'diagnostics';
  diagnostics: Diagnostic[];
}

export type AnalysisResult =
  | LaneProjectionResult
  | LadderCalibrationResult
  | MwInferenceResult
  | DiagnosticsResult;

/** 三类必须互相区分的失败结果（资源预算耗尽 / 格式损坏 / 语义无解） */
export type FailureKind = 'budget-exhausted' | 'format-corrupt' | 'semantic-unresolvable';

export class GelBenchError extends Error {
  constructor(
    public failure: FailureKind,
    message: string,
    public diagnostics: Diagnostic[] = []
  ) {
    super(message);
    this.name = 'GelBenchError';
  }
}

export interface BranchInfo {
  id: string;
  projectId: string;
  name: string;
  parentBranchId: string | null;
  forkEventId: string | null;
  createdAt: number;
}

/** 计算资源预算（像素数 / 操作数上限），耗尽必须与语义无解、格式损坏区分 */
export interface ComputeBudget {
  maxPixels: number;
  maxOps: number;
}

export const DEFAULT_BUDGET: ComputeBudget = {
  maxPixels: 2_000_000,
  maxOps: 50_000_000
};
