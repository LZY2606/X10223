import type { CoordinateFrame, PxPoint, Quantity } from '../shared/units';
export type { PxPoint };
import type { Diagnostic } from '../shared/diagnostic';

/* ============================ L0 不可变材料 ============================ */

/** 拍摄方向（原始 EXIF/导入声明的来源，不被任何计算覆盖）。 */
export type Orientation = 'up' | 'right' | 'down' | 'left';

/** 曝光记录：值与单位/基准一并保留，允许原始不可换算表示。 */
export interface ExposureRecord {
  raw: string;
  normalized: { seconds: number | null };
  metadata: Record<string, string>;
}

export interface ImageMaterial {
  materialId: string;
  kind: 'raw-gel-image';
  /** 原始像素（灰度 0..255，亮带；行优先）。不可变。 */
  width: number;
  height: number;
  grayscale: Uint8Array;
  /** 原始拍摄方向来源声明。 */
  orientation: {
    declared: Orientation;
    source: 'exif' | 'import-declaration' | 'manual';
  };
  exposure: ExposureRecord;
  /** 原始来源（文件名/导入批次/内容摘要）。 */
  origin: { filename: string; importedAt: string; sha256: string };
}

/** ladder 标称值：原始字符串与规范化 bp 同时保留。 */
export interface LadderNominal {
  nominalId: string;
  quantity: Extract<Quantity, { kind: 'molecular-weight' }>;
  /** 预期序号（自上而下），用于缺带检测；可缺省表示未知。 */
  expectedIndex?: number;
}

export interface LadderMaterial {
  materialId: string;
  kind: 'ladder-spec';
  kitName: string;
  nominals: LadderNominal[];
  origin: { source: string; importedAt: string };
}

/* ============================ L1 像素级标注（带来源）============================ */

export type ProvenanceRole =
  | 'auto-candidate'
  | 'manual-revision'
  | 'material-source'
  | 'derived';

export interface PixelProvenance {
  role: ProvenanceRole;
  /** 原图坐标，永不丢失。 */
  frame: CoordinateFrame;
  /** 由哪个事件/运行产生。 */
  producerEventId?: string;
  /** 置信度（自动候选）；人工修订为 1。 */
  confidence: number;
  note?: string;
}

/** 泳道中心线为折线（支持“微笑”弯曲）。 */
export interface LaneCurve {
  /** 自井线起点沿中心线的点列。 */
  points: PxPoint[];
}

export interface LaneAnnotation {
  laneId: string;
  /** 稳定显示名，如 L1。 */
  label: string;
  centerline: LaneCurve;
  /** 边界折线：相对中心线左右各 halfWidth 像素。 */
  halfWidthPx: number;
  role: 'sample' | 'ladder';
  /** 绑定的 ladder 材料（ladder 道）或校准来源道（sample 道）。 */
  ladderMaterialId?: string;
  provenance: PixelProvenance;
  /** 修订链：新标注不覆盖旧标注。 */
  supersedesLaneId?: string;
}

export interface BandAnnotation {
  bandId: string;
  laneId: string;
  /** 条带中心（原图像素坐标）。 */
  center: PxPoint;
  /** 沿所在泳道中心线的弧长坐标（px），由派生层计算。 */
  arcLengthPx?: number;
  /** 峰值灰度与饱和判定。 */
  peakIntensity: number;
  saturated: boolean;
  /** 与其它条带重叠（中心距 < 半峰宽和）。 */
  overlapsWith: string[];
  /** 拖尾：轮廓偏度/右延。 */
  tailed: boolean;
  /** ladder 道：对应标称值 id；sample 道为空。 */
  nominalId?: string;
  provenance: PixelProvenance;
  supersedesBandId?: string;
}

/* ============================ L2 派生计算 ============================ */

export type SegmentStatus =
  | 'valid'
  | 'non-monotonic' // 非单调标尺：插值段语义无效
  | 'missing-span' // 跨过缺带：仅可给区间
  | 'outside-support'; // 修订后局部失效

export interface CalibrationSegment {
  segmentId: string;
  laneId: string;
  /** 弧长区间（含），这就是局部标尺的“有效区域”。 */
  sMin: number;
  sMax: number;
  /** log10(bp) = intercept - slope*s （斜率正，分子越大走得越近、s 越小）。 */
  intercept: number;
  slope: number;
  status: SegmentStatus;
  /** 端点 ladder band id。 */
  lowBandId: string; // s 大（小分子量）
  highBandId: string; // s 小（大分子量）
  /** 有效区域附带的像素 y 范围，供叠加层显示。 */
  yMin: number;
  yMax: number;
}

export interface CalibrationFit {
  fitId: string;
  laneId: string;
  paramVersion: string;
  /** 每个 ladder 点相对全局线性拟合的残差（s 单位 px）。 */
  residuals: { bandId: string; s: number; fittedS: number; residualPx: number }[];
  segments: CalibrationSegment[];
  diagnostics: Diagnostic[];
  inputSummary: Record<string, unknown>;
  parentDepends: string[];
}

export type InferenceStatus = 'unique' | 'candidate-set' | 'interval' | 'coarse' | 'unresolved';

export interface MwCandidate {
  candidateId: string;
  bp: number;
  bpLabel: string;
  /** 该候选落在哪个插值段。 */
  segmentId: string;
  /** 支撑 ladder 点（可点击回到 ladder 点与插值段）。 */
  ladderBandIds: [string, string];
  /** 有效区域（弧长 + 像素 y）。 */
  validRegion: { sMin: number; sMax: number; yMin: number; yMax: number };
  /** 若为区间：上下界 bp。 */
  bpLower?: number;
  bpUpper?: number;
  reason:
    | 'unique'
    | 'saturated'
    | 'overlap'
    | 'tail'
    | 'missing-span'
    | 'non-monotonic'
    | 'outside-region';
}

export interface MwInference {
  inferenceId: string;
  bandId: string;
  laneId: string;
  status: InferenceStatus;
  /** 采纳/展示的代表值（区间中点或首选候选）；无法唯一决定时仍给出全部合法候选。 */
  candidates: MwCandidate[];
  diagnostics: Diagnostic[];
  paramVersion: string;
  inputSummary: Record<string, unknown>;
  parentDepends: string[];
}

/* ============================ 完整输入包 ============================ */

export interface GelInput {
  image: ImageMaterial;
  ladder: LadderMaterial;
  lanes: LaneAnnotation[];
  bands: BandAnnotation[];
}
