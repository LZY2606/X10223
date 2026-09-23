import type { LadderNominalBand, MWUnit, Quantity } from './types.js';
import { diagnostic } from './diagnostics.js';
import type { Diagnostic } from './types.js';

/**
 * 解析 ladder 标称值文本。导入时保留原始表示；无法转换的值留在原位置并附诊断，
 * 绝不丢弃，也不伪造默认值。
 * 每行形如："1500 bp"、"1.5 kb"、"500"、"bad value"。
 */
export interface ParsedLadder {
  unit: MWUnit;
  bands: LadderNominalBand[];
  unconvertible: { ordinal: number; raw: string; diagnostic: Diagnostic }[];
  diagnostics: Diagnostic[];
}

export function parseLadderRawText(raw: string, unit: MWUnit, specId: string): ParsedLadder {
  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('#'));
  const bands: LadderNominalBand[] = [];
  const unconvertible: ParsedLadder['unconvertible'] = [];
  const diagnostics: Diagnostic[] = [];
  lines.forEach((line, i) => {
    const ordinal = i + 1;
    const q = parseMolecularWeight(line, unit);
    if (q) {
      bands.push({ ordinal, molecularWeight: { value: q.value, unit: unit }, rawRepresentation: line });
    } else {
      const d = diagnostic(
        'UNCONVERTIBLE_VALUE',
        'warning',
        `第 ${ordinal} 行标称值无法转换为 ${unit}：“${line}” 保留在原位置`,
        { materialId: specId, path: `bands[${ordinal - 1}]` },
      );
      unconvertible.push({ ordinal, raw: line, diagnostic: d });
      diagnostics.push(d);
    }
  });
  return { unit, bands, unconvertible, diagnostics };
}

/** 解析分子量文本；kb/kDa 等前缀会规范化，但原始文本由调用方保留。 */
export function parseMolecularWeight(raw: string, targetUnit: MWUnit): Quantity | null {
  const m = raw.match(/^([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)\s*([a-zA-Z]*)$/);
  if (!m) return null;
  const num = Number(m[1]);
  if (!Number.isFinite(num) || num <= 0) return null;
  const suffix = m[2].toLowerCase();
  if (targetUnit === 'bp') {
    if (suffix === 'bp' || suffix === '') return { value: num, unit: 'bp', rawRepresentation: raw };
    if (suffix === 'kbp' || suffix === 'kb') return { value: num * 1000, unit: 'bp', rawRepresentation: raw };
    return null;
  }
  if (suffix === 'kda' || suffix === '') return { value: num, unit: 'kDa', rawRepresentation: raw };
  if (suffix === 'da') return { value: num / 1000, unit: 'kDa', rawRepresentation: raw };
  return null;
}

/** 带单位的量纲检查；单位不匹配返回诊断而不是隐式换算。 */
export function requireUnit(q: Quantity, unit: string, location: Diagnostic['location']): Diagnostic[] {
  if (q.unit !== unit) {
    return [diagnostic('UNCONVERTIBLE_VALUE', 'error', `单位 ${q.unit} 与期望 ${unit} 不兼容`, location)];
  }
  return [];
}
