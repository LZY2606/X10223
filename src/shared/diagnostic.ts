/** 诊断与结果类型：所有失败必须带位置与严重级别，禁止用空值伪装成功。 */

export type Severity = 'error' | 'warning' | 'info';

export interface DiagnosticPosition {
  /** 在源表示中的字符/记录偏移（导入解析时） */
  index?: number;
  line?: number;
  column?: number;
  /** 在图像中的像素位置（领域对象定位时），始终为 image 坐标系 */
  pixel?: { x: number; y: number };
  /** 关联对象身份，便于从诊断跳回材料 */
  objectId?: string;
}

export interface Diagnostic {
  severity: Severity;
  code: string;
  message: string;
  /** 结构化路径，如 materials[3].fragments[2].size */
  path: string;
  position?: DiagnosticPosition;
}

/** 三类必须区分的终结结果 + 输入不合法 */
export type FailureKind =
  | 'invalid-input'        // 输入不完整/不合法（带位置诊断）
  | 'format-corrupt'       // 格式损坏（字节级/结构级）
  | 'resource-budget'      // 资源预算耗尽
  | 'semantic-unresolvable'; // 语义无解（如非单调标尺段、有效区间外）

export type Outcome<T> =
  | { ok: true; value: T; warnings: Diagnostic[] }
  | { ok: false; kind: FailureKind; diagnostics: Diagnostic[] };

export function ok<T>(value: T, warnings: Diagnostic[] = []): Outcome<T> {
  return { ok: true, value, warnings };
}

export function fail<T>(kind: FailureKind, diagnostics: Diagnostic[]): Outcome<T> {
  return { ok: false, kind, diagnostics };
}

export function diag(
  severity: Severity,
  code: string,
  message: string,
  path: string,
  position?: DiagnosticPosition,
): Diagnostic {
  return { severity, code, message, path, ...(position ? { position } : {}) };
}
