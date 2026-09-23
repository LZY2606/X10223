import type { MassUnit, Quantity } from './types.js';

export function qty(value: number, unit: MassUnit, raw?: string): Quantity<number, MassUnit> {
  return { value, unit, raw: raw ?? String(value) };
}

export function px(value: number, raw?: string): Quantity<number, 'px'> {
  return { value, unit: 'px', raw: raw ?? String(Math.round(value * 100) / 100) };
}

export function withUnitNote(q: Quantity): string {
  return `${q.value} ${q.unit}`;
}

export function isConvertible(raw: string): boolean {
  return /^-?\d+(\.\d+)?$/.test(raw.trim());
}
