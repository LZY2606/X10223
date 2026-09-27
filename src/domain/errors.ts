import type { Diagnostic } from "./types.js";

export class DomainFailure extends Error {
  readonly result: "incomplete" | "budget" | "corrupt" | "semantic";
  readonly diagnostics: Diagnostic[];

  constructor(result: DomainFailure["result"], diagnostics: Diagnostic[]) {
    super(diagnostics[0]?.message ?? result);
    this.name = "DomainFailure";
    this.result = result;
    this.diagnostics = diagnostics;
  }
}

export function diagnostic(
  code: Diagnostic["code"],
  severity: Diagnostic["severity"],
  path: string,
  message: string,
  objectId?: string
): Diagnostic {
  return { code, severity, path, message, ...(objectId ? { objectId } : {}) };
}
