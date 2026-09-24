/**
 * 领域核心类型 —— “胶道标尺”工作台
 *
 * 分层原则：
 *  - Material（不可变材料）：原图、拍摄方向、曝光、ladder 标称值、lane 边界、band 中心。
 *    每一项都携带像素级/物理级来源，永远 append-only；修订产生新版本而非覆盖。
 *  - Parameter（可修改决定）：算法/校准参数，版本化。
 *  - Event（决定与派生的统一账本）：所有计算结果、人工接受/否定/参数调整均为事件，
 *    含输入摘要、参数版本、父级依赖；回到旧事件可恢复当时版本与结论。
 *  - 所有领域量携带单位或坐标基准；原始表示在导入时保留，派生层才规范化。
 */

export type Unit = 'bp' | 'kDa' | 'px' | 'degree' | 'ms' | 'count' | 'intensity' | 'arcpx';

export type OutcomeCode =
  | 'ok'                       // 成功
  | 'diagnostic_incomplete'    // 输入不完整（带位置，禁止空值/默认值伪装成功）
  | 'diagnostic_unconvertible' // 语义无解：值无法转换或标定不能唯一决定
  | 'diagnostic_corrupt'       // 格式损坏
  | 'diagnostic_budget';       // 资源预算耗尽

export interface Diagnostic {
  code: OutcomeCode;
  /** 机器可判定的短码，如 MISSING_LADDER_NOMINAL */
  rule: string;
  message: string;
  /** 带位置的定位：材料类型、材料 id、字段、像素坐标等 */
  path: string;
  materialKind?: MaterialKind;
  materialId?: string;
  field?: string;
  at?: { x: number; y: number };
}

export type MaterialKind =
  | 'image'
  | 'orientation'
  | 'exposure'
  | 'ladder_nominal'
  | 'lane_boundary'
  | 'band_center';

/** 带单位、坐标基准与原始表示的领域量 */
export interface Quantity {
  /** 数值（规范化派生层结果）；无法规范化时为 null 且保留 raw */
  value: number | null;
  unit: Unit;
  /** 坐标/时间基准标识，例如 "image#img01/frame=rot0"、"epoch_ms" */
  basis: string;
  /** 导入时的原始表示（字符串），永不丢失 */
  raw?: string;
  /** 无法转换时留在原位的诊断 */
  diagnostic?: Diagnostic;
}

export interface PixelSource {
  /** 像素坐标（以对应图像材料的原始像素坐标系为准，未经旋转修正） */
  x: number;
  y: number;
  /** 来源图像材料 id */
  imageId: string;
  /** 该坐标所处的帧：'original' | 'rot90' | 'rot180' | 'rot270' */
  frame: 'original' | 'rot90' | 'rot180' | 'rot270';
  /** 定位精度/半径（像素），人工修订可给出 */
  uncertaintyPx?: number;
  /** 来源方式：自动候选 / 人工 / 导入 */
  provenance: 'auto' | 'manual' | 'imported';
}

export interface ImageMaterial {
  kind: 'image';
  id: string;
  version: number;
  /** blob 存储键（PNG 字节，不可变） */
  blobKey: string;
  sha256: string;
  width: number;
  height: number;
  channels: 1;
  bitDepth: 8;
  capturedAt: string; // ISO，时间基准保留
  rawFilename: string;
}

export interface OrientationMaterial {
  kind: 'orientation';
  id: string;
  version: number;
  imageId: string;
  /** 拍摄方向相对标准方向的旋转角（度，顺时针 0/90/180/270） */
  angle: Quantity; // unit degree
  note?: string;
}

export interface ExposureMaterial {
  kind: 'exposure';
  id: string;
  version: number;
  imageId: string;
  /** 曝光时长（毫秒）与传感器位深 */
  durationMs: Quantity;
  bitDepth: number;
  /** 饱和阈值（原始灰度），由曝光材料给出而非算法默认 */
  saturationLevel: number | null;
  note?: string;
}

export interface LadderBandNominal {
  /** 标称值（bp 或 kDa），raw 保留导入原始表示 */
  nominal: Quantity;
  /** 该标称值在 ladder 泳道上的像素级中心来源（可缺失 => 缺带诊断） */
  center?: PixelSource;
  /** 标注：该标称带缺失（图像上找不到对应 band） */
  missing?: boolean;
  /** 标注：该带落在饱和区 */
  saturated?: boolean;
}

export interface LadderNominalMaterial {
  kind: 'ladder_nominal';
  id: string;
  version: number;
  imageId: string;
  /** 关联的 ladder 泳道 id 列表（微笑校正需要多条 ladder 泳道） */
  laneIds: string[];
  unit: 'bp' | 'kDa';
  bands: LadderBandNominal[];
  /** 原始行文本，逐值可回溯 */
  rawTable: string;
}

/** 泳道中心线（可为曲线，像素级点列）+ 两条边界 */
export interface LaneBoundaryMaterial {
  kind: 'lane_boundary';
  id: string;
  version: number;
  imageId: string;
  role: 'ladder' | 'sample';
  label: string;
  /** 左边界像素折线 */
  leftEdge: PixelPoint[];
  /** 右边界像素折线 */
  rightEdge: PixelPoint[];
  /** 中心线像素折线（弯曲泳道即曲线） */
  centerline: PixelPoint[];
}

export interface PixelPoint {
  x: number;
  y: number;
  frame: PixelSource['frame'];
}

export type BandShape = 'compact' | 'saturated' | 'smear' | 'overlap';

export interface BandCenterMaterial {
  kind: 'band_center';
  id: string;
  version: number;
  imageId: string;
  laneId: string;
  /** 条带中心（像素级来源） */
  center: PixelSource;
  /** 条带外接/轮廓像素多边形（用于叠加显示与饱和、重叠判定） */
  contour: PixelPoint[];
  shape: BandShape;
  /** 峰值灰度（原始 0..255/位深） */
  peakIntensity: number;
  /** 重叠配对 band id（两条带重叠时） */
  overlapsWith?: string;
  /** 拖尾半长（像素），无拖尾为 0 */
  smearTailPx: number;
}

export type Material =
  | ImageMaterial
  | OrientationMaterial
  | ExposureMaterial
  | LadderNominalMaterial
  | LaneBoundaryMaterial
  | BandCenterMaterial;

export interface MaterialRef {
  kind: MaterialKind;
  id: string;
  version: number;
}

/** 可修改决定：参数集（版本化） */
export interface CalibrationParams {
  paramVersion: string;
  /** 校准模型：'loglinear' 分子量对迁移率分段对数线性 */
  model: 'loglinear';
  /** 饱和强度阈值占曝光饱和级的比例；若曝光材料无饱和级则诊断而非默认 */
  saturationRatio: number | null;
  /** 重叠判定：两轮廓中心距小于此像素值且双峰时为重叠 */
  overlapDistancePx: number;
  /** 允许外推的最大迁移距离（像素）；超出 => validRegion 外失效 */
  extrapolationLimitPx: number;
  /** 非单调标尺相邻点是否拒绝（true => 该段失效而非强行拟合） */
  rejectNonMonotonicSegments: boolean;
}

export type EventType =
  | 'project_created'
  | 'material_recorded'
  | 'material_amended'
  | 'params_revised'
  | 'auto_candidates'
  | 'computed'
  | 'decision_accepted'
  | 'decision_rejected'
  | 'decision_conflict'
  | 'branch_tagged'
  | 'checkout';

export interface InputDigest {
  /** 参与计算的材料引用与内容哈希摘要 */
  refs: MaterialRef[];
  materialHashes: Record<string, string>;
  paramsVersion: string;
  /** 规范化输入的稳定哈希（等价输入 => 稳定顺序/身份） */
  digest: string;
}

export interface InterpSegment {
  id: string; // 稳定身份 seg-<hash>
  laneId: string;
  /** 段两端 ladder 点的 band/标称 id */
  fromNominalIndex: number;
  toNominalIndex: number;
  /** 迁移轴（弧长，像素）区间 */
  sFrom: number;
  sTo: number;
  /** 标称值区间（单位同 ladder） */
  mwFrom: number;
  mwTo: number;
  /** 段是否有效（缺带/非单调 => false，附诊断） */
  valid: boolean;
  invalidReason?: string;
  /** 残差（标称点相对拟合的对数残差，单位为 log10(mw)） */
  residualLog: number;
}

export interface MwCandidate {
  /** 候选稳定身份 */
  id: string;
  kind: 'unique' | 'interval' | 'multi';
  mw: number | null;
  mwLow?: number;
  mwHigh?: number;
  /** multi：无法唯一决定时保留的全部合法候选 */
  alternatives?: number[];
  unit: 'bp' | 'kDa';
  status: 'adopted' | 'rejected' | 'candidate';
  segmentId?: string;
  ladderPointIds: string[];
  /** 有效区域：该标尺可合法使用的弧长区间与 lane 多边形 */
  validRegion: { sMin: number; sMax: number; lanePolygon: PixelPoint[] };
  /** 失效原因（落在有效区外/非单调段/缺带段/饱和/重叠/拖尾） */
  invalidReason?: string;
  diagnostics: Diagnostic[];
}

export interface ComputedResult {
  resultId: string;
  bandId: string;
  laneId: string;
  /** 该 band 在自身泳道中心线上的迁移弧长（arcpx） */
  migration: Quantity;
  /** 同一水平（原始 y）在 ladder 标尺上会得到的错误值，用于证明微笑问题；可为 null */
  naveVerticalMw: number | null;
  candidates: MwCandidate[];
  /** 局部标尺分段（带有效区域） */
  segments: InterpSegment[];
  diagnostics: Diagnostic[];
}

export interface Event {
  id: string;
  seq: number;
  type: EventType;
  branch: string;
  parentIds: string[];
  timestamp: string;
  author: 'auto' | 'reviewer' | 'importer';
  /** 事件负载（材料、参数、计算、决定等） */
  payload: unknown;
  /** 计算类事件：输入摘要 */
  input?: InputDigest;
  /** 事件级诊断（输入不完整/语义无解/损坏/预算） */
  diagnostics?: Diagnostic[];
  /** 受该事件影响的对象 id 列表（局部失效传播范围） */
  affects?: string[];
}

export interface Project {
  id: string;
  name: string;
  description: string;
  createdAt: string;
  headByBranch: Record<string, string>; // branch -> eventId
}

export interface ExportBundle {
  format: 'gel-ladder-bench-bundle';
  formatVersion: 1;
  exportedAt: string;
  project: Project;
  events: Event[];
  materials: Material[];
  blobs: { key: string; sha256: string; mediaType: string; base64: string }[];
  caseName?: string;
}
