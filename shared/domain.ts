import { createHash } from 'node:crypto';

/** 坐标基准：所有像素量均以原图左上角为原点，y 轴向下，单位 px。 */
export const PIXEL_BASIS = 'image-top-left-y-down/px' as const;
export type Px = number;

export interface Diagnostic {
  code: string;
  severity: 'error' | 'warning';
  message: string;
  at: { materialId?: string; laneId?: string; bandId?: string; yPx?: Px; xPx?: Px };
}

export type MaterialKind =
  | 'image'
  | 'orientation'
  | 'exposure'
  | 'ladder_nominal'
  | 'lane_boundary'
  | 'band_center';

export interface Material<T = unknown> {
  id: string;
  kind: MaterialKind;
  version: number;
  payload: T;
  hash: string;
  supersedes: string | null;
  registeredBy: string | null;
}

export interface ImagePayload {
  file: string;
  width: Px;
  height: Px;
  sha256: string;
  basis: typeof PIXEL_BASIS;
}
export interface OrientationPayload {
  rotationDeg: 0 | 90 | 180 | 270;
  flip: 'none' | 'h' | 'v';
  basis: typeof PIXEL_BASIS;
}
export interface ExposurePayload {
  seconds: number;
  gainDb: number;
  saturationThreshold: number;
}
export interface LadderNominalPayload {
  sizesBp: number[];
  unit: 'bp';
}
export interface LaneBoundaryPayload {
  laneId: string;
  role: 'ladder' | 'sample';
  xLeft: Px;
  xRight: Px;
  source: 'auto' | 'manual';
  evidencePx: { x: Px; y: Px }[];
  basis: typeof PIXEL_BASIS;
}
export interface BandCenterPayload {
  bandId: string;
  laneId: string;
  x: Px;
  y: Px;
  intensity: number;
  extentYPx: Px;
  source: 'auto' | 'manual';
  basis: typeof PIXEL_BASIS;
}

export interface GelEvent {
  id: string;
  seq: number;
  branch: string;
  type:
    | 'material.registered'
    | 'parameter.revised'
    | 'decision.made'
    | 'source.amended'
    | 'result.computed'
    | 'scenario.applied';
  payload: Record<string, unknown>;
  parents: string[];
  inputDigest: string;
  paramVersion: number;
  createdAt: string;
}

export interface Params {
  version: number;
  saturationThreshold: number;
  minBandSeparationPx: number;
  smearExtentPx: number;
  smileOrder: 1 | 2;
  maxBandsPerRun: number;
}

export const DEFAULT_PARAMS: Params = {
  version: 1,
  saturationThreshold: 250,
  minBandSeparationPx: 8,
  smearExtentPx: 22,
  smileOrder: 2,
  maxBandsPerRun: 64,
};

export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonical(obj[k])).join(',') + '}';
}

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export function digestOf(value: unknown): string {
  return sha256(canonical(value));
}

export function materialId(kind: MaterialKind, payload: unknown, version: number): string {
  return `mat_${sha256(kind + ':' + version + ':' + canonical(payload)).slice(0, 16)}`;
}

export function eventId(seq: number, branch: string, type: string, payload: unknown): string {
  return `evt_${sha256(`${seq}:${branch}:${type}:${canonical(payload)}`).slice(0, 16)}`;
}

export function resultId(targetBandId: string, inputDigest: string, paramVersion: number): string {
  return `res_${sha256(`${targetBandId}:${inputDigest}:${paramVersion}`).slice(0, 16)}`;
}

/** 等价输入必须得到稳定顺序：统一按 (laneId, y, bandId) 排序。 */
export function stableBandOrder<T extends { laneId: string; y: number; bandId: string }>(bands: T[]): T[] {
  return [...bands].sort(
    (a, b) => a.laneId.localeCompare(b.laneId) || a.y - b.y || a.bandId.localeCompare(b.bandId),
  );
}
