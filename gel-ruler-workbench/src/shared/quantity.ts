import type { Diagnostic, MWUnit, RawQuantity } from './types.js';

/**
 * 导入时保留原始表示，派生层才做规范化。
 * 无法转换的值留在原位置并附诊断，绝不为了画图而丢掉。
 */
export function parseQuantity(raw: string, expectedUnit: MWUnit, location: string): RawQuantity {
  const diagnoses: Diagnostic[] = [];
  const trimmed = raw.trim();
  const m = trimmed.match(/^([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)\s*(bp|kBp|kbp|kb|kDa|Da)?$/i);
  if (!m) {
    diagnoses.push({
      code: 'QTY_UNPARSEABLE',
      severity: 'error',
      message: `无法把 "${raw}" 转换为数值（${expectedUnit}）；原始值保留在原位置`,
      location
    });
    return { raw, unit: expectedUnit, value: null, diagnoses };
  }
  let value = Number(m[1]);
  const suffix = (m[2] ?? '').toLowerCase();
  if (expectedUnit === 'bp') {
    if (suffix === 'kb' || suffix === 'kbp') value *= 1000;
    else if (suffix === 'kda' || suffix === 'da') {
      diagnoses.push({
        code: 'QTY_UNIT_MISMATCH',
        severity: 'error',
        message: `"${raw}" 使用蛋白单位，但 ladder 声明为 bp`,
        location
      });
      return { raw, unit: expectedUnit, value: null, diagnoses };
    }
  } else if (expectedUnit === 'kDa') {
    if (suffix === 'da') value /= 1000;
    else if (suffix === 'bp' || suffix === 'kb' || suffix === 'kbp') {
      diagnoses.push({
        code: 'QTY_UNIT_MISMATCH',
        severity: 'error',
        message: `"${raw}" 使用核酸单位，但 ladder 声明为 kDa`,
        location
      });
      return { raw, unit: expectedUnit, value: null, diagnoses };
    }
  }
  if (!(value > 0)) {
    diagnoses.push({
      code: 'QTY_NONPOSITIVE',
      severity: 'error',
      message: `"${raw}" 规范化后不是正数`,
      location
    });
    return { raw, unit: expectedUnit, value: null, diagnoses };
  }
  return { raw, unit: expectedUnit, value, diagnoses };
}

export function parseExposure(raw: string): {
  raw: string;
  seconds: number | null;
  saturated: boolean | null;
  diagnoses: Diagnostic[];
} {
  const diagnoses: Diagnostic[] = [];
  const t = raw.trim();
  if (t === '' || t.toLowerCase() === 'unknown') {
    diagnoses.push({
      code: 'EXP_UNKNOWN',
      severity: 'warning',
      message: '曝光时间缺失；保留原始表示，不使用默认值',
      location: 'exposure'
    });
    return { raw, seconds: null, saturated: null, diagnoses };
  }
  const m = t.match(/^([\d.]+)\s*(ms|s|sec)?$/i);
  if (!m) {
    diagnoses.push({
      code: 'EXP_UNPARSEABLE',
      severity: 'warning',
      message: `曝光时间 "${raw}" 无法解析；原始值保留`,
      location: 'exposure'
    });
    return { raw, seconds: null, saturated: null, diagnoses };
  }
  let seconds = Number(m[1]);
  const u = (m[2] ?? 's').toLowerCase();
  if (u === 'ms') seconds /= 1000;
  return { raw, seconds, saturated: null, diagnoses };
}
