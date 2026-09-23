import { createHash } from 'node:crypto'
import type { Basis, BasisKind, Quantity, Unit } from './types'

/** 规范化 JSON：键排序、无空白。等价输入产生稳定身份与稳定顺序。 */
export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null)
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonical(obj[k])).join(',') + '}'
}

export function sha256Hex(input: string | Uint8Array): string {
  return createHash('sha256').update(input as never).digest('hex')
}

export function contentId(prefix: string, body: unknown): string {
  return prefix + '_' + sha256Hex(canonical(body)).slice(0, 20)
}

let monotonic = 0
/** 决定事件是可变决定，身份由父分支+序号决定（稳定且可重放）。 */
export function decisionId(projectId: string, branchId: string, seq: number): string {
  void projectId
  return `dec_${branchId}_${String(seq).padStart(4, '0')}`
}

export function makeBasis(kind: BasisKind, unit: Unit, origin: string, note?: string): Basis {
  const basisId = contentId('basis', { kind, unit, origin, note })
  return { basisId, kind, unit, origin, note }
}

export function q(value: number, unit: Unit, raw?: string): Quantity {
  return raw === undefined ? { value, unit } : { value, unit, raw }
}

export function bumpCounter(): number {
  monotonic += 1
  return monotonic
}
