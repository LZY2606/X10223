/**
 * 胶道标尺工作台 —— 共享领域类型
 *
 * 分层约定：
 *  - Material* 是不可变材料层：原图/方向/曝光/ladder 标称值/lane 边界/band 中心，
 *    全部保留像素级来源（sourceRef 指向原图 materialId + 像素坐标 + 来源方式）。
 *  - ParamSet 是参数版本（不可变）。
 *  - Ruler / QuantResult 是派生层：携带 inputDigest、paramVersion、parentIds。
 *  - Event 是只追加的决定/失效记录。所有计算可由 material + params + 事件重放。
 */

export type MaterialKind =
  | 'image'
  | 'orientation'
  | 'exposure'
  | 'ladder-nominal'
  | 'lane-boundaries'
  | 'band-centers';

/** 像素级来源：任何派生自原图的对象都必须能回溯到具体像素位置 */
export interface PixelSource {
  /** 来源原图 materialId */
  imageMaterialId: string;
  /** 像素坐标（以原图左上角为 (0,0)，x 向右、y 向下，单位 px） */
  x?: number;
  y?: number;
  /** 像素区域（轮廓/边界使用） */
  polygon?: Array<{ x: number; y: number }>;
  /** 像素值证据，如峰值强度、轮廓点 */
  pixelValue?: number;
  /** 产生方式：seed 种子 / detector@版本 / human 人工修订 */
  provenance: string;
}

export interface ImageMaterial {
  id: string;
  kind: 'image';
  /** 原始字节的 SHA-256（hex） */
  sha256: string;
  contentType: string;
  width: number;
  height: number;
  /** 坐标基准，所有像素坐标均以此声明为基准 */
  coordinateBasis: {
    origin: 'top-left';
    units: 'px';
    colorSpace: 'grayscale-8';
  };
  createdAt: string;
}

/** 拍摄方向：声明上样孔(well)在图像的哪一侧，原始表示保留，不做静默改写 */
export interface OrientationMaterial {
  id: string;
  kind: 'orientation';
  imageMaterialId: string;
  /** 上样孔所在方向（图像坐标，未旋转前） */
  wellSide: 'top' | 'bottom' | 'left' | 'right';
  /** 相对于相机竖直方向的旋转角，单位 degree，顺时针为正；无法确定时为 null 并必须带诊断 */
  rotationDeg: number | null;
  source: PixelSource;
  rawRepresentation: Record<string, unknown>;
}

export interface ExposureMaterial {
  id: string;
  kind: 'exposure';
  imageMaterialId: string;
  /** 曝光时间（单位 ms）；值缺失时必须为 null + 诊断，禁止用默认值伪装 */
  exposureMs: number | null;
  gain: number | null;
  bitDepth: number;
  /** 饱和阈值（像素值），>= 该值视为饱和 */
  saturationValue: number;
  source: PixelSource;
  rawRepresentation: Record<string, unknown>;
}

export interface LadderNominalBand {
  /** 稳定身份：标称槽位（如 ladder-10000），不随检测到的像素位置变化 */
  slotId: string;
  /** 标称分子量（单位 bp，base pairs） */
  sizeBp: number;
  source: PixelSource;
}

export interface LadderNominalMaterial {
  id: string;
  kind: 'ladder-nominal';
  laneId: string;
  bands: LadderNominalBand[];
  units: 'bp';
  rawRepresentation: Record<string, unknown>;
}

/** lane 边界：沿泳道走向的两条折线（像素坐标），可表达弯曲泳道 */
export interface LaneBoundary {
  laneId: string;
  role: 'ladder' | 'sample';
  /** 泳道名称，如 L(ladder) / S1 / S2 */
  label: string;
  /** 中心线折线（像素坐标），从上样孔端向迁移方向排列 */
  centerline: Array<{ x: number; y: number }>;
  leftEdge: Array<{ x: number; y: number }>;
  rightEdge: Array<{ x: number; y: number }>;
  source: PixelSource;
}

export interface LaneBoundariesMaterial {
  id: string;
  kind: 'lane-boundaries';
  imageMaterialId: string;
  lanes: LaneBoundary[];
}

export type BandFlag = 'normal' | 'saturated' | 'smeared' | 'overlap';

export interface BandCenter {
  bandId: string;
  laneId: string;
  /** 条带中心（像素坐标，原图基准） */
  x: number;
  y: number;
  /** 条带包围盒/轮廓（像素） */
  contour: Array<{ x: number; y: number }>;
  /** 峰值像素强度 */
  peakPixel: number;
  flags: BandFlag[];
  /** 重叠分组：同组条带无法唯一拆分 */
  overlapGroup?: string;
  source: PixelSource;
}

export interface BandCentersMaterial {
  id: string;
  kind: 'band-centers';
  imageMaterialId: string;
  bands: BandCenter[];
}

export type AnyMaterial =
  | ImageMaterial
  | OrientationMaterial
  | ExposureMaterial
  | LadderNominalMaterial
  | LaneBoundariesMaterial
  | BandCentersMaterial;

/** 参数版本：任何计算结果记录所用参数版本号与内容摘要 */
export interface ParamSet {
  paramVersion: string;
  /** 标尺方法：log10(size) 对迁移距离分段线性插值 */
  method: 'log-linear-piecewise';
  /** 是否启用逐泳道微笑弯曲校正（沿中心线弧长而非图像 y） */
  smileCorrection: boolean;
  /** 相邻峰最小可分辨间距（px），小于则判为重叠 */
  minBandSeparationPx: number;
  /** 允许外推？false 时超出 ladder 范围即判失效 */
  extrapolate: false;
  /** 计算预算（候选处理条数上限），耗尽时返回 budget_exhausted */
  budget: { maxBands: number };
  paramsDigest: string;
}

export type DiagnosticCode =
  | 'INPUT_INCOMPLETE'
  | 'LADDER_MISSING_BAND'
  | 'RULER_NON_MONOTONIC'
  | 'RULER_OUT_OF_RANGE'
  | 'SEGMENT_INVALID'
  | 'BAND_SATURATED'
  | 'BAND_OVERLAP'
  | 'BAND_SMEARED'
  | 'ROTATION_MISMATCH'
  | 'VALUE_UNCONVERTIBLE'
  | 'BUDGET_EXHAUSTED'
  | 'CORRUPT_FORMAT'
  | 'SEMANTIC_UNSOLVABLE';

/** 带位置的诊断：必须指出受影响对象/像素位置 */
export interface Diagnostic {
  code: DiagnosticCode;
  message: string;
  /** 像素坐标（原图基准） */
  position?: { x?: number; y?: number };
  /** 受影响对象的稳定身份 */
  laneId?: string;
  bandId?: string;
  ladderSlotId?: string;
  segmentIndex?: number;
  /** 无法转换时保留在原位置的原始表示 */
  rawValue?: unknown;
}

/** 局部标尺的一段：只在 [s0,s1] 弧长/像素区间内有效 */
export interface RulerSegment {
  index: number;
  /** 有效区域：该段只覆盖 ladder 两点之间的迁移坐标 */
  valid: boolean;
  invalidReason?: DiagnosticCode;
  /** 迁移坐标（启用 smile 校正时为沿中心线弧长 s，单位 px；否则为图像 y） */
  t0: number;
  t1: number;
  /** log10(bp) = slope * t + intercept */
  slope: number;
  intercept: number;
  /** 对应的 ladder 槽位（稳定身份）与像素来源 */
  slot0Id: string;
  slot1Id: string;
  bp0: number;
  bp1: number;
  point0: { x: number; y: number; t: number };
  point1: { x: number; y: number; t: number };
  /** 该段输出的分子量有效区间（bp，闭区间） */
  validBpRange: [number, number];
}

export interface LocalRuler {
  laneId: string;
  /** 坐标基准说明：迁移坐标 t 的定义与单位 */
  coordinateBasis: { axis: 'arc-length-s' | 'image-y'; units: 'px'; origin: string };
  segments: RulerSegment[];
  /** 整个标尺的有效迁移区间；段失效会造成区间内局部空洞 */
  tRange: [number, number] | null;
  diagnostics: Diagnostic[];
  /** 输入摘要与依赖版本 */
  inputDigest: string;
  paramVersion: string;
  parentIds: string[];
}

export type QuantKind = 'quantified' | 'candidate' | 'interval' | 'invalid';

export interface QuantResult {
  resultId: string;
  bandId: string;
  laneId: string;
  kind: QuantKind;
  /** 唯一分子量（bp），仅 kind=quantified */
  mwBp?: number;
  /** 区间（bp，闭区间 [下界, 上界]），饱和/重叠/拖尾使用 */
  intervalBp?: [number, number];
  /** 无法唯一决定时的全部合法候选（bp），按值稳定排序 */
  candidatesBp?: number[];
  reason?: DiagnosticCode;
  diagnostics: Diagnostic[];
  /** 反查证据：点中该分子量时回到的 ladder 点与插值段 */
  evidence: {
    bandCenter: { x: number; y: number };
    migrationT: number;
    segmentIndex?: number;
    segment?: RulerSegment;
    ladderPoints?: Array<{ slotId: string; x: number; y: number; t: number; sizeBp: number }>;
  };
  units: 'bp';
  inputDigest: string;
  paramVersion: string;
  parentIds: string[];
  /** 等价输入得到稳定排序的键 */
  orderingKey: string;
}

export type EventType =
  | 'project.imported'
  | 'materials.verified'
  | 'ruler.computed'
  | 'bands.quantified'
  | 'decision.accept'
  | 'decision.reject'
  | 'decision.adjust'
  | 'decision.conflict'
  | 'source.revised'
  | 'result.invalidated'
  | 'perturbation.applied';

export interface GelEvent {
  seq: number;
  eventId: string;
  branch: string;
  type: EventType;
  at: string;
  actor: 'auto' | 'reviewer' | 'replay';
  summary: string;
  payload: Record<string, unknown>;
  /** 父级依赖（material/params/前置事件的稳定身份） */
  parentIds: string[];
  inputDigest: string;
  paramVersion: string | null;
  /** 被采纳/未采纳结果的稳定身份 */
  resultIds: string[];
}
