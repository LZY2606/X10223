// 三类失败必须可区分：资源预算耗尽 / 格式损坏 / 语义无解。
export type DiagClass =
  | 'RESOURCE_EXHAUSTED'
  | 'FORMAT_CORRUPT'
  | 'SEMANTIC_UNRESOLVABLE';

export type Severity = 'error' | 'warning' | 'info';

/** 带位置的诊断。位置始终指向某个材料/分支内的像素或字段路径。 */
export interface Diagnostic {
  code: string;
  class: DiagClass;
  severity: Severity;
  message: string;
  at: Location[];
}

export interface Location {
  branch?: string;
  material?: string; // 材料稳定身份
  field?: string; // 字段路径，例如 lanes[2].centerline[4].y
  pixel?: { x: number; y: number; frame: string };
  event?: string;
}

export function diag(
  code: string,
  cls: DiagClass,
  message: string,
  at: Location[] = [],
  severity: Severity = 'error'
): Diagnostic {
  return { code, class: cls, severity, message, at };
}

export class DiagError extends Error {
  readonly diagnostics: Diagnostic[];
  constructor(d: Diagnostic[]) {
    super(d.map((x) => `${x.code}: ${x.message}`).join('; '));
    this.diagnostics = d;
  }
}
