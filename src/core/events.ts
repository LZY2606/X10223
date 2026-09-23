import type { Basis, Diagnostic, PointXY, Quantity } from '../shared/types'

// ---------------------------------------------------------------------------
// 不可变材料层（immutable source material）
//   原图 / 拍摄方向 / 曝光 / ladder 标称值 / lane 边界 / 条带中心
//   全部带像素级来源（imageId + 像素坐标 + 原始表示）。
//   "修订"不是覆盖，而是追加一条新版本事件，旧版本保留并参与历史。
// ---------------------------------------------------------------------------

export type EventType =
  | 'project_created'
  | 'image_added'
  | 'orientation_declared'
  | 'exposure_declared'
  | 'ladder_nominal_set'
  | 'lane_boundaries_set'
  | 'band_centers_set'
  // 可修改决定层
  | 'detection_run' // 自动候选（派生工件的登记事件）
  | 'decision' // 接受 / 否定 / 参数调整 / 手工修订

export interface EventBase {
  eventId: string
  projectId: string
  branchId: string
  /** 分支内单调序号（稳定顺序）。 */
  seq: number
  /** 父事件 id（分支因果链；回到旧事件时恢复当时依赖版本）。 */
  parentId: string | null
  at: string // ISO 时间基准
  type: EventType
}

export interface ImageAddedEvent extends EventBase {
  type: 'image_added'
  imageId: string
  name: string
  width: number
  height: number
  /** 原始 PNG 字节存入 blob 表；这里保留摘要。 */
  sha256: string
  byteLength: number
  note?: string
}

export interface OrientationDeclaredEvent extends EventBase {
  type: 'orientation_declared'
  imageId: string
  /** 0/90/180/270 顺时针旋转，使迁移方向向下；保留拍摄方向原始说法。 */
  rotationDeg: 0 | 90 | 180 | 270
  rawStatement: string
  basis: Basis
}

export interface ExposureDeclaredEvent extends EventBase {
  type: 'exposure_declared'
  imageId: string
  exposure: Quantity // ms，带原始表示
  rawStatement: string
  /** 饱和判定灰度阈值（参数版本的一部分，默认不允许隐式出现，必须显式给）。 */
  saturationGray: number
}

export interface LadderNominal {
  /** 槽位（自上而下，即迁移由小到大）。 */
  slot: number
  nominal: Quantity // bp / kDa
  /** 原始文本，无法转换时保留在原位置。 */
  raw: string
  /** 声明该槽位在图中缺失（缺带场景），保留标称值来源。 */
  declaredMissing?: boolean
}

export interface LadderNominalSetEvent extends EventBase {
  type: 'ladder_nominal_set'
  ladderLaneId: string
  maker: string
  unit: 'bp' | 'kDa'
  entries: LadderNominal[]
  rawText: string
  /** 修订版本（v1, v2...），旧版本事件仍保留。 */
  revision: number
}

export interface LaneBoundary {
  laneId: string
  label: string
  isLadder?: boolean
  /** 像素折线（相对原图像素坐标）；直线道为两点，弯曲道为多点。 */
  spine: PointXY[]
  /** 泳道横向半宽（像素）。 */
  halfWidth: number
}

export interface LaneBoundariesSetEvent extends EventBase {
  type: 'lane_boundaries_set'
  imageId: string
  lanes: LaneBoundary[]
  revision: number
  source: 'manual' | 'auto_proposal'
}

export interface BandCenter {
  bandId: string
  laneId: string
  /** 像素坐标（原图基准）。 */
  at: PointXY
  /** 人工/自动给出时的原始坐标表示。 */
  raw: string
  /** 人工标记该带为拖尾。 */
  smear?: boolean
}

export interface BandCentersSetEvent extends EventBase {
  type: 'band_centers_set'
  imageId: string
  bands: BandCenter[]
  revision: number
  source: 'manual' | 'auto_proposal'
}

// ---------------------------------------------------------------------------
// 派生工件（content-addressed；记录输入摘要、参数版本、父级依赖）
// ---------------------------------------------------------------------------

export interface InputDigest {
  /** 参与计算的事件/工件 id 与各自 sha 摘要。 */
  deps: { ref: string; sha: string }[]
  paramsVersion: string
  params: Record<string, unknown>
}

export interface BandObservation {
  bandId: string
  laneId: string
  at: PointXY
  /** 沿泳道弧长坐标（px），自 spine 顶端起。 */
  s: number
  /** 峰值灰度。 */
  peak: number
  saturated: boolean
  saturatedFraction: number
  smear: boolean
  /** 与相邻带的重叠比例（0..1）。 */
  overlapWith: { bandId: string; fraction: number }[]
  /** 自动轮廓：沿弧长的强度轮廓，供前端叠加与残差显示。 */
  profile: { s: number; v: number }[]
  source: 'auto' | 'manual'
  diagnostics: Diagnostic[]
}

export interface CalibrationPoint {
  ladderBandId: string
  slot: number
  s: number
  nominal: Quantity
  declaredMissing: boolean
  /** 是否实际参与拟合（缺带 / 残差离群被排除则 false）。 */
  used: boolean
  residualLog?: number
  excludeReason?: string
}

export interface CalibrationSegment {
  index: number
  /** 有效区域：弧长 [s0,s1]；区间外不得内插，只返回失效诊断。 */
  s0: number
  s1: number
  /** log10(分子量) = a * s + b */
  a: number
  b: number
  /** 该段使用的两个 ladder 点。 */
  pointIds: [string, string]
}

export interface CalibrationArtifact {
  artifactId: string
  kind: 'calibration'
  inputDigest: InputDigest
  ladderLaneId: string
  points: CalibrationPoint[]
  segments: CalibrationSegment[]
  validS: [number, number]
  basisS: string
  unit: 'bp' | 'kDa'
  diagnostics: Diagnostic[]
  status: 'ok' | 'degraded' | 'semantic_impasse'
}

export interface MwInference {
  bandId: string
  laneId: string
  s: number
  /** unique：唯一；candidates：保留全部合法候选；interval：区间；invalid：失效。 */
  state: 'unique' | 'candidates' | 'interval' | 'invalid'
  unique?: Quantity
  candidates?: Quantity[]
  interval?: [Quantity, Quantity]
  segmentIndex?: number
  reasons: string[]
  diagnostics: Diagnostic[]
}

export interface MwArtifact {
  artifactId: string
  kind: 'mw_inference'
  inputDigest: InputDigest
  inferences: MwInference[]
  diagnostics: Diagnostic[]
}

export interface DetectionArtifact {
  artifactId: string
  kind: 'detection'
  inputDigest: InputDigest
  imageId: string
  proposedLanes: LaneBoundary[]
  observations: BandObservation[]
  diagnostics: Diagnostic[]
  budget: { pixels: number; budgetPixels: number; exhausted: boolean }
}

export type Artifact = DetectionArtifact | CalibrationArtifact | MwArtifact

// ---------------------------------------------------------------------------
// 决定事件：接受 / 否定 / 参数调整 / 手工修订 / 分支
// ---------------------------------------------------------------------------

export type DecisionVerb =
  | 'create_branch'
  | 'accept_proposal'
  | 'reject_proposal'
  | 'tune_params'
  | 'manual_lanes'
  | 'manual_bands'
  | 'revise_ladder'
  | 'annotate'

export interface DecisionEvent extends EventBase {
  type: 'decision'
  verb: DecisionVerb
  /** 被决定的候选/工件 id（可多个）。 */
  targets: string[]
  /** accept / reject 的结论。 */
  verdict?: 'accepted' | 'rejected'
  reason: string
  /** tune_params 的新参数版本与内容（旧参数版本仍由 inputDigest 保留）。 */
  paramsVersion?: string
  params?: Record<string, unknown>
  /** create_branch。 */
  newBranchId?: string
  label?: string
  /** 采纳 / 未采纳结果都留档（拒绝的候选仍保留并指向本事件）。 */
  adoptedArtifactIds?: string[]
  rejectedArtifactIds?: string[]
}

export interface DetectionRunEvent extends EventBase {
  type: 'detection_run'
  artifactId: string
  trigger: 'auto' | 'manual'
  paramsVersion: string
}

export type AnyEvent =
  | (EventBase & { type: 'project_created'; name: string })
  | ImageAddedEvent
  | OrientationDeclaredEvent
  | ExposureDeclaredEvent
  | LadderNominalSetEvent
  | LaneBoundariesSetEvent
  | BandCentersSetEvent
  | DetectionRunEvent
  | DecisionEvent

export type RevisionEventType =
  | 'orientation_declared'
  | 'exposure_declared'
  | 'ladder_nominal_set'
  | 'lane_boundaries_set'
  | 'band_centers_set'
