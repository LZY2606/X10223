// 领域类型：不可变材料（像素级来源）与可修改决定（派生层）分层。
export type Id = string;

/** 图像像素坐标：原点为图像左上角，单位 px。 */
export interface PixelPoint { x: number; y: number }

export type Orientation = 'as-captured' | 'rotated-90' | 'rotated-180' | 'rotated-270';

/** 每个材料点都保留像素级来源。 */
export interface Provenance {
  source: 'import' | 'auto-detect' | 'manual';
  pixel: PixelPoint;            // 本材料所在图像坐标系下的像素
  image_id?: Id;
  orientation?: Orientation;    // 该坐标系的拍摄方向
  original_pixel?: PixelPoint;  // 若经过旋转等变换，保留 as-captured 坐标系下的原像素
  note?: string;
}

export interface Exposure { seconds: number; gain: number }

export interface ImageMaterial {
  kind: 'image';
  id: Id;
  width: number;
  height: number;
  orientation: Orientation;
  exposure: Exposure;
  pixel_digest: string; // sha256 of raw pixels
}

export interface LadderBand {
  id: Id;
  nominal_bp: number;   // 标称值，单位 bp
  present: boolean;     // false = ladder 缺带（胶上未出现，但保留标称位置）
  pixel: PixelPoint;
  provenance: Provenance;
}

export interface LadderMaterial {
  kind: 'ladder';
  id: Id;
  image_id: Id;
  lane_index: number;
  label: string;
  bands: LadderBand[];
}

export interface LaneBoundaryMaterial {
  kind: 'lane-boundary';
  id: Id;
  image_id: Id;
  lane_index: number;
  centerline: { point: PixelPoint; provenance: Provenance }[];
}

/** “微笑”弯曲的条带前沿曲线：同一高度不等于同一分子量的校正依据。 */
export interface FrontCurveMaterial {
  kind: 'front-curve';
  id: Id;
  image_id: Id;
  reference_lane: number;
  points: { point: PixelPoint; provenance: Provenance }[];
}

export interface BandCenterMaterial {
  kind: 'band-center';
  id: Id;
  image_id: Id;
  lane_index: number;
  pixel: PixelPoint;
  intensity: number;    // 0..255，原始灰度
  saturated: boolean;
  half_height_px: number;
  provenance: Provenance;
}

export type Material =
  | ImageMaterial
  | LadderMaterial
  | LaneBoundaryMaterial
  | FrontCurveMaterial
  | BandCenterMaterial;

export interface Diagnostic {
  code: string;
  message: string;
  position?: { lane_index?: number; pixel?: PixelPoint; band_id?: Id; material_id?: Id };
}

/** 资源预算耗尽、格式损坏、语义无解是三种不同结果。 */
export type FailureStatus = 'resource_exhausted' | 'corrupt_format' | 'semantic_unsolvable';
export type ComputeStatus = 'ok' | FailureStatus;

export type ComputeResult<T> =
  | { status: 'ok'; value: T; diagnostics: Diagnostic[] }
  | { status: FailureStatus; diagnostics: Diagnostic[] };

export interface RulerSegment {
  id: Id;
  y_top: number;       // 校正后 px，插值段上端（迁移距离小、分子量大）
  y_bottom: number;    // 校正后 px，插值段下端
  bp_top: number;      // 单位 bp
  bp_bottom: number;   // 单位 bp
  gap: boolean;        // 该段跨越 ladder 缺带
}

export interface CalibrationData {
  subject_id: Id;
  image_id: Id;
  param_version: string;
  segments: RulerSegment[];
  /** 局部标尺有效区域（校正后 px），区域外不得给出点估计。 */
  validity: { y_min: number; y_max: number };
  residuals: { band_id: Id; y: number; log10_bp_resid: number }[];
  parents: Id[];
  input_digest: string;
}

export type EstimateValue =
  | { type: 'point'; bp: number }
  | { type: 'interval'; bp_min: number; bp_max: number; reason: 'saturated' | 'smear' }
  | { type: 'candidates'; options: { bp: number; band_id: Id }[]; reason: 'overlap' };

export interface MwEstimateData {
  subject_id: Id;
  band_id: Id;
  image_id: Id;
  lane_index: number;
  param_version: string;
  status: ComputeStatus;
  value?: EstimateValue;
  corrected_y: number;  // 经微笑曲线校正后的迁移坐标，单位 px
  validity: { y_min: number; y_max: number };
  diagnostics: Diagnostic[];
  parents: Id[];
  input_digest: string;
}

export type EventKind =
  | 'import' | 'review-confirm' | 'param-revision' | 'source-change'
  | 'decision' | 'conflict' | 'recompute' | 'export' | 'import' | 'narrative';

export interface GelEvent {
  id: Id;
  seq: number;
  kind: EventKind;
  summary: string;
  payload: unknown;
  param_version: string;
  input_digest: string;
  parents: Id[];
  created_at: string;
}

export interface DerivedRow {
  id: Id;
  subject_id: Id;
  kind: 'calibration' | 'mw-estimate';
  version: number;
  seq: number;
  invalidated_seq: number | null;
  invalidated_by: Id | null;
  data: CalibrationData | MwEstimateData;
}
