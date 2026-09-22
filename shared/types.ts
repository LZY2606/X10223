// 领域类型：不可变材料（materials）与可修改决定（decisions）分层。
// 所有领域量都携带单位或坐标基准；像素级来源（provenance）随材料保存。

export type Unit = 'bp' | 'kDa';
export type OrientationDeg = 0 | 90 | 180 | 270;

export interface PixelPoint {
  x: number;
  y: number;
  basis: 'image-pixel'; // 坐标基准：原始图像像素坐标（未旋转、未裁剪）
}

export interface CaptureMeta {
  orientationDeg: OrientationDeg; // 拍摄方向
  flipHorizontal: boolean;
  exposureSeconds: number; // 曝光（秒）
  gain: number;
  basis: 'sensor-frame';
}

export interface PixelProvenance {
  imageId: string;
  pixel: PixelPoint; // 该测量值来自原图的哪个像素
  source: 'auto-detect' | 'manual-review';
}

export type MaterialKind = 'image' | 'ladder' | 'lane' | 'band-centers';

export interface ImagePayload {
  width: number;
  height: number;
  sha256: string;
  capture: CaptureMeta;
}

export interface LadderNominal {
  key: string;
  mw: number;
  unit: Unit;
}

export interface LadderPayload {
  name: string;
  laneId: string;
  unit: Unit;
  nominals: LadderNominal[]; // ladder 标称值（不可变材料）
}

export interface LanePayload {
  laneId: string;
  role: 'ladder' | 'sample';
  boundary: { left: PixelPoint[]; right: PixelPoint[] }; // lane 边界（像素折线）
  centerCurve: PixelPoint[]; // 等迁移前沿折线：微笑弯曲的像素级来源
}

export interface BandCenter {
  key: string;
  center: PixelPoint; // 条带中心（像素级来源）
  intensity: number; // 0..255
  saturated: boolean;
  trailing?: boolean;
  overlapsWith?: string[];
  provenance: PixelProvenance;
}

export interface BandCentersPayload {
  laneId: string;
  bands: BandCenter[];
}

export type MaterialPayload = ImagePayload | LadderPayload | LanePayload | BandCentersPayload;

export interface Material {
  id: string;
  kind: MaterialKind;
  payload: MaterialPayload;
  digest: string;
  hasBlob: boolean;
  seq: number;
}

// ---- 诊断：输入不完整/损坏/语义无解时返回带位置的结构化诊断，绝不用空值伪装成功 ----
export interface DiagnosticPosition {
  materialId?: string;
  laneId?: string;
  bandKey?: string;
  pixel?: PixelPoint;
  jsonPath?: string;
}

export interface Diagnostic {
  severity: 'error' | 'warning' | 'info';
  code: string;
  message: string;
  position?: DiagnosticPosition;
}

// 三种必须区分的失败结果 + 成功/部分成功状态
export type ComputeStatus =
  | 'ok'
  | 'candidate-only'
  | 'budget_exhausted' // 资源预算耗尽
  | 'format_corrupt' // 格式损坏
  | 'semantic_unsolvable' // 语义无解
  | 'incomplete_input'; // 输入不完整

export type EventKind =
  | 'import'
  | 'compute'
  | 'decision'
  | 'param-revision'
  | 'source-change'
  | 'judgment'
  | 'export'
  | 'import-bundle';

export interface GelEvent {
  id: string;
  seq: number;
  kind: EventKind;
  parents: string[]; // 父级依赖
  inputDigest: string; // 输入摘要
  paramVersion: string; // 参数版本
  branch: string;
  payload: unknown;
  createdAt: string;
}

export interface Decision {
  id: string;
  eventId: string;
  laneId: string;
  bandKey: string;
  kind: 'accept-candidate' | 'reject-candidate' | 'set-interval';
  optionMw?: number;
  branch: string;
  seq: number;
}

// ---- 分子量推断结果：值 / 区间 / 候选集 ----
export interface LadderSegmentRef {
  lo: { key: string; mw: number; y: number };
  hi: { key: string; mw: number; y: number };
}

export type MwResult =
  | {
      kind: 'value';
      mw: number;
      unit: Unit;
      segment: LadderSegmentRef; // 插值段（可回查 ladder 点）
      validRegion: [number, number]; // 局部标尺有效区域（迁移坐标 px）
      decidedBy: 'auto' | 'manual';
    }
  | {
      kind: 'interval';
      lo: number | null;
      hi: number | null;
      unit: Unit;
      reason: string; // 失效/只能给区间的原因
    }
  | {
      kind: 'candidates';
      options: { mw: number; unit: Unit; note: string }[]; // 无法唯一决定时保留全部合法候选
      reason: string;
    };

export interface BandInference {
  id: string; // 稳定身份：computationId:laneId:bandKey
  laneId: string;
  bandKey: string;
  pixel: PixelPoint; // 原图像素（来源）
  correctedY: number; // 迁移坐标（px，经泳道弯曲校正）
  saturated: boolean;
  autoResult: MwResult; // 自动候选（始终保留）
  result: MwResult; // 应用人工决定后的可见结论
  diagnostics: Diagnostic[];
}

export interface RulerView {
  points: { key: string; y: number; mw: number; logMw: number }[];
  fit: { a: number; b: number } | null;
  residuals: { key: string; residual: number }[]; // 拟合残差
  validRegion: [number, number] | null;
  runCount: number;
}

export interface PipelineResult {
  status: ComputeStatus;
  computationId: string;
  inputDigest: string;
  paramVersion: string;
  materialIds: string[]; // 父级依赖：本次计算直接使用的材料
  imageId: string | null;
  capture: CaptureMeta | null;
  unit: Unit;
  ruler: RulerView | null;
  bands: BandInference[];
  diagnostics: Diagnostic[];
}

export interface Snapshot {
  eventId: string;
  computationId: string | null;
  view: PipelineResult | null;
  decisions: Decision[];
}

export interface Budget {
  maxLadderPoints: number;
  maxBands: number;
}

export const DEFAULT_BUDGET: Budget = { maxLadderPoints: 64, maxBands: 512 };

export interface EngineParams {
  method: 'linear' | 'segment';
  saturationTolerancePx: number;
  paramVersion: string;
}

export const DEFAULT_PARAMS: EngineParams = {
  method: 'linear',
  saturationTolerancePx: 2,
  paramVersion: 'mwfit/1.0',
};
