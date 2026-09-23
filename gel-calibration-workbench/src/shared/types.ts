// 领域类型：所有领域量都携带单位或坐标基准。
// 坐标基准 "image-pixel"：原点为原始采集图左上角，+x 向右，+y 向下（电泳迁移方向）。
// 迁移坐标 "lane-arc-px"：沿泳道中心线从加样孔起算的弧长，单位 px。

export type PixelBasis = 'image-pixel';
export type MigrationBasis = 'lane-arc-px';

export interface PixelPoint {
  x: number; // px, image-pixel 基准
  y: number; // px, image-pixel 基准
  basis: PixelBasis;
}

export interface Quantity<U extends string = string> {
  value: number;
  unit: U;
}

export interface Diagnostic {
  code: string;
  severity: 'error' | 'warning';
  location: {
    entity: string; // 例如 'ladderMark' | 'bandCenter' | 'lane' | 'bundle'
    id: string;
    field?: string;
    point?: { x: number; y: number; basis: PixelBasis };
  };
  message: string;
}

export type FailureKind =
  | 'RESOURCE_BUDGET_EXHAUSTED'
  | 'FORMAT_CORRUPT'
  | 'SEMANTIC_UNSOLVABLE';

export type ResultStatus = 'ok' | 'diagnostic' | 'failed';

// ---------- 不可变材料层 ----------

export interface ImageAsset {
  id: string;
  kind: 'image';
  revision: number;
  sha256: string;
  widthPx: number;
  heightPx: number;
  orientationDeg: 0 | 90 | 180 | 270; // 拍摄方向（仅影响显示变换，不改变像素基准）
  exposure: { value: number; unit: 'ms'; raw: string }; // raw 保留导入时原始表示
  file: string; // 相对案例包路径
}

export interface LadderBandNominal {
  id: string;
  sizeBp: number | null; // 无法转换时保持 null 并附诊断
  raw: string; // 导入时原始表示
}

export interface LadderSpec {
  id: string;
  kind: 'ladderSpec';
  revision: number;
  name: string;
  unit: 'bp';
  bands: LadderBandNominal[]; // 标称值，顺序为从大到小
}

export interface LaneBoundary {
  id: string;
  kind: 'lane';
  revision: number;
  supersedes: string | null;
  imageId: string;
  laneIndex: number;
  role: 'ladder' | 'sample';
  label: string;
  centerline: PixelPoint[]; // 像素级来源：从加样孔到胶底的中心线折线
  source: 'auto' | 'manual';
}

export interface LadderMark {
  id: string;
  kind: 'ladderMark';
  revision: number;
  supersedes: string | null;
  laneId: string;
  ladderBandId: string; // 指向 LadderSpec.bands
  position: PixelPoint; // 像素级来源
  source: 'auto' | 'manual';
}

export type BandFlag = 'saturated' | 'overlap' | 'tailing';

export interface BandCenter {
  id: string;
  kind: 'bandCenter';
  revision: number;
  supersedes: string | null;
  laneId: string;
  position: PixelPoint; // 像素级来源
  intensity: number; // 0..1，相对饱和阈值
  halfWidthPx: number; // 条带半宽（用于区间估计）
  flags: BandFlag[];
  source: 'auto' | 'manual';
}

export type Material = ImageAsset | LadderSpec | LaneBoundary | LadderMark | BandCenter;
export type MaterialKind = Material['kind'];

// ---------- 参数版本 ----------

export interface ParamSet {
  version: string; // 例如 "v1"
  interpolation: 'piecewise-linear' | 'global-linear-fit';
  saturationThreshold: number; // 强度 >= 阈值判为饱和
  overlapResolutionPx: number; // 小于该间距判为重叠
  budgetOps: number; // 计算资源预算
}

// ---------- 计算层 ----------

export interface ComputationInputRef {
  entity: MaterialKind;
  id: string;
  revision: number;
}

export interface ValidRegion {
  mMin: number; // lane-arc-px
  mMax: number; // lane-arc-px
  basis: MigrationBasis;
}

export interface RulerPoint {
  markId: string;
  m: number; // lane-arc-px
  logBp: number;
  sizeBp: number;
}

export interface RulerResult {
  points: RulerPoint[]; // 按 m 升序，顺序稳定
  validRegion: ValidRegion;
  globalFit: { slope: number; intercept: number } | null;
  residuals: { markId: string; residualLogBp: number }[];
}

export interface LaneCurveResult {
  laneId: string;
  well: PixelPoint;
  samples: { s: number; x: number; y: number }[]; // s: lane-arc-px
  lengthPx: number;
}

export type MwValue =
  | {
      kind: 'point';
      bp: number;
      logBp: number;
      m: number;
      segment: { upperMarkId: string; lowerMarkId: string } | null; // 插值段（piecewise）
      validRegion: ValidRegion;
    }
  | {
      kind: 'interval';
      bpMin: number;
      bpMax: number;
      reasons: string[]; // 例如 SATURATED_BAND / OVERLAP_UNRESOLVED / OUT_OF_VALID_REGION
      mRange: { mMin: number; mMax: number };
      validRegion: ValidRegion;
    };

export interface MwResult {
  bandId: string;
  laneId: string;
  status: 'point' | 'interval' | 'candidate';
  value: MwValue;
  candidates?: { candidateId: string; note: string }[]; // 无法唯一决定时保留全部合法候选
}

export interface Computation {
  id: string; // 内容寻址：cmp-<kind>-<digest16>
  kind: 'LANE_CURVE_FIT' | 'RULER_FIT' | 'MW_INFER';
  paramVersion: string;
  inputDigest: string;
  inputs: ComputationInputRef[];
  parents: string[]; // 父级依赖 computation id
  status: ResultStatus;
  failureKind: FailureKind | null;
  result: unknown;
  diagnostics: Diagnostic[];
  budgetUsed: number;
  seq: number; // 产生时的事件序号
}

// ---------- 事件层（可修改决定，追加式） ----------

export type EventKind =
  | 'CASE_IMPORTED'
  | 'PARAM_REVISION'
  | 'SOURCE_AMENDMENT'
  | 'AUTO_CANDIDATES_COMPUTED'
  | 'MW_INFERRED'
  | 'DECISION_ACCEPT'
  | 'DECISION_REJECT'
  | 'DECISION_CONFLICT'
  | 'CONFLICT_RESOLVED'
  | 'VARIANT_RUN'
  | 'VARIANT_JUDGMENT'
  | 'EXPORTED'
  | 'IMPORTED';

export interface WbEvent {
  id: string;
  seq: number;
  kind: EventKind;
  payload: Record<string, unknown>;
  parents: string[]; // 事件/材料/计算 id
  machineReadable?: { code: string; detail: Record<string, unknown> }; // 机器可读取的判断依据
}

// ---------- 反例档案 ----------

export interface ArchiveEntry {
  id: string;
  title: string;
  changedSource: { entity: MaterialKind; id: string; what: string };
  expectation: string;
  status: 'pending' | 'adopted' | 'rejected' | 'mixed';
  adopted: unknown; // 被采纳的结果
  rejected: unknown; // 未采纳的结果
  judgmentEvents: { code: string; detail: Record<string, unknown> }[];
  affectedComputationIds: string[];
  unaffectedComputationIds: string[];
  diagnostics: Diagnostic[];
}
