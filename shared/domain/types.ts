/** 稳定身份：所有材料、事件、派生对象都带稳定 id，导出/导入后保持不变。 */
export type Id = string;

/** 诊断：输入不完整或不可转换时返回，带位置，绝不用空值/默认值伪装成功。 */
export interface Diagnostic {
  code: string;
  message: string;
  /** 出错输入的位置，例如 "ladders[0].bands[3].nominal" */
  path?: string;
  severity: 'error' | 'warning';
}

export type Result<T> =
  | { ok: true; value: T }
  | { ok: false; diagnostics: Diagnostic[] };

/** 三种必须区分的失败结果：预算耗尽 / 格式损坏 / 语义无解。 */
export type Failure =
  | { kind: 'budget-exhausted'; scope: string; used: number; budget: number }
  | { kind: 'format-corrupt'; path: string; message: string }
  | { kind: 'semantic-unsolvable'; diagnostics: Diagnostic[] };

export type Outcome<T> =
  | { status: 'ok'; value: T }
  | { status: 'failed'; failure: Failure };

/** 带单位的量。原始表示在导入层保留，规范化只发生在派生层。 */
export interface Quantity<U extends string> {
  value: number;
  unit: U;
}

/** 像素坐标基准：图像身份 + 拍摄方向 + 原点约定。 */
export interface PixelBasis {
  imageId: Id;
  /** 拍摄方向（as-shot）。旋转图像只改变该字段，不改写原始像素。 */
  orientation: 'as-shot' | 'rotated-90' | 'rotated-180' | 'rotated-270';
  origin: 'top-left';
  unit: 'px';
}

export interface PixelPoint {
  x: number;
  y: number;
}

/** 像素级来源：每个坐标都携带它来自哪张图、哪个方向。 */
export interface SourcedPoint extends PixelPoint {
  basis: PixelBasis;
}

export interface Interval {
  min: number;
  max: number;
}
