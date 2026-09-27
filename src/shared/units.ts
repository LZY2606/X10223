import type { Diag, ExposureInfo, Q, UnitSystem } from './types.js';

// 派生层才做规范化；无法转换的值留在原位置并附诊断，不能为画图而丢值

const BP_FACTORS: Record<string, number> = { bp: 1, bps: 1, kbp: 1000, mbp: 1_000_000 };
const MW_FACTORS: Record<string, number> = { da: 1, kda: 1000, md: 1_000_000 };

/** 解析原始标称值文本，保留原始表示；无法转换时 value=null 并保留诊断 */
export function parseQuantity(rawText: string, system: UnitSystem, at?: Diag['at']): Q {
  const text = rawText.trim();
  const m = text.match(/^([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)\s*([a-zA-Z/μµ.]+)$/);
  const diag: Diag | undefined = undefined;
  if (!m) {
    return {
      text,
      unit: text,
      value: null,
      normUnit: null,
      diagnostic: {
        code: 'quantity-unparseable',
        severity: 'error',
        message: `无法把“${text}”解析为带单位的领域量，原值保留在原位置`,
        at,
        rule: 'Q-001',
      },
    };
  }
  const num = Number(m[1]);
  const rawUnit = m[2].toLowerCase().replace('μ', 'u').replace('µ', 'u');
  const normUnit = system === 'bp' ? 'bp' : 'Da';
  const factors = system === 'bp' ? BP_FACTORS : MW_FACTORS;
  const factor = factors[rawUnit];
  if (factor === undefined) {
    return {
      text,
      unit: m[2],
      value: null,
      normUnit: null,
      diagnostic: {
        code: 'quantity-unit-unknown',
        severity: 'error',
        message: `单位“${m[2]}”不在 ${system === 'bp' ? 'bp/kbp/mbp' : 'Da/kDa/MDa'} 中，原值保留`,
        at,
        rule: 'Q-002',
      },
    };
  }
  if (!Number.isFinite(num)) {
    return { text, unit: m[2], value: null, normUnit: null, diagnostic: { code: 'quantity-nan', severity: 'error', message: '数值非有限值', at, rule: 'Q-003' } };
  }
  return { text, unit: m[2], value: num * factor, normUnit, diagnostic: diag };
}

export function makeQuantity(value: number, normUnit: 'bp' | 'Da'): Q {
  return { text: `${value} ${normUnit}`, unit: normUnit, value, normUnit };
}

/** 曝光时间解析为毫秒；“自动/未知”等保留原始表示，不伪装成默认值 */
export function parseExposure(rawText: string): ExposureInfo {
  const text = rawText.trim();
  let ms: number | null = null;
  let unit: ExposureInfo['unit'] = 'unknown';
  let convertible = false;
  let diagnostic: Diag | undefined;

  const num = (s: string) => Number(s);
  const mMs = text.match(/^([\d.]+)\s*ms$/i);
  const mS = text.match(/^([\d.]+)\s*s$/i);
  const mFrac = text.match(/^1\/(\d+)\s*s$/i);

  if (mMs) {
    ms = num(mMs[1]); unit = 'ms'; convertible = true;
  } else if (mFrac) {
    ms = 1000 / num(mFrac[1]); unit = 'fraction-s'; convertible = true;
  } else if (mS) {
    ms = num(mS[1]) * 1000; unit = 's'; convertible = true;
  } else {
    diagnostic = {
      code: 'exposure-unconvertible',
      severity: 'warning',
      message: `曝光“${text}”无法规范化为毫秒，保留原始表示（不使用默认值）`,
      rule: 'EXP-001',
    };
  }
  if (convertible && (!Number.isFinite(ms as number) || (ms as number) <= 0)) {
    ms = null; convertible = false; unit = 'unknown';
    diagnostic = { code: 'exposure-invalid', severity: 'error', message: `曝光“${text}”不是正数`, rule: 'EXP-002' };
  }
  return { rawText: text, ms, unit, convertible, diagnostic };
}
