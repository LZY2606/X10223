/**
 * 领域量：所有物理量都携带单位或坐标基准。
 * 导入时保留原始表示（raw），派生层才做规范化（norm）。
 * 无法转换的值留在原位置（convertible=false）并附诊断，不能为了画图丢掉。
 */

export type QuantityKind =
  | 'molecularWeight'
  | 'migrationDistance'
  | 'length'
  | 'angle'
  | 'exposureTime'
  | 'intensity'
  | 'pixel';

export interface UnitDef {
  /** 量纲类别 */
  kind: QuantityKind;
  /** 单位符号，如 bp / kDa / mm / deg / ms / pixel / fiu */
  symbol: string;
  /** 换算到该量纲规范单位的乘数；不可转换时为 null */
  toBase: number | null;
}

/** 量纲规范单位（派生层规范化目标） */
export const BASE_UNITS: Record<QuantityKind, UnitDef> = {
  molecularWeight: { kind: 'molecularWeight', symbol: 'bp', toBase: 1 },
  migrationDistance: { kind: 'migrationDistance', symbol: 'px', toBase: 1 },
  length: { kind: 'length', symbol: 'mm', toBase: 1 },
  angle: { kind: 'angle', symbol: 'deg', toBase: 1 },
  exposureTime: { kind: 'exposureTime', symbol: 'ms', toBase: 1 },
  intensity: { kind: 'intensity', symbol: 'fiu', toBase: 1 },
  pixel: { kind: 'pixel', symbol: 'px', toBase: 1 }
};

const UNIT_TABLE: Record<string, UnitDef> = {
  bp: BASE_UNITS.molecularWeight,
  kDa: { kind: 'molecularWeight', symbol: 'kDa', toBase: null },
  px: BASE_UNITS.pixel,
  pixel: BASE_UNITS.pixel,
  mm: BASE_UNITS.length,
  cm: { kind: 'length', symbol: 'cm', toBase: 10 },
  um: { kind: 'length', symbol: 'um', toBase: 0.001 },
  nm: { kind: 'length', symbol: 'nm', toBase: 0.000001 },
  deg: BASE_UNITS.angle,
  rad: { kind: 'angle', symbol: 'rad', toBase: 180 / Math.PI },
  ms: BASE_UNITS.exposureTime,
  s: { kind: 'exposureTime', symbol: 's', toBase: 1000 },
  fiu: BASE_UNITS.intensity
};

/** 带单位的量。raw 保留导入时的原始表示（字符串），norm 是规范化后的数值。 */
export interface Quantity {
  kind: QuantityKind;
  unit: string;
  /** 导入时的数值（以 unit 为单位）；原始表示不可解析时为 null */
  value: number | null;
  /** 导入时的原始文本表示，永不丢失 */
  raw: string;
  /** 规范化（BASE_UNITS）后的数值；不可转换或不可解析时为 null */
  norm: number | null;
  /** 单位是否可转换到规范单位 */
  convertible: boolean;
}

export function quantity(
  kind: QuantityKind,
  rawValue: string | number,
  unit?: string
): Quantity {
  const raw = typeof rawValue === 'string' ? rawValue.trim() : String(rawValue);
  const u = (unit ?? BASE_UNITS[kind].symbol).trim();
  const parsed = typeof rawValue === 'number' ? rawValue : Number(raw);
  const def = UNIT_TABLE[u.toLowerCase()];
  const numeric = Number.isFinite(parsed) ? parsed : null;
  const convertible =
    numeric !== null && !!def && def.kind === kind && def.toBase !== null;
  return {
    kind,
    unit: u,
    value: numeric,
    raw,
    norm: convertible ? numeric! * (def!.toBase as number) : null,
    convertible
  };
}

export function formatQuantity(q: Quantity): string {
  if (q.value === null) return `${q.raw} ${q.unit}（不可解析）`;
  return `${q.value} ${q.unit}`;
}

/** 像素坐标基准：坐标始终以某一版光栅（rasterId, rotation）为基准 */
export interface PixelPoint {
  x: number;
  y: number;
  /** 该坐标所参照的几何版本（对应事件链中的几何版本） */
  frame: string;
}
