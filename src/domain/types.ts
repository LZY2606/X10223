// 核心领域类型。
// 约定：所有领域量都显式携带单位或坐标基准；像素坐标原点为“已存储栅格图像”的左上角，
// 单位 px。拍摄方向（orientation）是独立的不可变材料，旋转在派生层完成。

export type Unit =
  | "px" // 像素距离（已存储栅格坐标系）
  | "bp" // 碱基对，分子量（核酸）
  | "a.u." // 灰度强度
  | "deg" // 角度
  | "ms" // 曝光时长
  | "log10(bp)" // log10 分子量（拟合/残差空间）
  | "1"; // 无量纲

export interface UnitVal {
  value: number;
  unit: Unit;
}

/** 像素点，坐标基准：已存储栅格图像左上角，单位 px。 */
export interface PixelPoint {
  x: number;
  y: number;
}

export type MaterialKind =
  | "gelImage"
  | "orientation"
  | "exposure"
  | "ladderSpec"
  | "laneGeometry"
  | "bandCenters";

export interface BaseMaterial {
  kind: MaterialKind;
  id: string;
  /** 导入时保留的原始表示（字符串/数值原样），派生层才规范化；无法转换的值留在原位并附诊断。 */
  raw?: unknown;
  note?: string;
}

export interface GelImageMaterial extends BaseMaterial {
  kind: "gelImage";
  width: number; // px
  height: number; // px
  blobId: string; // PNG 字节的内容寻址 id
  sha256: string;
  bitDepth: 8;
  channels: 1; // 灰度
  coordinateSystem: "raster-top-left-px";
}

export interface OrientationMaterial extends BaseMaterial {
  kind: "orientation";
  imageId: string;
  rotationDeg: 0 | 90 | 180 | 270;
  source: "baseline" | "exif" | "human";
}

export interface ExposureMaterial extends BaseMaterial {
  kind: "exposure";
  imageId: string;
  durationMs: number;
  gain: number; // 无量纲
  /** 灰度饱和阈值（a.u.，0..255）：达到/超过即判为饱和。 */
  saturationLevel: number;
  channel: "gray";
}

export interface NominalBand {
  ref: string; // 标称点稳定身份，如 nom-1000
  mwBp: number; // 标称分子量 bp（原始数值，导入不做单位换算）
}

export interface LadderSpecMaterial extends BaseMaterial {
  kind: "ladderSpec";
  name: string;
  unit: "bp";
  /** 自上而下（点样孔方向）的标称条带，约定分子量递减。 */
  nominalBands: NominalBand[];
  orderAssumption: "descending-mw-top-to-bottom";
}

export interface Lane {
  laneId: string;
  role: "ladder" | "sample";
  /** 中心线控制点，自上而下的像素坐标（像素级来源，保留原始顺序）。 */
  centerline: PixelPoint[];
  /** 左右边界折线（像素级来源）。 */
  leftBoundary: PixelPoint[];
  rightBoundary: PixelPoint[];
  source: "auto-candidate" | "human-revision";
}

export interface LaneGeometryMaterial extends BaseMaterial {
  kind: "laneGeometry";
  imageId: string;
  lanes: Lane[];
}

export interface SampledBand {
  bandRef: string; // 直接来源内的稳定身份
  center: PixelPoint; // 条带中心，像素级来源
  peakIntensity: number; // a.u. 0..255
  widthPx: number;
  saturated: boolean;
  trailing: boolean; // 拖尾
  overlapGroup?: string; // 与其它条带重叠时的分组 id
  /** 沿中心线采样的轮廓（沿弧长 s px -> 灰度 a.u.），用于展示拟合残差。 */
  profile?: { sPx: number[]; intensity: number[] };
}

export interface BandCentersMaterial extends BaseMaterial {
  kind: "bandCenters";
  imageId: string;
  laneId: string;
  bands: SampledBand[];
  source: "auto-candidate" | "human-revision" | "synthetic-ground-truth";
}

export type Material =
  | GelImageMaterial
  | OrientationMaterial
  | ExposureMaterial
  | LadderSpecMaterial
  | LaneGeometryMaterial
  | BandCentersMaterial;

// ---------------------------------------------------------------------------
// 判定原因码（机器可读取）
// ---------------------------------------------------------------------------

export type ReasonCode =
  | "SMILE_SAME_HEIGHT_DIFFERENT_MW" // 微笑弯曲：同一图像高度不等于同一分子量
  | "LOCAL_RULER_VALID_REGION" // 局部标尺带有效区域
  | "SATURATED_BAND_INTERVAL_OR_CANDIDATE_ONLY" // 饱和只能给区间/候选
  | "TRAILING_BAND_INTERVAL_OR_CANDIDATE_ONLY"
  | "OVERLAP_MULTIPLE_CANDIDATES_RETAINED" // 重叠：保留全部合法候选
  | "MISSING_LADDER_BAND_LOCAL_SEGMENT_INVALID" // ladder 缺带：相邻局部段失效
  | "NON_MONOTONIC_RULER" // 非单调标尺
  | "OUT_OF_LADDER_RANGE" // 超出 ladder 有效范围
  | "LOCAL_DEPENDENCY_INVALIDATED" // 修订后局部失效
  | "ROTATION_NORMALIZED_IN_DERIVED_LAYER" // 方向仅在派生层归一
  | "FIT_RESIDUAL_ANOMALY";

export type DiagnosticKind =
  | "INCOMPLETE_INPUT"
  | "CORRUPT_FORMAT" // 格式损坏
  | "SEMANTIC_UNSOLVABLE" // 语义无解
  | "RESOURCE_EXHAUSTED" // 资源预算耗尽
  | "WARNING";

export interface Diagnostic {
  kind: DiagnosticKind;
  code: string;
  message: string;
  /** 带位置的诊断：JSON 路径，如 lanes[2].centerline[5].y */
  path?: string;
  budget?: { used: number; limit: number; unit: Unit };
}

export interface CalibrationParams {
  algorithm: "lane-local-arc-length-piecewise-linear-log";
  algorithmVersion: string;
  /** ladder 对齐：相邻标称间距允许的相对偏差。 */
  alignmentToleranceFraction: number;
  /** 残差阈值 log10(bp)。 */
  residualToleranceLog: number;
  /** 饱和平顶导致的中心不确定度（px）。 */
  saturatedCenterUncertaintyPx: number;
  /** 拖尾导致的中心不确定度（px）。 */
  trailingCenterUncertaintyPx: number;
  /** 小于该间距（px）视为两条带重叠。 */
  overlapSeparationPx: number;
  /** 条带允许投影到中心线的最大横向距离（px），超出即输入不完整/越界。 */
  maxLateralOffsetPx: number;
  /** 禁止外推：超出 ladder 最外点即标记超范围。 */
  extrapolate: false;
  /** 资源预算（防失控）：ladder 对齐候选数上限。 */
  maxAlignmentCandidates: number;
  maxBandsPerLane: number;
}

export const DEFAULT_PARAMS_V1: CalibrationParams = {
  algorithm: "lane-local-arc-length-piecewise-linear-log",
  algorithmVersion: "1.0.0",
  alignmentToleranceFraction: 0.25,
  residualToleranceLog: 0.12,
  saturatedCenterUncertaintyPx: 3,
  trailingCenterUncertaintyPx: 2.5,
  overlapSeparationPx: 6,
  maxLateralOffsetPx: 60,
  extrapolate: false,
  maxAlignmentCandidates: 64,
  maxBandsPerLane: 200
};
