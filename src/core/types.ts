import type { Diagnostic } from '../shared/diagnostics';
import type { Pt } from '../shared/geometry';
import type { Qty } from '../shared/units';

// ---------- 不可变材料层 ----------

export type ImageRole = 'sample-gel' | 'rotated-gel' | 'smile-gel';
export type LaneRole = 'sample' | 'ladder';
export type BandKind = 'auto' | 'manual';
export type BandFlag = 'normal' | 'saturated' | 'smear' | 'overlap';
export type DecisionVerdict = 'accepted' | 'rejected' | 'adjusted' | 'conflict';

export interface Exposure {
  timeMs: Qty; // 曝光时长
  gain: Qty; // 增益（无量纲）
  saturatedPixelValue: Qty; // 判定饱和的灰度阈值 gray8
  raw?: Record<string, string | number>;
}

export interface ImageMaterial {
  id: string;
  kind: 'image';
  role: ImageRole;
  blobRef: string; // 内容寻址 blob 身份
  width: number;
  height: number;
  frameId: string;
  orientation: number; // 拍摄方向，1..8（EXIF 风格）；缺失即输入不完整
  rotationAppliedDeg: number; // 为审阅渲染而施加的显示旋转，不改原始字节
  exposure: Exposure;
  acquiredAt: string; // 时间基准 ISO8601
  source: ProvenanceSource;
}

export interface LaneMaterial {
  id: string;
  kind: 'lane';
  imageId: string;
  role: LaneRole;
  order: number;
  centerline: Pt[]; // 像素折线（可能弯曲）
  halfWidthPx: number;
  source: ProvenanceSource;
}

export interface BandMaterial {
  id: string;
  kind: 'band';
  laneId: string;
  imageId: string;
  bandKind: BandKind;
  center: Pt; // 条带中心，像素坐标
  flag: BandFlag;
  intensity: Qty; // gray8 峰值
  widthPx: number;
  source: ProvenanceSource;
}

export interface LadderBandNominal {
  ordinal: number;
  massBp: number; // 标称分子量 bp
  source: string; // 标称值文档条目
}

export interface LadderSpec {
  id: string;
  kind: 'ladder-spec';
  laneId: string;
  name: string;
  nominal: LadderBandNominal[]; // 标称值，严格按迁移顺序排列
  source: ProvenanceSource;
}

export type Material = ImageMaterial | LaneMaterial | BandMaterial | LadderSpec;

export interface ProvenanceSource {
  origin: 'import' | 'auto' | 'manual' | 'variant';
  reference: string; // 文件条目/字段/算法
  capturedAt: string;
  rawRepresentation?: string;
}

// ---------- 派生层 ----------

export interface LadderMapping {
  bandOrdinal: number;
  bandId: string;
  massBp: number;
  sPx: number; // 沿泳道中心线的弧长（不是图像 y）
}

export type CalibrationMethod = 'global-loglinear' | 'piecewise-linear';

export interface CalibrationParams {
  version: 1 | 2;
  method: CalibrationMethod;
  saturationThreshold: number; // gray8
  minPeakProminence: number; // gray8
  overlapDistancePx: number;
  monotonic: boolean;
  note: string;
}

export interface FitSegment {
  id: string; // 稳定身份：点击分子量可回到此插值段
  ordinalA: number;
  ordinalB: number;
  sApx: number;
  sBpx: number;
  massA: number;
  massB: number;
  validSPx: [number, number]; // 局部标尺有效区域
  logSlope: number;
  logIntercept: number;
}

export interface CalibrationResult {
  id: string;
  ladderSpecId: string;
  laneId: string;
  imageId: string;
  paramsVersion: 1 | 2;
  mappings: LadderMapping[];
  segments: FitSegment[];
  validSPx: [number, number];
  residuals: { bandId: string; ordinal: number; observedBp: number; nominalBp: number; residualBp: number; residualFrac: number }[];
  rmsResidualFrac: number;
  monotonic: boolean;
  diagnostics: Diagnostic[];
}

export interface MassCandidate {
  bandId: string;
  massBp: number;
  segmentId: string;
}

export interface MassResult {
  id: string;
  bandId: string;
  laneId: string;
  calibrationId: string;
  sPx: number;
  // 唯一决定时给 single；饱和/拖尾/重叠只能给候选或区间
  singleBp: number | null;
  intervalBp: [number, number] | null;
  candidates: MassCandidate[];
  status: 'resolved' | 'candidate-set' | 'interval' | 'out-of-range' | 'invalid';
  diagnostics: Diagnostic[];
  parentResults: string[];
  inputDigest: string;
  paramsVersion: 1 | 2;
  computedAt: string;
}

export interface Decision {
  id: string;
  kind: 'decision';
  eventId: string;
  branch: string;
  targetResultId: string;
  bandId: string;
  verdict: DecisionVerdict;
  chosenBp: number | null;
  note: string;
  supersedesDecisionId: string | null;
  conflictsWith: string[];
  at: string;
  basedOnCalibrationId: string; // 回到旧事件时恢复当时依赖版本
}

// ---------- 事件层（只追加） ----------

export type EventType =
  | 'project-created'
  | 'material-added'
  | 'auto-detected'
  | 'ladder-mapped'
  | 'calibration-computed'
  | 'mass-computed'
  | 'decision-made'
  | 'params-revised'
  | 'lane-edited'
  | 'orientation-corrected';

export interface DomainEvent {
  id: string;
  seq: number;
  branch: string;
  type: EventType;
  at: string;
  parents: string[]; // 父级依赖（事件/材料/结果稳定身份）
  inputDigest: string; // 输入摘要
  payload: Record<string, unknown>;
  diagnostics?: Diagnostic[];
  affected?: string[]; // 受影响对象身份
}

export interface Branch {
  name: string;
  parent: string | null; // 基线分支名
  forkEventSeq: number | null;
  purpose: string;
}

export interface Project {
  id: string;
  name: string;
  createdAt: string;
  branches: Record<string, Branch>;
}

export interface DerivationRecord {
  kind: 'auto-detection' | 'ladder-mapping' | 'calibration' | 'mass';
  resultIds: string[];
  inputDigest: string;
  paramsVersion: 1 | 2;
  parents: string[];
  at: string;
}

export interface ProjectState {
  project: Project;
  events: DomainEvent[];
  materials: Record<string, Material>;
  calibrationResults: Record<string, CalibrationResult>;
  massResults: Record<string, MassResult>;
  decisions: Record<string, Decision>;
  params: Record<string, CalibrationParams>; // 按分支
  derivations: DerivationRecord[];
}
