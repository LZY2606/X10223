// 输入校验：不完整输入返回带 JSON Pointer 位置的诊断，绝不用空值/默认值伪装成功。
import { D, diag } from './diagnostics.js';
import type { Diagnostic, Unit } from './types.js';

export interface PathCursor {
  path: string;
  push(segment: string | number): PathCursor;
}

export function cursor(path = ''): PathCursor {
  return {
    path,
    push(segment) {
      const next =
        typeof segment === 'number'
          ? `${path}[${segment}]`
          : path === ''
            ? segment
            : `${path}.${segment}`;
      return cursor(next);
    },
  };
}

export function requireObject(
  value: unknown,
  c: PathCursor,
  out: Diagnostic[],
): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    out.push(diag(D.FORMAT_BAD_TYPE, 'error', `期望对象 (object)，实际为 ${typeName(value)}`, c.path));
    return false;
  }
  return true;
}

export function requireField(
  obj: Record<string, unknown>,
  field: string,
  c: PathCursor,
  out: Diagnostic[],
): unknown {
  if (!Object.prototype.hasOwnProperty.call(obj, field) || obj[field] === null) {
    out.push(diag(D.FORMAT_MISSING_FIELD, 'error', `缺少必填字段 "${field}"`, c.push(field).path));
    return undefined;
  }
  return obj[field];
}

export function asNumber(
  value: unknown,
  c: PathCursor,
  out: Diagnostic[],
  opts: { finite?: boolean; positive?: boolean } = {},
): number | undefined {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    out.push(diag(D.FORMAT_BAD_TYPE, 'error', `期望数字，实际为 ${typeName(value)}`, c.path));
    return undefined;
  }
  if (opts.finite && !Number.isFinite(value)) {
    out.push(diag(D.FORMAT_BAD_TYPE, 'error', '数字必须有限', c.path));
    return undefined;
  }
  if (opts.positive && value <= 0) {
    out.push(diag(D.FORMAT_BAD_TYPE, 'error', '数字必须为正', c.path));
    return undefined;
  }
  return value;
}

export function asString(
  value: unknown,
  c: PathCursor,
  out: Diagnostic[],
): string | undefined {
  if (typeof value !== 'string') {
    out.push(diag(D.FORMAT_BAD_TYPE, 'error', `期望字符串，实际为 ${typeName(value)}`, c.path));
    return undefined;
  }
  return value;
}

const KNOWN_UNITS: ReadonlySet<string> = new Set<Unit>([
  'bp',
  'kDa',
  'pixel',
  'degree',
  'second',
  'graylevel',
  'fraction',
  'index',
]);

export function asUnit(value: unknown, c: PathCursor, out: Diagnostic[]): Unit | undefined {
  if (typeof value !== 'string' || !KNOWN_UNITS.has(value)) {
    out.push(diag(D.FORMAT_BAD_UNIT, 'error', `未知或不兼容单位: ${String(value)}`, c.path));
    return undefined;
  }
  return value as Unit;
}

function typeName(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}
