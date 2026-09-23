import type { Diagnostic, DiagnosticCode } from './types.js';

export function diagnostic(
  code: DiagnosticCode,
  severity: Diagnostic['severity'],
  message: string,
  location: Diagnostic['location'] = {},
): Diagnostic {
  return { code, severity, message, location };
}
