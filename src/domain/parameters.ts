import type { CalibrationParametersV1 } from '../shared/types.ts';
import { stableId } from './identity.ts';

export function parametersV1(): CalibrationParametersV1 {
  return {
    schema: 'gel-calibration-parameters',
    version: '1.0',
    model: 'piecewise-log-linear-migration',
    minPeakProminence: { value: 12, unit: 'graylevel-8' },
    saturationThreshold: { value: 252, unit: 'graylevel-8' },
    minimumSeparation: { value: 16, unit: 'px' },
    overlapSeparation: { value: 20, unit: 'px' },
    maximumExtrapolation: { value: 4, unit: 'px' },
    bracketPolicy: 'observed-adjacent-anchors-only',
    residualUnit: 'bp-log10'
  };
}

export function parametersV11(): CalibrationParametersV1 {
  return {
    ...parametersV1(),
    version: '1.1',
    saturationThreshold: { value: 248, unit: 'graylevel-8' },
    minimumSeparation: { value: 14, unit: 'px' },
    maximumExtrapolation: { value: 0, unit: 'px' }
  };
}

export function parameterHash(parameters: CalibrationParametersV1): string {
  return stableId('params', parameters);
}
