/**
 * 领域量与坐标基准。
 * 规则：所有领域量必须携带单位或坐标基准；导入层保留原始表示，
 * 只有派生层才做规范化；无法转换的值留在原位置并附诊断。
 */

export type Unit =
  | 'bp'        // 碱基对（分子量标称值）
  | 'kDa'       // 蛋白分子量
  | 'px'        // 像素（必须带坐标基准 CoordinateBasis）
  | 'ms'        // 曝光毫秒
  | 'ratio';    // 无量纲增益等

export interface Quantity {
  value: number;
  unit: Unit;
  /** 原始表示（导入时逐字保留），例如 "1500 bp"、"1,5kb" */
  raw?: string;
  /** 规范化是否成功；失败时 value 保留为 NaN，raw 留在原位置 */
  convertible: boolean;
  basis?: CoordinateBasis;
}

/** 坐标基准：像素坐标必须说明属于哪幅图、哪个帧、原点方向 */
export interface CoordinateBasis {
  imageId: string;
  frameId: string;
  origin: 'top-left';
  axisX: 'right';
  axisY: 'down';
  /** 迁移方向在该帧中的单位向量（canonical 为向下 (0,1)） */
  migrationAxis: { x: number; y: number };
}

export function q(value: number, unit: Unit, raw?: string): Quantity {
  return { value, unit, raw, convertible: Number.isFinite(value) };
}

/** 无法转换的量：保留原文，不用默认值伪装 */
export function unconvertible(raw: string, unit: Unit): Quantity {
  return { value: NaN, unit, raw, convertible: false };
}

export interface Point {
  x: number;
  y: number;
}

/** 像素级来源点：坐标永远绑定具体图像与帧 */
export interface SourcedPoint extends Point {
  basis: CoordinateBasis;
}
