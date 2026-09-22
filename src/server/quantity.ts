import { diag } from '../shared/diagnostics.js';
import type { Diagnostic, Quantity } from '../shared/types.js';

/** 导入时保留原始表示；无法转换的值留在原位置并附诊断，不能丢掉 */
export function parseQuantity(raw: unknown, path: string, objectId: string, objectKind: string): { q: Quantity; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = [];
  if (typeof raw === 'number') {
    return {
      q: { value: raw, unit: 'bp', parsed: raw },
      diagnostics: [],
    };
  }
  if (typeof raw !== 'string') {
    diagnostics.push(diag('MISSING_REQUIRED_FIELD', 'error', `字段 ${path} 必须是数字或带单位字符串`, { objectId, objectKind, path }));
    return {
      q: { value: String(raw), unit: 'unknown', parsed: null, rawText: String(raw) },
      diagnostics,
    };
  }
  const text = raw.trim();
  const m = text.match(/^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)\s*([a-zA-Z%°]+)?$/);
  if (!m) {
    diagnostics.push(diag('UNPARSEABLE_UNIT', 'error', `无法解析带单位数值 "${text}"，原值保留在 ${path}`, { objectId, objectKind, path }));
    return { q: { value: text, unit: 'unknown', parsed: null, rawText: text }, diagnostics };
  }
  const num = Number(m[1]);
  const unitRaw = (m[2] ?? 'bp').toLowerCase();
  const unitAliases: Record<string, string> = { bp: 'bp', bps: 'bp', kbp: 'kbp', kb: 'kbp', da: 'Da', kda: 'kDa', k: 'kDa' };
  let parsed = num;
  let unit = unitRaw;
  if (unitRaw === 'kbp') {
    parsed = num * 1000;
    unit = 'bp';
  } else if (unitRaw === 'kda' || (unitRaw === 'k')) {
    parsed = num * 1000;
    unit = 'kDa';
  } else if (unitRaw === 'da') {
    unit = 'kDa';
    parsed = num / 1000;
  } else if (unitRaw === 'bp' || unitRaw === 'bps') {
    unit = 'bp';
  } else {
    diagnostics.push(diag('UNPARSEABLE_UNIT', 'error', `未知单位 "${unitRaw}"（字段 ${path}），原值保留`, { objectId, objectKind, path }));
    return { q: { value: text, unit: unitRaw, parsed: null, rawText: text }, diagnostics };
  }
  return { q: { value: text, unit, parsed, rawText: text }, diagnostics };
}

export function requirePoint(raw: unknown, path: string, objectId: string, objectKind: string): { p: { x: number; y: number } | null; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = [];
  if (!raw || typeof raw !== 'object' || typeof (raw as any).x !== 'number' || typeof (raw as any).y !== 'number') {
    diagnostics.push(diag('BAD_COORDINATE', 'error', `坐标 ${path} 必须是含数字 x/y 的对象`, { objectId, objectKind, path }));
    return { p: null, diagnostics };
  }
  const p = { x: (raw as any).x as number, y: (raw as any).y as number };
  if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) {
    diagnostics.push(diag('BAD_COORDINATE', 'error', `坐标 ${path} 含非有限数值`, { objectId, objectKind, path, pixel: p }));
    return { p: null, diagnostics };
  }
  return { p, diagnostics };
}
