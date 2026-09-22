import type { ComputeResult, DerivedRow, GelEvent, Material } from '../shared/types.js';
import { canonical, sha256 } from './util.js';
import { fail, ok } from './calibration.js';
import type { Diagnostic } from '../shared/types.js';

export interface ArchiveBlob { material_id: string; data_base64: string }

export interface GelArchive {
  format: 'gel-evidence-archive/1';
  exported_seq: number;
  materials: { id: string; kind: string; seq: number; json: Material }[];
  events: GelEvent[];
  derived: (DerivedRow & { json: unknown })[];
  blobs: ArchiveBlob[];
  manifest: { sections: Record<string, string>; sha256: string };
}

export interface ArchiveSections {
  exported_seq: number;
  materials: GelArchive['materials'];
  events: GelEvent[];
  derived: GelArchive['derived'];
  blobs: ArchiveBlob[];
}

export function buildArchive(sections: ArchiveSections): GelArchive {
  const sectionDigests: Record<string, string> = {};
  for (const [k, v] of Object.entries(sections)) sectionDigests[k] = sha256(canonical(v));
  const manifest = {
    sections: sectionDigests,
    sha256: sha256(canonical(sectionDigests)),
  };
  return { format: 'gel-evidence-archive/1', ...sections, manifest };
}

export const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;

/**
 * 解析并校验档案。三种失败必须可区分：
 * 资源预算耗尽 / 格式损坏 / 语义无解。
 */
export function parseArchive(raw: Uint8Array, maxBytes = MAX_ARCHIVE_BYTES): ComputeResult<GelArchive> {
  const diagnostics: Diagnostic[] = [];
  if (raw.byteLength > maxBytes) {
    return fail('resource_exhausted', [{ code: 'archive-too-large', message: `档案 ${raw.byteLength}B 超出预算 ${maxBytes}B` }]);
  }
  let parsed: GelArchive;
  try {
    parsed = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return fail('corrupt_format', [{ code: 'bad-json', message: '档案不是合法 JSON（可能被截断或半写）' }]);
  }
  if (parsed.format !== 'gel-evidence-archive/1' || !parsed.manifest?.sections) {
    return fail('corrupt_format', [{ code: 'bad-envelope', message: '档案缺少 format/manifest 头' }]);
  }
  const sections: ArchiveSections = {
    exported_seq: parsed.exported_seq,
    materials: parsed.materials,
    events: parsed.events,
    derived: parsed.derived,
    blobs: parsed.blobs,
  };
  for (const [k, v] of Object.entries(sections)) {
    const digest = sha256(canonical(v));
    if (parsed.manifest.sections[k] !== digest) {
      return fail('corrupt_format', [{ code: 'manifest-mismatch', message: `节 ${k} 校验和不匹配` }]);
    }
  }
  // 语义校验：事件序号连续、父引用存在、材料 id 唯一
  const ids = new Set<string>();
  for (const m of parsed.materials) {
    if (ids.has(m.id)) return fail('semantic_unsolvable', [{ code: 'duplicate-id', message: `材料 id 重复：${m.id}` }]);
    ids.add(m.id);
  }
  for (const d of parsed.derived) ids.add(d.id);
  for (let i = 0; i < parsed.events.length; i++) {
    const e = parsed.events[i];
    if (e.seq !== i + 1) {
      return fail('semantic_unsolvable', [{ code: 'seq-gap', message: `事件序号在 ${e.seq} 处不连续` }]);
    }
    for (const p of e.parents ?? []) {
      if (!ids.has(p) && !parsed.events.some((x) => x.id === p)) {
        diagnostics.push({ code: 'dangling-parent', message: `事件 ${e.id} 的父引用 ${p} 不在档案中` });
      }
    }
    ids.add(e.id);
  }
  return ok(parsed, diagnostics);
}
