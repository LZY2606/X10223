import type { Diagnostic, Quantity, Result } from './types';

/** 原始表示：导入时原样保留，派生层才做规范化。 */
export interface RawValue {
  raw: string | number | null;
}

export interface Normalized<U extends string> {
  quantity: Quantity<U>;
  raw: string | number | null;
}

const BP_UNITS: Record<string, number> = {
  bp: 1,
  kb: 1000,
  kbp: 1000,
};

/** 把 "10 kb" / 10000 / "500 bp" 规范化为 bp。无法转换时返回带位置的诊断。 */
export function normalizeBp(raw: string | number | null, path: string): Result<Normalized<'bp'>> {
  if (raw === null || raw === undefined || raw === '') {
    return { ok: false, diagnostics: [{ code: 'MISSING_VALUE', message: '标称值缺失', path, severity: 'error' }] };
  }
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw) || raw <= 0) {
      return { ok: false, diagnostics: [{ code: 'BAD_VALUE', message: `非法标称值 ${raw}`, path, severity: 'error' }] };
    }
    return { ok: true, value: { quantity: { value: raw, unit: 'bp' }, raw } };
  }
  const m = raw.trim().match(/^([0-9]*\.?[0-9]+)\s*(bp|kb|kbp)$/i);
  if (!m) {
    return { ok: false, diagnostics: [{ code: 'UNCONVERTIBLE_UNIT', message: `无法转换为 bp：${JSON.stringify(raw)}`, path, severity: 'error' }] };
  }
  const factor = BP_UNITS[m[2].toLowerCase()];
  return { ok: true, value: { quantity: { value: parseFloat(m[1]) * factor, unit: 'bp' }, raw } };
}

const TIME_UNITS: Record<string, number> = { s: 1, ms: 0.001 };

/** 曝光时间规范化为秒。 */
export function normalizeSeconds(raw: string | number | null, path: string): Result<Normalized<'s'>> {
  if (raw === null || raw === undefined || raw === '') {
    return { ok: false, diagnostics: [{ code: 'MISSING_VALUE', message: '曝光值缺失', path, severity: 'error' }] };
  }
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw) || raw < 0) {
      return { ok: false, diagnostics: [{ code: 'BAD_VALUE', message: `非法曝光值 ${raw}`, path, severity: 'error' }] };
    }
    return { ok: true, value: { quantity: { value: raw, unit: 's' }, raw } };
  }
  const m = raw.trim().match(/^([0-9]*\.?[0-9]+)\s*(ms|s)$/i);
  if (!m) {
    return { ok: false, diagnostics: [{ code: 'UNCONVERTIBLE_UNIT', message: `无法转换为秒：${JSON.stringify(raw)}`, path, severity: 'error' }] };
  }
  return { ok: true, value: { quantity: { value: parseFloat(m[1]) * TIME_UNITS[m[2].toLowerCase()], unit: 's' }, raw } };
}

/** 拍摄方向：保留原始字符串，映射到受控词表；未知值产生诊断并保留原位。 */
export function normalizeOrientation(raw: string | null, path: string): Result<'as-shot' | 'rotated-90' | 'rotated-180' | 'rotated-270'> {
  const table: Record<string, 'as-shot' | 'rotated-90' | 'rotated-180' | 'rotated-270'> = {
    'portrait, wells at top': 'as-shot',
    'as-shot': 'as-shot',
    'rotated 90 cw': 'rotated-90',
    'rotated-90': 'rotated-90',
    'rotated 180': 'rotated-180',
    'rotated-180': 'rotated-180',
    'rotated 90 ccw': 'rotated-270',
    'rotated-270': 'rotated-270',
  };
  const key = (raw ?? '').trim().toLowerCase();
  if (key in table) return { ok: true, value: table[key] };
  return { ok: false, diagnostics: [{ code: 'UNKNOWN_ORIENTATION', message: `未知拍摄方向：${JSON.stringify(raw)}`, path, severity: 'error' }] };
}

export function diagnosticsOf(results: Result<unknown>[]): Diagnostic[] {
  return results.flatMap((r) => (r.ok ? [] : r.diagnostics));
}
