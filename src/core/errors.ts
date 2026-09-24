/**
 * 三类必须彼此不同的结果：
 *  - FORMAT_CORRUPT   格式损坏（字节/容器层无法解析）
 *  - BUDGET_EXHAUSTED 资源预算耗尽（输入可解析，但计算未在预算内完成）
 *  - NO_SOLUTION      语义无解（如非单调标尺，领域规则无法给出合法值）
 * 输入不完整使用 INCOMPLETE_INPUT 诊断（带位置），绝不以空值/默认值伪装成功。
 */
export type GelErrorCode =
  | 'FORMAT_CORRUPT'
  | 'BUDGET_EXHAUSTED'
  | 'NO_SOLUTION'
  | 'INCOMPLETE_INPUT'
  | 'STALE_COORDINATE_BASIS'
  | 'MISSING_LADDER_BAND'
  | 'NONMONOTONIC_SCALE'
  | 'OUTSIDE_VALID_RANGE'
  | 'SATURATED_BAND'
  | 'SMEARED_BAND'
  | 'OVERLAPPING_BANDS'
  | 'EXTENDED_SEGMENT'
  | 'CONFLICTING_DECISIONS';

export class GelError extends Error {
  constructor(
    public readonly code: GelErrorCode,
    message: string,
    public readonly position?: DiagnosticPosition,
  ) {
    super(message);
    this.name = 'GelError';
  }
}

export interface DiagnosticPosition {
  kind: 'image' | 'lane' | 'band' | 'ladder_band' | 'segment' | 'parameter' | 'project';
  id?: string;
  x?: number; // 像素坐标（保留原始像素基准）
  y?: number;
  imageId?: string;
}
