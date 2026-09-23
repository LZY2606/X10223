import type { ParameterName } from '../shared/model.js';
import { digestOf } from '../shared/ids.js';

export const PARAMETER_NAMES: ParameterName[] = [
  'saturationThreshold',
  'tailingAsymmetry',
  'overlapSeparationPx',
  'extrapolationBudgetMm',
  'bandSnapping',
];

export const PARAMETER_DEFAULT: Record<ParameterName, number | string | boolean> = {
  saturationThreshold: 8,
  tailingAsymmetry: 1.8,
  overlapSeparationPx: 14,
  extrapolationBudgetMm: 1.0,
  bandSnapping: true,
};

export function parameterVersionId(values: Record<ParameterName, number | string | boolean>): string {
  return `pv_${digestOf(PARAMETER_NAMES.map((name) => [name, values[name]])).slice(0, 16)}`;
}

export function defaultParameters(): Record<ParameterName, number | string | boolean> {
  return { ...PARAMETER_DEFAULT };
}
