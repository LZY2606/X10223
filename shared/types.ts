// 领域类型：所有领域量携带单位或坐标基准；原始表示与派生规范化分层。

export type UnitKind = "molecularMass" | "length" | "pixels" | "intensity" | "time" | "angle" | "unitless";

export interface Unit {
  kind: UnitKind;
  /** 原始单位记号，导入时保留，例如 "kDa"、"bp"、"px" */
  label: string;
}

export interface Quantity {
  /** 原始表示（导入逐字保留），无法规范化时仍留在此处 */
  raw: string;
  value?: number;
  unit: Unit;
  /** 规范化到内部基准单位的倍数（molecularMass->Da, length->px） */
  scaleToBase?: number;
  diagnostic?: string;
}

export interface Vec2 {
  x: number;
  y: number;
}

/** 坐标基准：值所指的帧（原始像素帧 / 解释帧）、原点与拍摄方向修订 */
export interface CoordinateFrame {
  frameId: string;
  origin: "top-left";
  rotationQuarterTurns: 0 | 1 | 2 | 3;
  mirrored: boolean;
  width: number;
  height: number;
  unit: Unit;
}

export interface PixelPoint {
  frame: CoordinateFrame;
  x: number;
  y: number;
}

export type MaterialKind =
  | "image"
  | "orientation"
  | "exposure"
  | "ladderSpec"
  | "ladderAssignment"
  | "lane"
  | "band";

export interface Provenance {
  /** 像素级来源：原始图像上的像素坐标与所在的源材料 */
  sourceImageId: string;
  originalPixel: Vec2;
  /** 解释帧中的对应点（旋转/镜像后） */
  interpretedPixel?: Vec2;
  capturedAt?: string;
  note?: string;
}

export interface RasterContent {
  width: number;
  height: number;
  /** 每行 row-major，0..255 灰度 */
  grayscale: Uint8Array;
  /** 是否存在饱和（255 平台）区域 */
  saturated: boolean;
}

export interface ImageMaterial {
  kind: "image";
  id: string;
  filename: string;
  mediaType: string;
  width: number;
  height: number;
  /** 原始图像字节（合成图则是生成参数派生），原始表示永不修改 */
  raster: RasterContent;
  capturedAt?: string;
  generator?: string;
}

export interface OrientationMaterial {
  kind: "orientation";
  id: string;
  imageId: string;
  rotationQuarterTurns: 0 | 1 | 2 | 3;
  mirrored: boolean;
  /** 审阅者声明的电泳迁移方向（解释帧中向下为正） */
  migrationDirection: "down";
}

export interface ExposureMaterial {
  kind: "exposure";
  id: string;
  imageId: string;
  exposureTime: Quantity;
  gain: Quantity;
  gamma: number;
  /** 传感器饱和灰度值 */
  sensorMax: number;
}

export interface LadderRung {
  /** 标称分子量的原始表示，逐字保留 */
  label: string;
  nominal: Quantity;
  /** 该档在泳道上的相对次序（0=点样孔端） */
  order: number;
}

export interface LadderSpecMaterial {
  kind: "ladderSpec";
  id: string;
  name: string;
  rungs: LadderRung[];
}

export interface LadderAssignmentMaterial {
  kind: "ladderAssignment";
  id: string;
  logicalId: string;
  laneId: string;
  ladderSpecId: string;
}

export type LaneRole = "sample" | "ladder";

export interface LaneMaterial {
  kind: "lane";
  id: string;
  /** 跨修订保持稳定的逻辑身份（修订产生新材料，逻辑身份不变） */
  logicalId: string;
  imageId: string;
  /** 稳定泳道序号（0=最左），等价输入顺序稳定 */
  index: number;
  role: LaneRole;
  /** 中心线控制点（解释帧像素），曲线用以应对“微笑”弯曲 */
  center: Vec2[];
  /** 半宽（像素），构成 lane 边界 */
  halfWidth: number;
  provenance: Provenance[];
  label: string;
}

export type BandStatus = "candidate" | "accepted" | "rejected" | "interval" | "conflict";
export type BandIssue = "saturated" | "tailing" | "overlap" | "missingLadderRung" | "outOfRulerRange";

export interface BandMaterial {
  kind: "band";
  id: string;
  logicalId: string;
  laneId: string;
  imageId: string;
  /** 条带中心（解释帧像素） */
  center: Vec2;
  /** 轮廓采样点（解释帧像素，阈值边界） */
  contour: Vec2[];
  /** 沿 lane 曲线的弧长 s（像素），由派生层计算并回填证据 */
  status: BandStatus;
  origin: "auto" | "manual";
  issues: BandIssue[];
  provenance: Provenance;
  /** 与相邻条带重叠的伙伴 band id（若有） */
  overlapGroupId?: string;
  /** 自动检测给出的峰值强度 */
  peakIntensity?: number;
}

export type Material =
  | ImageMaterial
  | OrientationMaterial
  | ExposureMaterial
  | LadderSpecMaterial
  | LadderAssignmentMaterial
  | LaneMaterial
  | BandMaterial;

export interface GelParams {
  version: string;
  bandDetection: {
    noisePercentile: number;
    minProminence: number;
    contourThresholdRatio: number;
    minBandSpacingPx: number;
  };
  ladder: {
    gapPenalty: number;
    monotonic: boolean;
  };
  saturation: {
    plateauRatio: number;
    tailSlope: number;
  };
  overlap: {
    mergeSdRatio: number;
  };
  ruler: {
    model: "piecewiseLinearLog";
    extrapolate: boolean;
    validMarginPx: number;
  };
  budget: {
    maxOps: number;
  };
}

// ---------- 事件溯源 ----------

export type EventType =
  | "case_created"
  | "material_added"
  | "material_revised"
  | "params_revised"
  | "band_decided";

export interface BaseEvent {
  id: string;
  caseId: string;
  seq: number;
  parentId: string | null;
  branch: string;
  at: string;
  actor: string;
  paramsVersion: string;
}

export interface CaseCreatedEvent extends BaseEvent {
  type: "case_created";
  payload: { title: string; scenario: string; note: string };
}

export interface MaterialAddedEvent extends BaseEvent {
  type: "material_added";
  payload: { material: Material };
}

export interface MaterialRevisedEvent extends BaseEvent {
  type: "material_revised";
  payload: {
    kind: MaterialKind;
    materialId: string;
    /** 只允许改动一个直接来源 */
    changedField: string;
    from: unknown;
    to: unknown;
    material: Material;
  };
}

export interface ParamsRevisedEvent extends BaseEvent {
  type: "params_revised";
  payload: { fromVersion: string; params: GelParams; reason: string };
}

export interface BandDecision {
  bandId: string;
  decision: "accept" | "reject" | "interval" | "resolve";
  chosenMw?: Quantity;
  interval?: { low: Quantity; high: Quantity };
  reason: string;
}

export interface BandDecidedEvent extends BaseEvent {
  type: "band_decided";
  payload: { decision: BandDecision };
}

export type Event =
  | CaseCreatedEvent
  | MaterialAddedEvent
  | MaterialRevisedEvent
  | ParamsRevisedEvent
  | BandDecidedEvent;

// ---------- 诊断与结果 ----------

export type ResultKind = "ok" | "incomplete" | "corrupt" | "semantic" | "budget";

export interface Diagnostic {
  code: string;
  message: string;
  severity: "error" | "warning";
  /** 带位置的诊断：指向材料/像素/事件 */
  location?: {
    kind: "material" | "pixel" | "event" | "rung" | "parameter";
    id?: string;
    pixel?: Vec2;
    frameId?: string;
    field?: string;
  };
}

export type Outcome<T> =
  | ({ kind: "ok" } & T)
  | { kind: "incomplete"; diagnostics: Diagnostic[]; partial?: T }
  | { kind: "corrupt"; diagnostics: Diagnostic[] }
  | { kind: "semantic"; diagnostics: Diagnostic[]; partial?: T }
  | { kind: "budget"; diagnostics: Diagnostic[]; opsUsed: number };
