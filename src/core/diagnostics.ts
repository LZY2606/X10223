import type { Diagnostic, PixelPoint } from './types.js';

export function diag(
  code: string,
  severity: Diagnostic['severity'],
  message: string,
  at?: Diagnostic['at'],
): Diagnostic {
  return { code, severity, message, ...(at ? { at } : {}) };
}

export function pixelAt(point: PixelPoint, ids?: string[]): NonNullable<Diagnostic['at']> {
  return { kind: 'pixel', point, ...(ids ? { ids } : {}) };
}
