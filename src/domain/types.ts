export type Id = string;

/** 像素级来源坐标，基准为方向校正后的图像坐标系（原点在左上，单位 px）。 */
export interface PixelPoint {
  x: number;
  y: number;
  basis: 'image-pixel';
}

export interface Diagnostic {
  code: string;
  message: string;
  /** 出错位置（JSON 路径），输入不完整/损坏时必须带位置。 */
  path: string;
}

/** 三种必须可区分的失败：资源预算耗尽 / 格式损坏 / 语义无解。 */
export type FailureKind = 'RESOURCE_EXHAUSTED' | 'FORMAT_CORRUPT' | 'SEMANTIC_UNSOLVABLE';

export type Outcome<T> =
  | { ok: true; value: T; diagnostics?: Diagnostic[] }
  | { ok: false; kind: FailureKind; diagnostics: Diagnostic[] };

export type MaterialKind =
  | 'gel-image'
  | 'orientation'
  | 'exposure'
  | 'ladder-nominal'
  | 'lane-boundary'
  | 'band-center'
  | 'intensity-profile';

/** 不可变材料：内容寻址，写入后不可修改。 */
export interface Material {
  id: Id;
  projectId: Id;
  kind: MaterialKind;
  hash: string;
  payload: any;
  blob?: Uint8Array | null;
  createdByEvent: Id | null;
}

/** 事件：可修改决定层只通过追加事件变化。 */
export interface GelEvent {
  id: Id;
  projectId: Id;
  seq: number;
  kind: string;
  parents: Id[];
  inputDigest: string;
  paramVersion: string;
  payload: any;
  createdAt: string;
}

export interface Branch {
  projectId: Id;
  name: string;
  headEventId: Id;
}

export interface OrientationPayload {
  rotationDeg: 0 | 90 | 180 | 270;
  mirrored: boolean;
  imageWidthPx: number;
  imageHeightPx: number;
  note?: string;
}

export interface ExposurePayload {
  exposureMs: number;
  gain: number;
  capturedAt: string;
}

export interface LadderPointPayload {
  pointId: Id;
  mwBp: number;
  observedY: number | null;
  pixel: PixelPoint | null;
}

export interface LadderPayload {
  ladderName: string;
  ladderLaneX: number;
  points: LadderPointPayload[];
}

export interface LaneBoundaryPayload {
  lanes: { laneIndex: number; xCenter: number; topY: number; bottomY: number }[];
  smile: { coeffPx: number; referenceX: number; supportedLaneRange: [number, number] };
}

export interface BandCenterPayload {
  laneIndex: number;
  bands: { bandId: Id; center: PixelPoint; halfHeightPx: number }[];
}

export interface IntensityPayload {
  peaks: { bandId: Id; peakIntensity: number; tailing?: boolean }[];
  saturationCeiling: number;
}
