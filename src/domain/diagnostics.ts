/** 诊断：输入不完整/异常时返回带位置的诊断，绝不用空值或默认值伪装成功。 */
export type DiagCode =
  | 'MISSING_INPUT'            // 输入缺失
  | 'UNCONVERTIBLE_VALUE'      // 值无法转换，留在原位置
  | 'OUT_OF_VALID_REGION'      // 超出局部标尺有效区域
  | 'NON_MONOTONIC_RULER'      // 非单调标尺
  | 'LADDER_BAND_MISSING'      // ladder 缺带
  | 'SATURATED_REGION'         // 饱和区
  | 'OVERLAPPING_BANDS'        // 条带重叠
  | 'SMEARED_BAND'             // 拖尾
  | 'BUDGET_EXHAUSTED'         // 资源预算耗尽
  | 'FORMAT_CORRUPT'           // 格式损坏
  | 'SEMANTIC_UNSOLVABLE';     // 语义无解

export interface Diagnostic {
  code: DiagCode;
  path: string;   // 位置，如 "materials[3].content.nominal[5]" 或 "lane:L2/band:B7"
  message: string;
}

export function diag(code: DiagCode, path: string, message: string): Diagnostic {
  return { code, path, message };
}

/** 三种必须互相区分的失败结果。 */
export type FailureKind = 'BUDGET_EXHAUSTED' | 'FORMAT_CORRUPT' | 'SEMANTIC_UNSOLVABLE';

export class DomainFailure extends Error {
  constructor(
    public readonly kind: FailureKind,
    public readonly diagnostics: Diagnostic[],
  ) {
    super(`${kind}: ${diagnostics.map((d) => `${d.path}: ${d.message}`).join('; ')}`);
    this.name = 'DomainFailure';
  }
}
