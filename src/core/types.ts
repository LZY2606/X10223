/**
 * 胶道标尺 —— 领域类型。
 *
 * 分层原则：
 *  - 材料层 materials 是不可变（immutable）的直接来源，任何修改都产生一个新版本，
 *    旧版本连同其 sha256 指纹永远保留。
 *  - 决定层 decisions 是可修改的人/自动化决定（接受、拒绝、参数调整、人工修订）。
 *  - 派生层 results 只依赖“输入摘要 + 参数版本 + 父级依赖”，可随时重放重建。
 *
 * 所有领域量都带单位或坐标基准（unit/basis），导入时保留原始表示（raw 字段）。
 */

export type MaterialType =
  | 'image'
  | 'orientation'
  | 'exposure'
  | 'ladderSpec'
  | 'laneGeometry'
  | 'bandCenters';

export type AxisName = 'u' | 'v';

/** 一个带完整物理单位与坐标基准的量。raw 保留导入时的原始表示。 */
export interface Qty {
  value: number;
  unit: string;          // 'bp' | 'kDa' | 'px' | 'mm' | 'deg' | 'ms' | 'count' | ''(无量纲)
  basis?: string;        // 坐标/时间基准说明，如 'image-frame:top-left' | 'frame-v:top=0'
  raw?: string | number; // 导入时的原始表示，规范化只在派生层做
  unconvertible?: boolean; // 无法转换：留在原位置并附诊断，绝不为画图丢弃
  reason?: string;
}

/** 稳定身份。材料 id 由“来源类型 + 标签”决定，跨导出/导入保持；版本由内容哈希决定。 */
export interface StableId {
  id: string;
  rev: string; // 内容修订号（从 1 开始的零填充字符串），便于排序
}

export interface ImageMaterial {
  kind: 'image';
  label: string;
  widthPx: number;
  heightPx: number;
  channels: 1 | 3 | 4;
  bitDepth: 8 | 16;
  blobSha256: string;
  /** 像素行主序的下采样强度缓存（0..1），用于曲线/分析；原始像素永不被修改。 */
  raster?: Float32Array;
}

/** 拍摄方向（旋转/翻转）。直接来源，应用于原始图像的显示与坐标换算。 */
export interface OrientationMaterial {
  kind: 'orientation';
  rotationDeg: 0 | 90 | 180 | 270;
  flipH: boolean;
  flipV: boolean;
  /** 坐标基准：所有 lane/band 像素坐标相对于“未旋转原图”还是“显示帧”。 */
  coordinateConvention: 'original-frame' | 'display-frame';
}

/** 曝光/成像参数。saturationThreshold 用于判定饱和。 */
export interface ExposureMaterial {
  kind: 'exposure';
  exposureMs?: Qty;
  gain?: Qty;
  gamma: number;
  /** 饱和阈值（相对强度 0..1 或按位深的 DN，raw 保留原值）。 */
  saturationThreshold: Qty;
  background: Qty;
}

export interface LadderBandNominal {
  key: string;           // 稳定键，如 'b250'
  rowPx: Qty;            // 在 ladder 泳道上的名义行坐标（像素级来源）
  molecularWeight: Qty;  // 标称分子量
  missing?: boolean;     // 缺带声明（源数据可声明该标称带缺失）
  note?: string;
}

export interface LadderSpecMaterial {
  kind: 'ladderSpec';
  laneId: string;        // 该标尺绑定的 ladder 泳道
  migrationAxis: AxisName;
  interpolation: 'linear-logmw' | 'pchip-logmw';
  bands: LadderBandNominal[];
}

/** 一条泳道的中心线（可弯曲）与边界。全部为像素坐标。 */
export interface LaneCurve {
  laneId: string;
  label: string;
  isLadder: boolean;
  /** 中心线折线：沿迁移方向 v 的各采样行上，中心线 u 坐标（可能弯曲）。 */
  center: PointPx[];
  halfWidthPx: number;
}

export interface PointPx {
  v: number; // 迁移方向坐标（原图像素，含 basis）
  u: number; // 横向坐标
}

export interface LaneGeometryMaterial {
  kind: 'laneGeometry';
  migrationAxis: AxisName;
  coordinateBasis: string; // 如 'original-frame:top-left'
  lanes: LaneCurve[];
}

export interface BandCenter {
  bandId: string;
  laneId: string;
  /** 沿该 lane 中心线的迁移位置（像素级）。 */
  v: number;
  /** 横向像素（冗余记录，用于与 lane 曲线交叉核对）。 */
  u: number;
  /** 源特征：自动候选或人工标记。 */
  origin: 'auto-candidate' | 'manual';
  confidence?: number;
  note?: string;
}

export interface BandCentersMaterial {
  kind: 'bandCenters';
  bands: BandCenter[];
}

export type MaterialBody =
  | ImageMaterial
  | OrientationMaterial
  | ExposureMaterial
  | LadderSpecMaterial
  | LaneGeometryMaterial
  | BandCentersMaterial;

export interface MaterialEnvelope {
  type: MaterialType;
  stableId: string;
  rev: string;
  sha256: string;
  createdAt: string;
  supersedesRev: string | null;
  body: MaterialBody;
}

// ---------------------------------------------------------------------------
// 决定层（可修改；每次修改产生新事件，旧决定永不被覆盖）
// ---------------------------------------------------------------------------

export type DecisionKind =
  | 'accept'
  | 'reject'
  | 'param-change'
  | 'manual-mw'
  | 'band-edit'
  | 'valid-window'
  | 'note';

export interface Decision {
  decisionId: string;
  kind: DecisionKind;
  /** 作用对象：band / lane / segment / ruler 的稳定 id。 */
  target: string;
  branchId: string;
  parentEventId: string | null;
  seq: number;
  createdAt: string;
  author: string;
  /** 参数版本：决定本身的规则版本，例如接受时使用的判定规则集。 */
  ruleVersion: string;
  payload: Record<string, unknown>;
  /** 与同一目标上先前决定冲突时显式标注。 */
  conflictsWith?: string[];
  note?: string;
}

// ---------------------------------------------------------------------------
// 事件（机器可读、可重放证据）
// ---------------------------------------------------------------------------

export type EventType =
  | 'project.created'
  | 'material.imported'
  | 'material.revised'
  | 'compute.requested'
  | 'compute.completed'
  | 'decision.recorded'
  | 'diagnostic.emitted'
  | 'branch.created'
  | 'budget.exhausted'
  | 'import.failed'
  | 'archive.imported'
  | 'archive.exported';

export interface Event {
  eventId: string;
  seq: number;
  projectId: string;
  branchId: string;
  type: EventType;
  at: string;
  /** 触发该事件的父事件（决定链/依赖链）。 */
  parentEventId: string | null;
  /** 输入摘要（材料 sha256、参数版本、依赖结果 id）。 */
  inputs: Record<string, unknown>;
  /** 结构化负载：判定依据/受影响对象/状态。 */
  payload: Record<string, unknown>;
  /** 被采纳与否都保留。 */
  adopted: boolean;
}

// ---------------------------------------------------------------------------
// 诊断（带位置）；三种失败必须可区分
// ---------------------------------------------------------------------------

export type DiagnosticCode =
  | 'ROTATION_APPLIED'
  | 'LANE_CURVED_SMILE'
  | 'LADDER_BAND_MISSING'
  | 'SATURATED_REGION'
  | 'BAND_TAILING'
  | 'BANDS_OVERLAP'
  | 'RULER_NONMONOTONIC'
  | 'RULER_WINDOW_INVALID'
  | 'MW_CANDIDATE_SET'
  | 'MW_INTERVAL_ONLY'
  | 'UNCONVERTIBLE_VALUE'
  | 'MISSING_INPUT';

export interface Diagnostic {
  code: DiagnosticCode;
  severity: 'info' | 'warning' | 'error';
  message: string;
  /** 带位置：像素坐标 / lane / band / segment。 */
  location?: {
    laneId?: string;
    bandId?: string;
    segmentId?: string;
    atPx?: PointPx;
    rangePx?: [number, number];
  };
  affected: string[];
}

/** 三种互不相混的终态结果。 */
export type Outcome<T> =
  | { ok: true; value: T; diagnostics: Diagnostic[] }
  | { ok: false; failure: 'budget-exhausted'; budget: string; message: string; diagnostics: Diagnostic[] }
  | { ok: false; failure: 'corrupt-format'; message: string; diagnostics: Diagnostic[] }
  | { ok: false; failure: 'semantic-unsatisfiable'; message: string; diagnostics: Diagnostic[] };
