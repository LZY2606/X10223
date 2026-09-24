// 胶道标尺工作台 —— 共享领域类型
// 分层原则：不可变材料(Material) / 事件(Event) / 派生结果(Result)

export type Unit = 'bp' | 'px' | 'ms' | 'deg' | 'count' | 'ratio';

export interface Diagnostic {
  code:
    | 'missing-orientation'
    | 'missing-exposure'
    | 'missing-ladder-nominal'
    | 'missing-ladder-band'
    | 'non-monotonic-ruler'
    | 'outside-valid-region'
    | 'saturated-band'
    | 'tailing-band'
    | 'overlapping-bands'
    | 'incomplete-input'
    | 'digest-mismatch';
  location: {
    materialId?: string;
    laneId?: string;
    bandIndex?: number;
    pixel?: { x: number; y: number };
  };
  message: string;
}

// —— 坐标基准：所有像素值必须说明在哪张图、经什么变换下成立 ——
export interface Transform {
  rotationDeg: 0 | 90 | 180 | 270;
  mirrored: boolean;
}
export const IDENTITY_TRANSFORM: Transform = { rotationDeg: 0, mirrored: false };

export interface CoordinateBasis {
  imageId: string;
  transform: Transform;
  origin: 'top-left';
  axes: 'x-right/y-down';
  unit: 'px';
}

// —— 不可变材料 ——
export interface GelImageMaterial {
  kind: 'image';
  id: string;
  width: number; // px
  height: number; // px
  orientation: Transform | null; // 拍摄方向；null = 未声明（诊断，不伪造默认值）
  exposure: { exposureMs: number | null; gain: number | null; detector: string } | null;
  capturedAt: string; // 时间基准 ISO8601
  sha256: string;
}

export interface LadderNominalMaterial {
  kind: 'ladder-nominal';
  id: string;
  ladderId: string;
  valuesBp: number[]; // 标称分子量，单位 bp，原始表示
  source: string; // 数据手册等来源
}

export interface PixelPoint {
  x: number;
  y: number;
  pixelSource: { x: number; y: number; confidence: number }; // 像素级来源
}

export interface LaneSpec {
  laneId: string;
  role: 'ladder' | 'sample';
  name: string;
  centerline: PixelPoint[]; // 弯曲泳道中心线，像素坐标
}

export interface LaneBoundaryMaterial {
  kind: 'lane-boundaries';
  id: string;
  imageId: string;
  lanes: LaneSpec[];
}

export interface BandSpec {
  bandIndex: number;
  x: number;
  y: number;
  pixelSource: { x: number; y: number };
  intensity: number; // 0..255
  saturated: boolean;
  tailing: boolean;
  halfWidthPx: number; // 用于饱和/重叠时形成区间
}

export interface BandCenterMaterial {
  kind: 'band-centers';
  id: string;
  imageId: string;
  laneId: string;
  bands: BandSpec[];
}

export type Material =
  | GelImageMaterial
  | LadderNominalMaterial
  | LaneBoundaryMaterial
  | BandCenterMaterial;

// —— 事件：决定与计算都落到事件流，支持分支与时间旅行 ——
export type EventType =
  | 'case-imported'
  | 'auto-candidates'
  | 'human-decision'
  | 'params-revised'
  | 'source-revised'
  | 'conflict-recorded'
  | 'conflict-resolved'
  | 'archive-mutation'
  | 'exported'
  | 're-imported';

export interface GelParams {
  paramsVersion: string;
  saturationThreshold: number; // 0..255
  minBandSeparationPx: number; // px
  smileModel: 'per-lane-quadratic';
  interpolation: 'log-linear';
}

export const PARAMS_V1: GelParams = {
  paramsVersion: 'params-v1',
  saturationThreshold: 250,
  minBandSeparationPx: 10,
  smileModel: 'per-lane-quadratic',
  interpolation: 'log-linear'
};

export interface Event {
  id: string;
  seq: number;
  type: EventType;
  branch: string;
  parents: string[]; // 父级依赖（material id / event id / paramsVersion）
  paramsVersion: string;
  inputDigest: string; // 输入摘要：canonical(父依赖 + payload)
  createdAt: string;
  payload: Record<string, unknown>;
}

export type ResultStatus = 'ok' | 'candidate' | 'interval' | 'invalid';

export interface LadderPoint {
  bandIndex: number;
  yPx: number;
  sizeBp: number;
  missing: boolean;
}

export interface InterpSegment {
  index: number;
  y0: number;
  y1: number;
  logSize0: number;
  logSize1: number;
  degraded: boolean; // 相邻缺带/非单调 -> 局部失效标记
  reason?: string;
}

export interface BandResult {
  resultId: string;
  branch: string;
  laneId: string;
  bandIndex: number;
  status: ResultStatus;
  sizeBp: number | null; // 无法唯一决定时为 null + diagnostics
  intervalBp: { lo: number; hi: number } | null;
  candidatesBp: number[]; // 无法唯一决定时保留全部合法候选
  unit: 'bp';
  basis: CoordinateBasis;
  validRegion: { yMinPx: number; yMaxPx: number } | null;
  failureReason: string | null;
  diagnostics: Diagnostic[];
  ladderPoints: LadderPoint[];
  segmentIndex: number | null;
  segments: InterpSegment[];
  residuals: { bandIndex: number; yPx: number; residualLog10: number }[];
  parents: string[];
  eventId: string;
  adopted: boolean | null; // null=自动候选未审阅；true/false=人工采纳/否定
}

// —— 导出档案 ——
export interface ExportBundle {
  formatVersion: 1;
  caseId: string;
  exportedAt: string;
  materials: Material[];
  events: Event[];
  results: BandResult[];
  eventSeq: number;
}

// —— 三种不同的失败结果 ——
export type ImportFailure =
  | { kind: 'format-corrupt'; reason: string; location?: string }
  | { kind: 'semantic-unsolvable'; reason: string; diagnostics: Diagnostic[] }
  | { kind: 'budget-exhausted'; reason: string; used: number; limit: number };
