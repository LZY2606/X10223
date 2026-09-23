// 领域类型：不可变材料层 / 决定事件层 / 派生结果层
// 所有领域量携带单位或坐标基准；原始表示保留在 raw 字段，规范化只发生在派生层。

export type Unit = 'bp' | 'kDa' | 'mm' | 'px' | 'deg' | 'ms' | 'lux-ms' | 'fraction';

export interface PxPoint {
  x: number; // canonical 图像像素 x
  y: number; // canonical 图像像素 y
}

export interface PxPolyline {
  points: PxPoint[];
}

/** 像素级来源指针 */
export interface Origin {
  layer: 'material' | 'decision' | 'derived' | 'manifest';
  materialId?: string;
  eventId?: string;
  runId?: string;
  fieldPath?: string;
  px?: PxPoint;
  rawRepresentation?: string;
}

export interface Diagnostic {
  code: string;
  severity: 'info' | 'warning' | 'error';
  message: string;
  path?: string; // JSON 指针式位置，如 bands[3].center.x
  px?: PxPoint;
  byteOffset?: number;
}

export interface Quantity {
  raw: string; // 原始表示，导入时原样保留
  value: number | null; // 无法转换时为 null，但不伪装成功
  unit: string;
  convertible: boolean;
  diagnostic?: Diagnostic;
}

export interface GelImage {
  id: string;
  width: number;
  height: number;
  sha256: string;
  pixelFormat: 'gray8';
  dataRef: string; // resources/<sha>.png
  orientation: {
    raw: string;
    rotationDeg: number;
    flipped: boolean;
  };
  exposure: {
    raw: string;
    normalized: { iso: number | null; shutterMs: number | null; gain: number | null };
    convertible: boolean;
    diagnostic?: Diagnostic;
  };
  capturedAt: string | null;
}

export interface LadderBandNominal {
  id: string;
  nominal: Quantity; // bp
  present?: boolean; // 缺带场景使用
}

export interface LadderDef {
  id: string;
  name: string;
  laneId: string | null;
  bands: LadderBandNominal[];
}

export interface Lane {
  id: string;
  index: number;
  role: 'ladder' | 'sample';
  label: string;
  centerline: PxPolyline;
  left: PxPolyline;
  right: PxPolyline;
  source: 'auto' | 'manual';
}

export interface Band {
  id: string;
  laneId: string;
  center: PxPoint;
  widthPx: number;
  peakIntensity: number; // 0..1 归一化（派生层给出归一化依据）
  saturated: boolean;
  saturatedFraction: number;
  smeared: boolean;
  overlapWith: string[];
  source: 'auto' | 'manual';
  contour: PxPolyline; // 条带轮廓（像素）
}

export interface CalibrationParams {
  version: string;
  model: 'piecewise-log-linear';
  laneWidthPx: number;
  bandResolutionPx: number;
  saturationFractionThreshold: number;
  smearWidthPx: number;
  intensityFloor: number;
  maxBands: number; // 资源预算
}

export type MutationCode =
  | 'rotate-image'
  | 'warp-lane'
  | 'ladder-missing-band'
  | 'saturate-band'
  | 'overlap-bands'
  | 'nonmonotonic-scale'
  | 'local-revision';

export interface ScenarioDef {
  code: MutationCode;
  label: string;
  sourceField: string; // 被改动的唯一直接来源
  mutation: Record<string, unknown>;
  expectAffected: string[]; // 期望受影响对象 id（影响范围断言）
  expectCodes: string[];
}

export interface CaseManifest {
  schema: 'gel-workbench-case/v1';
  caseId: string;
  caseName: string;
  createdAt: string;
  coordinateBasis: string; // 'canonical-image-pixel, origin top-left, y down'
  image: Omit<GelImage, 'id' | 'sha256' | 'dataRef'> & { id?: string };
  ladder: LadderDef;
  lanes: Lane[];
  params: CalibrationParams;
  scenarios: ScenarioDef[];
  seededReview: {
    acceptBandIds: string[]; // 逻辑引用：生成后按 lane/t 序重映射
    rejectBandIds: string[];
    manualBands: Array<{ lane: number; tFraction: number; label: string }>;
    revisedParams: Partial<CalibrationParams> & { version: string };
    laneRevision?: { lane: number; dx: number; label: string };
    conflictLabel: string;
  };
}

// ---------- 决定事件层 ----------

export type EventPayload =
  | { type: 'import'; manifestSha256: string }
  | { type: 'detect'; bandIds: string[] }
  | { type: 'accept-bands'; bandIds: string[] }
  | { type: 'reject-bands'; bandIds: string[] }
  | { type: 'add-band'; band: Band }
  | { type: 'edit-band'; bandId: string; newCenter?: PxPoint; label?: string }
  | { type: 'edit-lane'; laneId: string; lane: Lane }
  | { type: 'replace-image'; image: GelImage; rotateBands: boolean }
  | { type: 'ladder-patch'; ladder: LadderDef }
  | { type: 'params-revision'; params: CalibrationParams }
  | { type: 'conflict-resolution'; targetEventId: string; choice: string; reason: string };

export interface GelEvent {
  id: string;
  caseId: string;
  parentId: string | null;
  branchId: string;
  seq: number;
  ts: string;
  actor: 'system' | 'auto' | 'reviewer';
  payload: EventPayload;
  runId: string; // 该事件后可见结论（内容寻址，历史不被覆盖）
}

export interface Finding {
  id: string;
  caseId: string;
  eventId: string;
  code: string;
  severity: 'info' | 'warning' | 'error';
  subjectType: 'band' | 'lane' | 'ladder' | 'segment' | 'image' | 'params';
  subjectId: string;
  message: string;
  evidence?: Record<string, unknown>;
}

// ---------- 派生层 ----------

export interface LadderAnchor {
  ladderBandId: string;
  bandId: string | null;
  t: number; // 沿 ladder 泳道中心线自井位的弧长 px
  logMw: number | null;
  nominalRaw: string;
  unit: string;
  present: boolean;
  residual: number | null;
}

export interface CalibSegment {
  id: string;
  loLadderBandId: string;
  hiLadderBandId: string;
  tRange: [number, number];
  valid: boolean;
  invalidReason?: string;
  slope: number | null;
  intercept: number | null;
}

export interface LaneCalibration {
  laneId: string;
  status: 'ok' | 'partial' | 'semantic-error';
  anchors: LadderAnchor[];
  segments: CalibSegment[];
  validTRange: [number, number] | null;
  nonmonotonic: boolean;
  missingLadderBandIds: string[];
  globalFit: { slope: number | null; intercept: number | null; r2: number | null };
}

export interface BandResult {
  id: string; // 内容寻址：等价输入稳定
  bandId: string;
  laneId: string;
  centerPx: PxPoint;
  tAlongLane: number;
  mode: 'unique' | 'candidate' | 'interval' | 'invalid';
  mwValue: number | null;
  mwUnit: string | null;
  interval: [number, number] | null;
  candidates: Array<{ ladderSegmentId: string; t: number; value: number }>;
  segmentId: string | null;
  ladderAnchorIds: string[];
  residual: number | null;
  valid: boolean;
  invalidReason: string | null;
  flags: string[];
  accepted: boolean | null; // 决定层状态
}

export interface CalibRun {
  id: string;
  caseId: string;
  eventId: string;
  inputsSha256: string;
  paramsVersion: string;
  dependsOn: string[];
  status: 'ok' | 'partial' | 'semantic-error' | 'budget-exhausted';
  calibrations: LaneCalibration[];
  results: BandResult[];
  diagnostics: Diagnostic[];
  budget: { maxBands: number; usedBands: number };
}

export interface ArchiveEntry {
  id: string;
  caseId: string;
  scenarioCode: MutationCode;
  label: string;
  sourceField: string;
  baselineRunId: string;
  candidateRunId: string; // 未采纳（自动候选/失效）
  acceptedRunId: string; // 采纳（修订后）
  affectedObjects: string[];
  findings: Finding[];
  expectationMatched: boolean;
}

export interface CaseBundle {
  schema: 'gel-workbench-export/v1';
  exportedAt: string;
  case: {
    manifest: CaseManifest;
    events: GelEvent[];
    runs: CalibRun[];
    findings: Finding[];
    archive: ArchiveEntry[];
    headEventId: string | null;
  };
  resources: Array<{ dataRef: string; sha256: string; bytesBase64: string }>;
  checksumSha256: string;
}
