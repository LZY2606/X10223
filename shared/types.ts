// 领域类型：不可变材料、计算记录、决定、诊断。
// 该文件只含类型与常量，浏览器与服务端共用。

export type Unit = 'bp';

/** 计算结果状态。资源预算耗尽、格式损坏、语义无解是三种不同结果。 */
export type ComputationStatus =
  | 'ok'
  | 'diagnostic'        // 输入不完整或带警告完成，诊断带位置
  | 'budget_exhausted'  // 资源预算耗尽
  | 'corrupt_format'    // 格式损坏（导入/解析层）
  | 'unsolvable'        // 语义无解（如非单调标尺段）
  | 'invalidated';      // 源数据改动后局部失效（如拍摄方向与几何基准不一致）

export type BandClassification = 'point' | 'interval' | 'candidate';

export type MaterialKind =
  | 'image'
  | 'exposure'
  | 'ladder_nominal'
  | 'lane_boundary'
  | 'ladder_band'
  | 'band_center'
  | 'params';

export interface Diagnostic {
  code: string;
  message: string;
  severity: 'info' | 'warning' | 'error';
  /** 诊断位置：指向具体 stream / 像素坐标 / ladder 序号，不得省略。 */
  position?: Record<string, unknown>;
}

export interface PixelBasis {
  imageStream: string;
  orientation: 0 | 90 | 180 | 270;
  width: number;   // 采集时图像宽（像素）
  height: number;  // 采集时图像高（像素）
}

export interface MaterialPayloads {
  image: { width: number; height: number; orientation: 0 | 90 | 180 | 270; hash: string; capturedAt: string; note?: string };
  exposure: { exposureMs: number; gain: number; saturationThreshold: number };
  ladder_nominal: { ladderId: string; unit: Unit; bands: { index: number; mw: number }[] };
  lane_boundary: { laneId: string; basis: PixelBasis; centerline: { x: number; dy: number }[]; edges: { left: number; right: number }; pixelSource: number[][] };
  ladder_band: { laneId: string; detectOrder: number; x: number; y: number; basis: PixelBasis; pixelSource: number[][] };
  band_center: { laneId: string; bandId: string; x: number; y: number; contour: { x0: number; y0: number; x1: number; y1: number }; peakIntensity: number; trailing?: boolean; clipped?: boolean; basis: PixelBasis; pixelSource: number[][] };
  params: { versionLabel: string; interpolation: 'log-linear-piecewise'; saturationThreshold: number; overlapMarginPx: number; smileModel: 'quadratic' };
}

export interface MaterialRow {
  id: string;
  project_id: string;
  branch_id: string;
  stream_id: string;
  kind: MaterialKind;
  version: number;
  hash: string;
  tombstone: number;
  payload: string;
  event_seq: number;
  created_at: string;
}

export interface ComputationRow {
  id: string;
  project_id: string;
  branch_id: string;
  subject: string;
  kind: 'pipeline' | 'ladder_fit' | 'band_mw' | 'saturation_check';
  status: ComputationStatus;
  input_digest: string;
  param_version: string;
  inputs: string;    // JSON: {stream, materialId}[] 已解析到版本
  parents: string;   // JSON: 父级计算 id[]
  result: string | null;
  diagnostics: string;
  valid_from_seq: number;
  created_at: string;
}

export interface DecisionRow {
  id: string;
  project_id: string;
  branch_id: string;
  subject: string;
  reviewer: string;
  action: 'accept' | 'reject' | 'adjust';
  payload: string;
  event_seq: number;
  created_at: string;
}

export interface EventRow {
  seq: number;
  id: string;
  project_id: string;
  branch_id: string;
  type: string;
  payload: string;
  parents: string;
  created_at: string;
}

export interface Interval { lower: number | null; upper: number | null }

export interface BandMwResult {
  classification: BandClassification;
  mw: number | null;
  interval: Interval | null;
  unit: Unit;
  d: number | null;                 // 校正后迁移距离（像素，规范坐标基）
  coordBasis: { orientation: number; canonical: true };
  validRegion: { dMin: number; dMax: number; unit: 'px' } | null;
  inValidRegion: boolean;
  reasons: string[];
  segment: { p0: string; p1: string; mw0: number; mw1: number; y0: number; y1: number } | null;
  candidates: { stream: string; interval: Interval | null }[] | null;
  provenance: { pixelCount: number; imageStream: string };
}

export interface LadderFitResult {
  points: { stream: string; nominalIndex: number; mw: number; unit: Unit; y: number; d: number; residual: number }[];
  missing: { nominalIndex: number; mw: number; expectedY: number }[];
  violations: { between: [string, string]; ys: [number, number]; mws: [number, number] }[];
  validRegion: { dMin: number; dMax: number; unit: 'px' };
  globalFit: { alpha: number; beta: number };
  reducedConfidenceSegments: [string, string][];
}
