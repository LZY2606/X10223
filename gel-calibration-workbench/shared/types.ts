// 胶道标尺工作台 —— 共享领域类型（服务端/存储层/测试共用，业务规则不只在浏览器中）

/** 稳定单位。所有领域量都必须携带单位或坐标基准。 */
export type Unit =
  | 'bp' // 分子量（碱基对，对数坐标）
  | 'pixel' // 图像像素坐标
  | 'arc-length-px' // 沿弯曲泳道中心线的弧长
  | 'degree' // 旋转角度
  | 'second' // 曝光时长
  | 'count' // 无量纲计数
  | 'raw'; // 导入保留的原始表示，尚未可转换

/** 原始值记录：导入时保留原始表示，派生层才做规范化 */
export interface RawText {
  raw: string;
  unit?: string;
  convertible: boolean;
  /** 无法转换时留在原位置并附诊断，不能为了画图丢掉 */
  diagnostic?: string;
}

/** 坐标基准：所有几何坐标必须说明基于哪张图像的哪个方向 */
export interface CoordinateFrame {
  imageMaterialId: string;
  /** 坐标基于的旋转状态（拍摄方向核对后的帧），始终保留像素级来源 */
  orientationDeg: 0 | 90 | 180 | 270;
  origin: 'top-left';
  units: 'pixel';
}

export interface Point {
  x: number;
  y: number;
}

/** 像素级来源：任何派生坐标都能回到原始像素与产生它的事件 */
export interface PixelProvenance {
  frame: CoordinateFrame;
  /** 源图像像素坐标（未旋转原图坐标），保留像素级来源 */
  sourcePixels: Point[];
  originEventId: string;
  originMaterialId: string;
  /** 生成算法/人工标注与参数版本 */
  method:
    | 'import'
    | 'auto-detect'
    | 'human-annotation'
    | 'orientation-rotate'
    | 'lane-fitting'
    | 'contour-tracing';
  methodVersion: string;
  recordedAt: string;
}

// ---------- 不可变材料层（原始材料） ----------

export interface ExposureInfo {
  duration: number | null;
  durationUnit: 'second';
  /** 相机/扫描仪原始曝光设置，原始表示保留 */
  raw: string;
  isoRaw?: string;
  /** 是否过曝（材料层仅记录仪器指示，饱和判定在证据层） */
  instrumentFlag?: string;
}

export interface ImageMaterial {
  kind: 'image';
  id: string;
  caseId: string;
  /** 稳定内容身份 */
  sha256: string;
  mediaType: 'image/png';
  width: number;
  height: number;
  /** PNG 字节在数据库 blob 表中的 key */
  blobKey: string;
  /** 拍摄方向（相机 EXIF/文件名推断的原始方向） */
  declaredOrientationDeg: 0 | 90 | 180 | 270;
  /** 审阅者核对后的工作方向；null=尚未核对（输入不完整 → 诊断，不默认成功） */
  reviewedOrientationDeg: 0 | 90 | 180 | 270 | null;
  exposure: ExposureInfo;
  filename: string;
  createdAt: string;
  supersedes?: string;
}

export interface LadderBandNominal {
  nominalBp: number | null;
  nominal: RawText;
  /** 标注的像素位置（工作帧）；缺带场景故意置空 */
  markedCenter: Point | null;
  /** 该标称条带在图像中缺失（ladder 缺带） */
  missing: boolean;
}

export interface LadderSpec {
  kind: 'ladder-spec';
  id: string;
  caseId: string;
  name: string;
  /** 标称值全部保留原始表示；可转换值带 bp 单位 */
  bands: LadderBandNominal[];
  /** 标称值是否声明为单调（bp 随迁移距离递减）。非单调标尺场景置 false */
  declaredMonotonic: boolean;
  originEventId: string;
  createdAt: string;
  supersedes?: string;
}

/** 泳道边界：两条样条曲线 + 中心线，全部保留像素来源 */
export interface LaneGeometry {
  kind: 'lane-geometry';
  id: string;
  caseId: string;
  laneIndex: number;
  label: string;
  /** 中心线样条控制点（工作帧像素） */
  centerline: Point[];
  /** 左右边界样条控制点 */
  leftBoundary: Point[];
  rightBoundary: Point[];
  /** 弯曲形态标记：straight | smile（向上凸）| frown | custom */
  curvature: 'straight' | 'smile' | 'frown' | 'custom';
  provenance: PixelProvenance;
  supersedes?: string;
}

export type BandFlag =
  | 'normal'
  | 'saturated' // 饱和区：只能候选/区间
  | 'tailed' // 拖尾：只能候选/区间
  | 'overlap'; // 与相邻带重叠：保留全部合法候选

export interface BandMark {
  kind: 'band-mark';
  id: string;
  caseId: string;
  laneGeometryId: string;
  /** 条带几何中心（工作帧像素），像素级来源 */
  center: Point;
  /** 条带轮廓采样点（拟合残差/重叠证据） */
  contour: Point[];
  /** 饱和像素区域（过曝），无则空 */
  saturatedPixels: Point[];
  flags: BandFlag[];
  provenance: PixelProvenance;
  supersedes?: string;
}

export type Material = ImageMaterial | LadderSpec | LaneGeometry | BandMark;

// ---------- 可修改决定层（参数版本） ----------

export interface CalibrationParams {
  kind: 'params';
  id: string;
  caseId: string;
  version: number;
  /** 校准空间：分子量在 log(bp) 与迁移弧长之间 */
  model: 'piecewise-linear-logbp';
  /** 允许外推的弧长余量（像素）；默认不给默认值——输入不完整即诊断 */
  extrapolationTolerancePx: number;
  /** 饱和强度阈值（0-255 原始灰度，保留原始表示在 raw） */
  saturationThreshold: number;
  saturationThresholdRaw: string;
  /** 重叠判定的峰谷/峰高比阈值 */
  overlapValleyRatio: number;
  /** 非单调标尺是否允许继续：never（语义无解，不静默翻转） */
  nonMonotonicPolicy: 'reject' | 'flag-only';
  /** 缺带时是否允许跨过缺口插值（仍只能给出区间候选） */
  gapInterpolation: boolean;
  parentEventId: string;
  createdAt: string;
}

// ---------- 事件（机器可读取，append-only） ----------

export type EventType =
  | 'case.created'
  | 'material.imported'
  | 'orientation.reviewed'
  | 'auto.detected'
  | 'params.revised'
  | 'computation.completed'
  | 'decision.accepted'
  | 'decision.rejected'
  | 'decision.conflict'
  | 'branch.forked'
  | 'revision.invalidated'
  | 'export.bundle'
  | 'import.bundle';

export interface EventBase {
  id: string;
  caseId: string;
  seq: number;
  branch: string;
  parentEventId: string | null;
  type: EventType;
  recordedAt: string;
  /** 结构化事件载荷（机器可读取的判断依据） */
  payload: unknown;
  /** 当时采纳的输入快照（材料 id/版本、参数版本）——回到旧事件恢复依赖版本 */
  inputSnapshot: {
    materialIds: string[];
    paramsId: string | null;
  };
}

// ---------- 诊断（带位置；三种不同结果之一） ----------

export type DiagnosticCode =
  | 'RESOURCE_BUDGET_EXHAUSTED' // 资源预算耗尽
  | 'FORMAT_CORRUPT' // 格式损坏
  | 'SEMANTIC_NO_SOLUTION'; // 语义无解

export interface Diagnostic {
  code: DiagnosticCode;
  message: string;
  /** 带位置：图像像素/泳道/条带/标尺段 */
  location:
    | { kind: 'pixel'; frame: CoordinateFrame; point: Point }
    | { kind: 'lane'; laneGeometryId: string }
    | { kind: 'band'; bandMarkId: string }
    | { kind: 'ladder-band'; index: number }
    | { kind: 'calibration-segment'; fromBp: number | null; toBp: number | null }
    | { kind: 'document'; path: string }
    | { kind: 'image' };
  /** 失效原因（界面与导出均露出） */
  reason: string;
}

// ---------- 派生层（计算结果：记录输入摘要、参数版本与父级依赖） ----------

export interface InputDigest {
  /** 参与计算的全部输入 id 有序摘要 */
  materialIds: string[];
  shaParts: string[];
  paramsId: string;
  fingerprint: string;
}

export interface LadderCalibrationPoint {
  bandIndex: number;
  nominalBp: number;
  /** 匹配到的 ladder lane 条带 */
  bandMarkId: string;
  /** 沿中心线弧长（arc-length-px） */
  arcLengthPx: number;
  /** 工作帧像素位置（点击分子量回到 ladder 点） */
  pixel: Point;
  /** 拟合残差（log-bp 空间） */
  residualLogBp: number;
  used: boolean;
}

export interface CalibrationSegment {
  index: number;
  fromPoint: LadderCalibrationPoint;
  toPoint: LadderCalibrationPoint;
  /** 有效弧长区间（局部标尺必须带有效区域） */
  validArcRange: { min: number; max: number };
  monotonic: boolean;
  /** 该段是否跨越了 ladder 缺带缺口 */
  spansGap: boolean;
}

export interface BandInference {
  bandMarkId: string;
  laneGeometryId: string;
  arcLengthPx: number;
  pixel: Point;
  /** 全部合法候选（饱和/拖尾/重叠时保留全部，不擅自唯一化） */
  candidates: MwCandidate[];
  /** 唯一合法值时给出，否则 null（不用空值伪装成功——null 仅表示“不唯一”） */
  uniqueBp: number | null;
  status: 'unique' | 'candidate-set' | 'interval-only' | 'out-of-range' | 'no-solution';
  diagnostics: Diagnostic[];
  evidenceSegmentIndex: number | null;
}

export interface MwCandidate {
  id: string;
  bp: number;
  bpUnit: 'bp';
  /** 区间表达（饱和/拖尾）：bpLow<=bp<=bpHigh */
  bpLow: number | null;
  bpHigh: number | null;
  source: 'interpolation' | 'gap-interval' | 'overlap-split' | 'saturation-extent' | 'tail-extent';
  segmentIndex: number;
  /** 稳定身份：由输入指纹+局部证据决定，等价输入顺序稳定 */
  rationale: string;
}

export interface DerivedNode {
  kind: 'derived';
  id: string;
  caseId: string;
  /** 内容寻址：同输入同参数 → 同 id（等价输入稳定顺序） */
  inputDigest: InputDigest;
  parentDerivedId: string | null;
  ladderLaneGeometryId: string | null;
  ladderPoints: LadderCalibrationPoint[];
  segments: CalibrationSegment[];
  bands: BandInference[];
  diagnostics: Diagnostic[];
  outcome: 'ok' | 'RESOURCE_BUDGET_EXHAUSTED' | 'FORMAT_CORRUPT' | 'SEMANTIC_NO_SOLUTION';
  /** 资源预算（测试可直接调用并耗尽） */
  budget: { budget: number; spent: number; exhausted: boolean };
  createdAt: string;
}

// ---------- 决定 ----------

export interface Decision {
  id: string;
  caseId: string;
  branch: string;
  eventSeq: number;
  derivedId: string;
  bandMarkId: string | null;
  action: 'accept' | 'reject' | 'param-adjust';
  /** 人工修订后的分子量（bp）；保留为人工证据 */
  chosenBp: number | null;
  note: string;
  /** 冲突标记：同一对象在不同分支得到互相冲突的人工决定 */
  conflictsWith: string | null;
  recordedAt: string;
}
