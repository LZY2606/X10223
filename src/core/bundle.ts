import { writeFileSync, renameSync } from 'node:fs'
import { canonical, sha256Hex } from '../shared/identity'
import type { AnyEvent, Artifact } from './events'
import { DomainFailure } from '../shared/types'

export const BUNDLE_FORMAT = 'gel-workbench-bundle'
export const BUNDLE_VERSION = 1

export interface BundleBlob {
  blobId: string
  sha256: string
  byteLength: number
  /** base64 原始 PNG；原始表示原样保留。 */
  b64: string
}

export interface Bundle {
  format: typeof BUNDLE_FORMAT
  bundleVersion: number
  exportedAt: string
  project: { projectId: string; name: string; createdAt: string; headBranch: string }
  branches: { branchId: string; parentBranch: string | null; forkedFromEvent: string | null; label: string; createdAt: string }[]
  events: AnyEvent[]
  artifacts: (Artifact & { valid: boolean; supersededBy: string | null; producedByEvent: string; branchId: string })[]
  blobs: BundleBlob[]
}

export interface BundleSha {
  bundleSha: string
  eventShas: Record<string, string>
  artifactShas: Record<string, string>
}

export function bundleSha(bundle: Bundle): BundleSha {
  const eventShas: Record<string, string> = {}
  for (const e of bundle.events) eventShas[e.eventId] = sha256Hex(canonical(e))
  const artifactShas: Record<string, string> = {}
  for (const a of bundle.artifacts) artifactShas[a.artifactId] = sha256Hex(canonical(a))
  const bundleSha = sha256Hex(
    canonical({
      format: bundle.format,
      project: bundle.project,
      eventShas: Object.entries(eventShas).sort(),
      artifactShas: Object.entries(artifactShas).sort(),
      blobs: bundle.blobs.map((b) => [b.blobId, b.sha256]).sort()
    })
  )
  return { bundleSha, eventShas, artifactShas }
}

/** 原子写：先写 .tmp 再 rename，避免半写文件被当作成功导出。 */
export function writeBundleAtomic(path: string, bundle: Bundle): { bundleSha: string } {
  const text = JSON.stringify(bundle, null, 2)
  writeFileSync(path + '.tmp', text, 'utf8')
  renameSync(path + '.tmp', path)
  return { bundleSha: bundleSha(bundle).bundleSha }
}

export function parseBundle(text: string): Bundle {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch (e) {
    throw new DomainFailure('corrupt_format', '归档不是合法 JSON（格式损坏）', [
      { code: 'bundle_bad_json', severity: 'error', message: (e as Error).message }
    ])
  }
  const b = data as Partial<Bundle>
  if (!b || b.format !== BUNDLE_FORMAT || typeof b.bundleVersion !== 'number') {
    throw new DomainFailure('corrupt_format', '归档格式标识缺失或错误', [
      { code: 'bundle_bad_format', severity: 'error', message: `format=${String((b as { format?: unknown })?.format)}` }
    ])
  }
  if (!Array.isArray(b.events) || !b.project?.projectId) {
    throw new DomainFailure('corrupt_format', '归档缺少 events 或 project', [
      { code: 'bundle_incomplete', severity: 'error', message: '结构不完整' }
    ])
  }
  return b as Bundle
}

/** 语义校验：格式能解析但内容自相矛盾 -> semantic_impasse（区别于格式损坏）。 */
export function validateBundleSemantics(bundle: Bundle): void {
  const problems: string[] = []
  const ids = new Map<string, AnyEvent>()
  for (const e of bundle.events) {
    if (ids.has(e.eventId)) problems.push(`重复事件 ${e.eventId}`)
    ids.set(e.eventId, e)
  }
  for (const e of bundle.events) {
    if (e.parentId && !ids.has(e.parentId)) problems.push(`事件 ${e.eventId} 的父事件 ${e.parentId} 缺失`)
  }
  const byBranch = new Map<string, AnyEvent[]>()
  for (const e of bundle.events) {
    const arr = byBranch.get(e.branchId) ?? []
    arr.push(e)
    byBranch.set(e.branchId, arr)
  }
  for (const [branch, evs] of byBranch) {
    evs.sort((a, b) => a.seq - b.seq)
    evs.forEach((e, i) => {
      if (e.seq !== i) problems.push(`分支 ${branch} 序号不连续（事件 ${e.eventId} seq=${e.seq}）`)
    })
  }
  const branchIds = new Set(bundle.branches.map((x) => x.branchId))
  for (const e of bundle.events) if (!branchIds.has(e.branchId)) problems.push(`事件 ${e.eventId} 引用未知分支 ${e.branchId}`)
  if (problems.length) {
    throw new DomainFailure('semantic_impasse', '归档语义无解：事件/分支关系自相矛盾', problems.map((m) => ({ code: 'bundle_semantic', severity: 'error' as const, message: m })))
  }
}
