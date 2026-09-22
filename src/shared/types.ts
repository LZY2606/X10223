// 胶道标尺工作台：核心领域类型
// 分层：不可变材料(materials) -> 仅追加事件(events/decisions) -> 内容寻址计算结果(computations)

export const PARAMS_VERSION_BASELINE = 'params-001-v1';
export const PARAMS_VERSION_REVISED = 'params-002-saturation-200';

export interface ParamSet {
  version: string;
  parentVersion: string | null;
  note: string;
  saturationLevel: number;   // >= 该灰度(0..255)记为饱和像素
  bandPeakProminence: number;
  bandHalfWidthMax: number;  // px
  overlapSeparationMin: number; // px，小于该间距的峰视为重叠
  maxSamplesPerLane: number;  // 资源预算：每条泳道最大采样数
  maxPixels: number;          // 资源预算：参与计算的像素上限
}

export const BASELINE_PARAMS: ParamSet = {
  version: PARAMS_VERSION_BASELINE,
  parentVersion: null,
  note: '基线参数：饱和阈值254，峰显著度8',
  saturationLevel: 254,
  bandPeakProminence: 8,
  bandHalfWidthMax: 14,
  overlapSeparationMin: 9,
  maxSamplesPerLane: 4000,
  maxPixels: 4_000_000,
};

export const REVISED_PARAMS: ParamSet = {
  version: PARAMS_VERSION_REVISED,
  parentVersion: PARAMS_VERSION_BASELINE,
  note: '修订：饱和阈值降到200（局部失效检验）',
  saturationLevel: 200,
  bandPeakProminence: 8,
  bandHalfWidthMax: 14,
  overlapSeparationMin: 9,
  maxSamplesPerLane: 4000,
  maxPixels: 4_000_000,
};

// ---------- 坐标与单位 ----------
export interface PixelPoint { x: number; y: number }

export interface PixelSpan { // 区间（用于饱和/重叠导致的不唯一中心）
  from: number; to: number; axis: 's' | 'x' | 'y';
}

export interface SourceAnchor {
  // 像素级来源：指向不可变材料中的具体字段，及导入文件中的字节/行位置
  materialId: string;
  fieldPath: string;
  byteOffset?: number;
  line?: number;
  importedFrom: string; // 导入包内文件名
  recordedAt: string;   // ISO，来源声明时间（不参与身份哈希）
  method: 'manual' | 'auto' | 'declared';
}

// ---------- 不可变材料 ----------
export type MaterialType =
  | 'source-image' | 'capture-orientation' | 'exposure'
  | 'ladder-spec' | 'lane-geometry' | 'band-annotation';

export interface ImageMaterial {
  type: 'source-image';
  id: string;
  blobSha256: string;
  fileName: string;
  width: number; height: number;
  grayscaleMax: number; // 标称位深上限（如255）
  declaredAt: string;
  provenance: SourceAnchor;
}

export type Rotation = 0 | 90 | 180 | 270;

export interface OrientationMaterial {
  type: 'capture-orientation';
  id: string;
  imageId: string;
  // 拍摄方向=原始方向声明；旋转属于后续决定事件，不在这里改写
  rotationDeclared: Rotation;
  wellsAtDeclared: 'top' | 'bottom' | 'left' | 'right';
  provenance: SourceAnchor;
}

export interface ExposureMaterial {
  type: 'exposure';
  id: string;
  imageId: string;
  exposureSecondsRaw: string;       // 保留原始表示，如 "1/30"
  exposureSeconds: number | null;  // 派生规范化；无法转换为 null 并附诊断
  gainRaw: string;
  gain: number | null;
  gamma: number;
  provenance: SourceAnchor;
}

export interface LadderNominalEntry {
  ordinal: number;          // 自上而下的槽位序号（顺序身份）
  id: string;               // 稳定身份
  raw: string;              // 原始表示（导入保留）
  nominalBp: number | null; // 派生层解析；无法转换留 null，不删除条目
  unit: string;             // 'bp'
  unusableReason?: string;
}

export interface LadderSpecMaterial {
  type: 'ladder-spec';
  id: string;
  name: string;
  entries: LadderNominalEntry[]; // 顺序即身份
  provenance: SourceAnchor;
}

export interface LaneCurve {
  laneId: string;
  ordinal: number;
  role: 'ladder' | 'sample';
  sampleName?: string;
  // 中心线折线（像素，井在起点一侧）；弯曲泳道即非直线折线
  points: PixelPoint[];
  halfWidthPx: number;
  provenance: SourceAnchor;
}

export interface LaneGeometryMaterial {
  type: 'lane-geometry';
  id: string;
  imageId: string;
  ladderLaneId: string;
  lanes: LaneCurve[];
  provenance: SourceAnchor;
}

export type BandKind = 'normal' | 'saturated' | 'tailed' | 'overlap' | 'merged';

export interface BandAnnotation {
  id: string;             // 稳定身份
  laneId: string;
  ordinal: number;        // 泳道内自上而下顺序
  center: PixelPoint;     // 人工/来源标注中心（像素级）
  kindHint?: BandKind;
  label?: string;
  provenance: SourceAnchor;
}

export interface BandAnnotationMaterial {
  type: 'band-annotation';
  id: string;
  imageId: string;
  bands: BandAnnotation[];
  provenance: SourceAnchor;
}

export type Material =
  | ImageMaterial | OrientationMaterial | ExposureMaterial
  | LadderSpecMaterial | LaneGeometryMaterial | BandAnnotationMaterial;

// ---------- 事件 / 决定（仅追加） ----------
export type EventType =
  | 'project-created'
  | 'materials-imported'
  | 'orientation-confirmed'
  | 'param-revision'
  | 'lane-curves-adjusted'
  | 'band-centers-adjusted'
  | 'source-patch'
  | 'band-decision'
  | 'branch-created';

export type DecisionValue =
  | { kind: 'accept'; bp: number }
  | { kind: 'reject'; reason: string }
  | { kind: 'range'; bpLow: number; bpHigh: number };

export interface EventPayloadMap {
  'project-created': { name: string; casePackVersion: string };
  'materials-imported': { materialIds: string[]; importFileName: string };
  'orientation-confirmed': { rotationApplied: Rotation; wellsAt: 'top'|'bottom'|'left'|'right' };
  'param-revision': { fromVersion: string; toVersion: string; reason: string };
  'lane-curves-adjusted': { geometryMaterialId: string; laneIds: string[]; reason: string };
  'band-centers-adjusted': { annotationMaterialId: string; bandIds: string[]; reason: string };
  'source-patch': {
    target: string; // 单一直接来源，例如 'band:center' | 'ladder:nominal' | 'image:pixels' | 'lanes:curves' | 'orientation'
    materialId: string; fieldPath: string;
    newMaterialId?: string;
    summary: string;
    scope: { laneIds?: string[]; bandIds?: string[] }; // 局部影响范围
    // 补丁携带的新材料版本（仍是不可变材料，仅由事件引用）
    newLadder?: LadderSpecMaterial;
    newGeometry?: LaneGeometryMaterial;
    newBandCenter?: { bandId: string; center: PixelPoint };
    imageSha256?: string;
    rotationApplied?: Rotation;
  };
  'band-decision': {
    bandId: string; laneId: string;
    decision: DecisionValue;
    conflictsWith?: string; // 另一分支上冲突决定的事件 id（引用，不覆盖）
    reason: string;
  };
  'branch-created': { name: string; fromEventId: string; purpose: string };
}

export type Event = {
  id: string;
  projectId: string;
  branchId: string;
  seq: number;
  parentId: string | null;
  type: EventType;
  createdAt: string;
  creator: string;
} & { [K in EventType]: { type: K; payload: EventPayloadMap[K] } }[EventType];

export interface Branch {
  id: string; projectId: string; name: string;
  headEventId: string | null; forkedFromEventId: string | null;
  purpose: string;
}

export interface Project {
  id: string; name: string; casePackVersion: string; createdAt: string;
}

// ---------- 诊断 ----------
export type DiagnosticCode =
  | 'INCOMPLETE_INPUT' | 'UNCONVERTIBLE_VALUE' | 'CORRUPT_FORMAT'
  | 'SEMANTIC_NO_SOLUTION' | 'BUDGET_EXHAUSTED' | 'ID_CONFLICT'
  | 'OUT_OF_VALID_REGION' | 'LADDER_MISSING_BAND'
  | 'SATURATED_CANDIDATE' | 'TAIL_CANDIDATE' | 'OVERLAP_CANDIDATES'
  | 'LOCAL_DEPENDENCY_INVALID' | 'STAGED_WRITE_INTERRUPTED';

export interface Diagnostic {
  code: DiagnosticCode;
  message: string;
  path?: string;        // 带位置：如 'ladder.entries[4].raw'
  materialId?: string;
  nodeId?: string;
  eventSeq?: number;
  detail?: Record<string, unknown>;
}

export type ComputeStatus =
  | 'ok' | 'candidate' | 'invalid' | 'no-solution'
  | 'budget-exhausted' | 'corrupt-format';

// ---------- 计算节点（内容寻址） ----------
export interface ProfileSample { s: number; intensity: number; saturated: boolean }

export interface AutoPeak {
  bandCandidateId: string;
  s: number;
  sSpan?: PixelSpan;          // 饱和/重叠时给区间
  prominence: number;
  width: number;
  saturated: boolean;
  tailed: boolean;
  overlapGroup?: string;
}

export interface CalibrationAnchor {
  nominalId: string; ordinal: number;
  s: number; bp: number;
  matchedBandId: string | null; // 缺带 => null
  residualVsGlobalLogFit: number; // bp 残差（对数空间折算回 bp 的相对偏差）
}

export interface InterpSegment {
  id: string;
  fromAnchorOrdinal: number; toAnchorOrdinal: number;
  sFrom: number; sTo: number;
  bpFrom: number; bpTo: number;
  skippedNominalOrdinals: number[];
}

export interface ValidRegion { sMin: number; sMax: number; unit: 'px-arc' }

export interface CalibrationResult {
  ladderLaneId: string;
  anchors: CalibrationAnchor[];
  segments: InterpSegment[];
  validRegion: ValidRegion;
  monotonic: boolean;
  notes: string[];
}

export interface MwCandidate {
  candidateId: string;
  bp: number | null;
  bpRange?: { low: number; high: number };
  s: number;
  segmentId: string | null;
  kind: 'unique' | 'saturated' | 'tail' | 'overlap-a' | 'overlap-b' | 'out-of-region';
}

export interface BandMwResult {
  bandId: string; laneId: string;
  s: number; sUnit: 'px-arc';
  status: ComputeStatus;
  candidates: MwCandidate[];
  diagnostics: Diagnostic[];
  autoMatched?: { peakS: number; bp: number | null; deltaBpVsManual: number | null };
}

export interface ComputationNode {
  id: string;
  kind: 'rotated-image' | 'lane-profile' | 'auto-peaks' | 'lane-calibration' | 'band-mw';
  subjectId: string;           // laneId / bandId / imageId
  status: ComputeStatus;
  inputsDigest: string;        // 输入摘要
  paramsVersion: string;
  dependencies: string[];      // 父级依赖（节点 id）
  diagnostics: Diagnostic[];
  result: unknown;
  budget?: { used: number; limit: number };
}

export interface DecisionRecord {
  eventId: string; branchId: string; seq: number;
  decision: DecisionValue; reason: string; createdAt: string;
}
