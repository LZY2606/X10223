// 领域类型：所有领域量都带单位 / 坐标基准；原图与观测保留原始表示。

export type Unit =
  | 'bp' // 核酸片段长度（碱基对）
  | 'kDa' // 蛋白分子量
  | 'px' // 像素
  | 'gray8' // 0..255 灰度
  | 'ms' // 曝光时间毫秒
  | 'deg' // 角度
  | 'dimensionless'

export type BasisKind = 'image_pixels' | 'oriented_image' | 'lane_arclength' | 'time' | 'nominal_ladder'

/** 坐标/单位/时间基准。basisId 为内容寻址稳定身份。 */
export interface Basis {
  basisId: string
  kind: BasisKind
  unit: Unit
  origin: string
  note?: string
}

export interface Quantity {
  value: number
  unit: Unit
  /** 原始表示（导入时保留，例如 "1.5 kb"），规范化只发生在派生层。 */
  raw?: string
}

export interface PointXY {
  x: number
  y: number
}

export type Severity = 'error' | 'warning' | 'info'

/** 带位置的诊断；输入不完整时返回诊断而不是用空值/默认值伪装成功。 */
export interface Diagnostic {
  code: string
  severity: Severity
  message: string
  /** 像素级/字段级位置。 */
  at?: PointXY & { laneId?: string; field?: string; segmentIndex?: number }
  /** 输入片段（保留来源原文）。 */
  fragment?: string
}

/** 三种互不相同的失败结果。 */
export type FailureKind = 'budget_exhausted' | 'corrupt_format' | 'semantic_impasse'

export class DomainFailure extends Error {
  kind: FailureKind
  diagnostics: Diagnostic[]
  constructor(kind: FailureKind, message: string, diagnostics: Diagnostic[] = []) {
    super(message)
    this.kind = kind
    this.diagnostics = diagnostics
  }
}
