import { createHash } from 'node:crypto';

/** 坐标基准：所有像素量都以此为准，展示层必须露出。 */
export const COORD_BASIS = 'px: origin=top-left, +x right, +y down (migration direction)' as const;

export interface Diagnostic {
  code: string;
  path: string; // 带位置的诊断，例如 materials.lane_boundaries.lanes[2].bands[0]
  message: string;
}

/** 三种必须区分的结果：预算耗尽 / 格式损坏 / 语义无解 */
export type Result<T> =
  | { ok: true; value: T; diagnostics: Diagnostic[] }
  | { ok: false; kind: 'budget' | 'format' | 'semantic'; diagnostics: Diagnostic[] };

export const ok = <T>(value: T, diagnostics: Diagnostic[] = []): Result<T> => ({ ok: true, value, diagnostics });
export const fail = (kind: 'budget' | 'format' | 'semantic', diagnostics: Diagnostic[]): Result<never> => ({ ok: false, kind, diagnostics });

/** 稳定顺序的规范化序列化：等价输入得到等价摘要。 */
export function canonicalize(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}
function sortDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortDeep);
  if (v && typeof v === 'object') {
    const o: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) o[k] = sortDeep((v as Record<string, unknown>)[k]);
    return o;
  }
  return v;
}
export function digest(value: unknown): string {
  return createHash('sha256').update(canonicalize(value)).digest('hex').slice(0, 16);
}

// ---------- 不可变材料（像素级来源） ----------
export type MaterialKind = 'gel_image' | 'capture_meta' | 'ladder_nominal' | 'lane_boundaries' | 'band_centers';

export interface Material<T = unknown> {
  id: string; // mat_<digest>，内容寻址，身份稳定
  kind: MaterialKind;
  version: number; // 同一逻辑材料的修订序号
  supersedes: string | null;
  content: T;
}

export interface GelImageContent {
  width: number;
  height: number;
  encoding: 'gray8-base64';
  pixels: string; // 原始表示原样保留，派生层才做旋转/规范化
  basis: typeof COORD_BASIS;
}

export interface CaptureMetaContent {
  orientationDeg: 0 | 90 | 180 | 270; // 拍摄方向
  exposureMs: number; // 曝光，单位 ms
  saturationLevel: number; // 饱和灰度级，例如 255
  basis: typeof COORD_BASIS;
}

export interface LadderNominalContent {
  laneId: string;
  nominalMwDa: number[]; // 标称分子量，单位 Da，按迁移顺序（大→小）
  unit: 'Da';
}

export interface Pt { x: number; y: number }

export interface LaneDef {
  laneId: string;
  role: 'ladder' | 'sample';
  centerline: Pt[]; // 像素坐标折线
  left: Pt[];
  right: Pt[];
  frontY: number; // 该泳道迁移前沿的像素 y（微笑弯曲时每条泳道不同）
  wellY: number; // 加样孔像素 y
}
export interface LaneBoundariesContent {
  lanes: LaneDef[];
  basis: typeof COORD_BASIS;
}

export interface BandEvidence {
  bandId: string;
  center: Pt; // 像素级来源
  outline: Pt[]; // 条带轮廓（像素多边形）
  maxIntensity: number; // 0..saturationLevel
  tailing: boolean;
  source: { imageMaterialId: string; region: { x: number; y: number; w: number; h: number } };
}
export interface BandCentersContent {
  laneId: string;
  bands: BandEvidence[];
  basis: typeof COORD_BASIS;
}

// ---------- 参数版本 ----------
export interface Params {
  version: string;
  saturationLevel: number;
  overlapMinSeparationPx: number;
  saturationCenterTolerancePx: number;
  interpolation: 'log-linear';
}
export const PARAMS_V1: Params = {
  version: 'pel-ruler/v1',
  saturationLevel: 255,
  overlapMinSeparationPx: 10,
  saturationCenterTolerancePx: 3,
  interpolation: 'log-linear',
};

// ---------- 派生层 ----------
export interface LadderPoint {
  bandId: string;
  nominalMwDa: number;
  rf: number;
  yPx: number;
}
export interface LaneRuler {
  laneId: string;
  points: LadderPoint[];
  valid: boolean;
  validityRegion: { rfMin: number; rfMax: number; yMinPx: number; yMaxPx: number } | null;
  residuals: { bandId: string; residualLogMw: number }[];
  diagnostics: Diagnostic[];
}
export interface MwEstimate {
  estimateId: string; // 稳定身份：est_<digest(bandId,paramVersion,inputDigest)>
  bandId: string;
  laneId: string;
  status: 'ok' | 'candidate' | 'interval' | 'invalid';
  mwDa: number | null;
  intervalDa: [number, number] | null;
  unit: 'Da';
  basis: typeof COORD_BASIS;
  rf: number | null;
  yPx: number;
  validity: LaneRuler['validityRegion'];
  reason: string | null;
  segment: { lo: LadderPoint; hi: LadderPoint } | null;
  candidates: number[] | null; // 无法唯一决定时的全部合法候选
  inputDigest: string;
  paramVersion: string;
  parents: string[]; // 父级依赖：材料 id + 事件 id
}
export interface InferenceResult {
  rulers: LaneRuler[];
  estimates: MwEstimate[];
  diagnostics: Diagnostic[];
}
