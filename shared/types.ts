// 领域类型：不可变材料（像素级来源）与可修改决定分层。
// 坐标基准：image = 原图像素，原点左上，+x 向右，+y 向下，单位 px。
// 规范坐标：gel = { a: 横向(跨泳道), s: 迁移方向(从加样孔起) }，单位 px。
// 分子量单位：bp（碱基对）。时间基准：ISO 8601 UTC。

export type Orientation = 'wells-top' | 'wells-bottom' | 'wells-left' | 'wells-right';

export interface Pixel {
  x: number; // px, image 基准
  y: number; // px, image 基准
}

export interface Exposure {
  ms: number;   // 曝光时间，单位 ms
  gain: number; // 增益，无量纲
}

export interface ImageMaterial {
  kind: 'image';
  id: string;
  version: number;
  width: number;  // px
  height: number; // px
  orientation: Orientation; // 拍摄方向（加样孔方位）
  exposure: Exposure;
  sha256: string;  // 原图字节摘要
  blobId: string;
  provenance: { source: 'casepack' | 'upload' | 'derived'; note?: string };
}

// 泳道曲线（微笑弯曲）：s = q2*(a-aRef)^2 + q1*(a-aRef) + q0，单位均为 px
export interface LaneCurve {
  q2: number;
  q1: number;
  q0: number;
  aRef: number; // px
}

export interface LaneMaterial {
  kind: 'lane';
  id: string;
  version: number;
  laneIndex: number;
  role: 'ladder' | 'sample';
  label: string;
  curve: LaneCurve;        // 规范坐标基准
  across: { min: number; max: number }; // px，规范横向范围
  boundaryPx: Pixel[];     // 泳道边界，像素级来源（image 基准）
  source: 'auto' | 'manual';
}

export interface LadderBand {
  index: number;
  bp: number;        // 标称值，单位 bp
  centerPx: Pixel;   // 像素级来源
  source: 'auto' | 'manual';
}

export interface LadderMaterial {
  kind: 'ladder';
  id: string;
  version: number;
  laneId: string;
  nominalBp: number[]; // 标称值清单，单位 bp
  bands: LadderBand[];
}

export interface BandMaterial {
  kind: 'band';
  id: string;
  version: number;
  laneId: string;
  centerPx: Pixel;   // 条带中心，像素级来源
  intensity: number; // 0..1，相对满井容量；>threshold 视为饱和
  widthPx: number;   // 迁移方向半宽，px
  flags: { saturated?: boolean; tailing?: boolean; overlapGroup?: string; invalid?: boolean };
  source: 'auto' | 'manual';
}

export type Material = ImageMaterial | LaneMaterial | LadderMaterial | BandMaterial;

export interface Diagnostic {
  code: string;
  severity: 'error' | 'warning' | 'info';
  message: string;
  position?: { laneId?: string; bandId?: string; x?: number; y?: number; d?: number };
}

export interface ParamSet {
  version: string;
  interpolation: 'log-linear';
  saturationThreshold: number;   // 0..1
  overlapMinSeparationPx: number; // px，小于此间距视为重叠
  gapIntervalPx: number;          // px，ladder 段跨度超过此值只能给区间
  tailWidenPx: number;            // px，拖尾/饱和区间展宽半宽
  budget: { maxBandsPerLane: number }; // 资源预算
}

export const PARAMS_V1: ParamSet = {
  version: 'params/v1',
  interpolation: 'log-linear',
  saturationThreshold: 0.98,
  overlapMinSeparationPx: 6,
  gapIntervalPx: 100,
  tailWidenPx: 6,
  budget: { maxBandsPerLane: 64 },
};

// 三种必须区分的失败结果
export type ComputeFailure =
  | { kind: 'budget-exhausted'; laneId: string; bands: number; budget: number }
  | { kind: 'semantic-unsolvable'; reason: string; position?: Diagnostic['position'] }
  | { kind: 'format-corrupt'; path: string; message: string };

export type BandVerdict =
  | { kind: 'value'; bp: number }
  | { kind: 'interval'; lo: number; hi: number; pointEstimate: number; reason: 'saturated-band' | 'tailing' | 'ladder-gap' }
  | { kind: 'candidates'; options: number[]; reason: 'overlap-unresolved' }
  | { kind: 'invalid'; reason: 'out-of-validity-region' | 'non-monotonic-segment'; detail: string };

export interface RulerPoint {
  d: number;   // px，相对泳道曲线的迁移距离
  bp: number;  // bp
  logBp: number;
  ladderBandIndex: number;
  centerPx: Pixel;
}

export interface RulerSegment {
  id: string;
  lo: RulerPoint;
  hi: RulerPoint;
  monotonic: boolean;
  spanPx: number;
}

export interface Ruler {
  points: RulerPoint[];
  segments: RulerSegment[];
  validity: { dMin: number; dMax: number }; // px，局部标尺有效区域
  monotonic: boolean;
  residuals: { ladderBandIndex: number; residualLogBp: number }[]; // 留一法拟合残差
  diagnostics: Diagnostic[];
}

export interface BandResult {
  resultId: string;      // 稳定身份：内容寻址
  bandId: string;
  bandVersion: number;
  laneId: string;
  laneIndex: number;
  d: number;             // px，规范迁移距离
  centerPx: Pixel;       // 像素级来源回显
  validityRegion: { dMin: number; dMax: number }; // px
  segment?: {
    segmentId: string;
    loBp: number; hiBp: number;
    loD: number; hiD: number;
    loPx: Pixel; hiPx: Pixel;
  };
  verdict: BandVerdict;
  adopted: boolean;      // 自动候选是否被采纳（值=true；区间/候选/失效=false）
  inputDigest: string;   // 输入摘要
  paramVersion: string;  // 参数版本
  parents: string[];     // 父级依赖 materialId@version
}

export type EventKind =
  | 'import' | 'compute' | 'param-revision' | 'source-revision'
  | 'decision' | 'export' | 'import-file' | 'archive-run' | 'recovery' | 'reset';

export interface EventRecord {
  eventId: string;
  seq: number;
  kind: EventKind;
  parents: string[];   // 父事件 id
  payload: unknown;
  createdAt: string;   // ISO 8601 UTC
}

export interface DecisionRecord {
  eventId: string;
  seq: number;
  bandId: string;
  resultId: string;
  action: 'accept' | 'reject';
  reviewer: string;
  note?: string;
  createdAt: string;
}

export interface JudgmentEvent {
  code:
    | 'smile-local-ruler'
    | 'saturation-candidate-only'
    | 'tailing-interval-only'
    | 'overlap-candidate-only'
    | 'ladder-gap-interval'
    | 'rotation-invariant'
    | 'non-monotonic-segment-invalid'
    | 'local-invalidation-confined';
  statement: string;
  evidence: unknown;
}

export type ScenarioKind =
  | 'rotated-image'
  | 'curved-lanes'
  | 'ladder-missing-band'
  | 'saturated-region'
  | 'overlapping-bands'
  | 'non-monotonic-ruler'
  | 'post-revision-local-invalidation';

export interface ArchiveEntry {
  entryId: string;
  scenario: ScenarioKind;
  title: string;
  changedSources: { materialId: string; fromVersion: number; toVersion: number }[];
  adopted: BandResult[];   // 被采纳结果
  rejected: BandResult[];  // 未采纳结果（候选/区间/失效均保留）
  affectedResultIds: string[];
  preservedResultIds: string[];
  judgments: JudgmentEvent[];
  diagnostics: Diagnostic[];
  verdict: 'confined' | 'violated'; // 影响是否被限制在正确范围
}
