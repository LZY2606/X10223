/**
 * 领域类型：不可变材料（原图/方向/曝光/ladder 标称值/lane 边界/条带中心）
 * 全部携带像素级来源与坐标基准；派生量携带单位。
 */

/** 像素坐标基准：原始拍摄方向或旋转后的图像坐标系。 */
export type PixelBasis = 'image-raw' | 'image-rotated-90' | 'image-rotated-180' | 'image-rotated-270';

export interface PixelPoint {
  x: number; // 单位 px，原点左上
  y: number; // 单位 px，原点左上
  basis: PixelBasis;
}

/** 像素级来源：该坐标/数值来自哪一次事件。 */
export interface Provenance {
  sourceEventId: string;
  note?: string;
}

export interface GelImageObject {
  kind: 'gel-image';
  id: string;
  hash: string;
  width: number;  // px
  height: number; // px
  pixelsB64: string; // 8bit 灰度，行主序，原始表示不规范化
  orientationDeg: 0 | 90 | 180 | 270; // 拍摄方向
  exposureMs: number; // 曝光，单位 ms
  captureNote: string;
}

export interface LadderPoint {
  id: string;
  mwBp: number; // 标称分子量，单位 bp
  center: PixelPoint;
  source: Provenance;
}

export interface LadderObject {
  kind: 'ladder';
  id: string;
  hash: string;
  laneId: string;
  points: LadderPoint[]; // 标称值，导入时保留原始表示
}

export interface LaneObject {
  kind: 'lane';
  id: string;
  hash: string;
  index: number;
  role: 'ladder' | 'sample';
  centerline: PixelPoint[]; // 加样孔 -> 前沿 的泳道中心折线
  leftEdge: PixelPoint[];   // lane 边界，像素级来源
  rightEdge: PixelPoint[];
  source: Provenance;
}

export interface BandObject {
  kind: 'band';
  id: string;
  hash: string;
  laneId: string;
  center: PixelPoint;      // 条带中心，像素级来源
  contour: PixelPoint[];   // 条带轮廓
  heightPx: number;        // 沿泳道方向的半高全宽，px
  peakIntensity: number;   // 0-255
  saturated: boolean;
  overlapGroupId: string | null;
  origin: 'auto' | 'manual';
  source: Provenance;
}

export type GelObject = GelImageObject | LadderObject | LaneObject | BandObject;
export type GelObjectKind = GelObject['kind'];

/** 带位置的诊断：输入不完整/不可解时返回，绝不用空值伪装成功。 */
export interface Diag {
  id: string;
  severity: 'error' | 'warn';
  code: string;
  message: string;
  position?: {
    objectId?: string;
    point?: PixelPoint;
    segmentId?: string;
    laneId?: string;
  };
}

/** 分子量推断结果：值 / 区间 / 候选集合 / 失效，四态互斥。 */
export type MwEstimate =
  | {
      kind: 'value';
      mwBp: number;
      segmentId: string;
      validRegion: ValidRegion;
      residualLog10: number | null; // 相对全局拟合的残差
    }
  | { kind: 'interval'; loBp: number; hiBp: number; reason: 'saturated' | 'smear'; segmentId: string; validRegion: ValidRegion }
  | { kind: 'candidates'; reason: 'overlap'; options: { mwBp: number; segmentId: string }[] }
  | { kind: 'invalid'; reason: string; diagnostic: Diag };

/** 局部标尺的有效区域：泳道弧长 s 与像素 y 双重坐标基准。 */
export interface ValidRegion {
  sMinPx: number;
  sMaxPx: number;
  yMinPx: number;
  yMaxPx: number;
  basis: PixelBasis;
}

export interface ScaleSegment {
  id: string;
  index: number;
  sMinPx: number;
  sMaxPx: number;
  mwAtSMinBp: number;
  mwAtSMaxBp: number;
  pointIds: [string, string];
  valid: boolean;
  invalidReason?: string;
}

/** 计算记录：输入摘要 + 参数版本 + 父级依赖 + 有效时间。 */
export interface ComputationRecord {
  id: string;
  kind: 'mw-estimate';
  bandId: string;
  paramVersion: string;
  inputHash: string;
  parents: string[]; // 依赖对象 id（带内容 hash 可定位版本）
  result: MwEstimate;
  diagnostics: Diag[];
  createdSeq: number;
  supersededSeq: number | null;
}

/** 机器可读的判断事件负载约定。 */
export interface JudgmentPayload {
  ruleId: string;
  statement: string;
  inputs: string[];
  affected: string[];
  adopted: boolean;
  rationaleCode: string;
  detail?: Record<string, unknown>;
}

export interface GelEvent {
  id: string;
  seq: number;
  branch: string;
  type: string;
  parents: string[];
  payload: unknown;
  createdAt: string;
}

/** 三类不可混淆的失败结果。 */
export type FailureKind = 'budget-exhausted' | 'format-corrupt' | 'semantic-unsolvable';

export class TransferError extends Error {
  kind: FailureKind;
  position?: string;
  constructor(kind: FailureKind, message: string, position?: string) {
    super(message);
    this.kind = kind;
    this.position = position;
  }
}

export interface ProjectBundle {
  format: 'gel-scale-bundle/1';
  exportedAt: string;
  objects: (GelObject & { seq: number; supersededBy: string | null })[];
  events: GelEvent[];
  computations: ComputationRecord[];
  checksum: string;
}
