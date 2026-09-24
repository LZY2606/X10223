/**
 * 领域单位：核酸 bp、蛋白 kDa。
 * 导入保留原始表示（rawText/unit），仅在派生层规范化；无法转换的值留在原位并附诊断。
 */
import { diag, type Diagnostic } from './diagnostics';
import type { PhysicalQuantity } from './types';

const NUCLEIC_ALIASES = new Set(['bp', 'bps', 'base pair', 'base pairs', 'basepair', 'basepairs']);
const PROTEIN_ALIASES = new Set(['kda', 'kd', 'kdalton', 'kdaltons', 'kilo-dalton', 'kilodalton', 'kildaltons']);

export function makeQuantity(rawText: string, analyte: 'nucleic-acid' | 'protein'): {
  q: PhysicalQuantity;
  diagnostic?: Diagnostic;
} {
  const raw = rawText.trim();
  const m = raw.match(/^([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)\s*(.*)$/);
  if (!m) {
    return {
      q: { value: null, unit: raw, rawText: raw, canonicalUnit: undefined },
      diagnostic: diag('UNIT_UNCONVERTIBLE', '/ladderSpec/bands', `无法解析的标称值: ${raw}`)
    };
  }
  const value = Number(m[1]);
  const unit = (m[2] || '').trim();
  const aliases = analyte === 'nucleic-acid' ? NUCLEIC_ALIASES : PROTEIN_ALIASES;
  const canonical = analyte === 'nucleic-acid' ? 'bp' : 'kDa';
  if (!unit || !aliases.has(unit.toLowerCase())) {
    return {
      q: { value: null, unit: unit || '(unitless)', rawText: raw, canonicalUnit: undefined },
      diagnostic: diag('UNIT_UNCONVERTIBLE', '/ladderSpec/bands', `单位无法转换到 ${canonical}: ${raw}`)
    };
  }
  if (!Number.isFinite(value) || value <= 0) {
    return {
      q: { value: null, unit, rawText: raw, canonicalUnit: undefined },
      diagnostic: diag('UNIT_UNCONVERTIBLE', '/ladderSpec/bands', `标称值必须为正数: ${raw}`)
    };
  }
  return { q: { value, unit, rawText: raw, canonicalUnit: canonical } };
}

export function canonicalMassUnit(analyte: 'nucleic-acid' | 'protein'): string {
  return analyte === 'nucleic-acid' ? 'bp' : 'kDa';
}
