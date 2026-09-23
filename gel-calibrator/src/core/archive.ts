// Project export/import envelope. Self-contained JSON, per-record checksum.
// Import validates the manifest BEFORE touching any row (torn/corrupt files
// fail as FORMAT_CORRUPT, distinct from budget / semantic errors).
import { GelEvent } from './types.js';
import { canonicalJSON, sha256Hex } from './ids.js';
import { corrupt } from './types.js';

export interface ExportEnvelope {
  format: 'gel-case/v1';
  exportedAt: string;
  project: { projectId: string; name: string; createdAt: string; caseKind: string };
  branches: Array<{ branch: string; parentBranch: string | null; forkEvent: string | null }>;
  records: Array<GelEvent & { checksum: string }>;
  manifest: { count: number; orderHash: string; totalChecksum: string };
}

export function buildEnvelope(
  project: { projectId: string; name: string; createdAt: string; caseKind: string },
  branches: Array<{ branch: string; parentBranch: string | null; forkEvent: string | null }>,
  events: GelEvent[],
  exportedAt: string,
): ExportEnvelope {
  const ordered = [...events].sort(
    (a, b) => a.branch.localeCompare(b.branch) || a.seq - b.seq || a.id.localeCompare(b.id),
  );
  const records = ordered.map((e) => ({ ...e, checksum: sha256Hex(canonicalJSON(e)) }));
  const orderHash = sha256Hex(records.map((r) => r.checksum).join('|'));
  return {
    format: 'gel-case/v1', exportedAt, project, branches, records,
    manifest: { count: records.length, orderHash, totalChecksum: sha256Hex(canonicalJSON(records)) },
  };
}

export function validateEnvelope(raw: string): ExportEnvelope {
  let env: ExportEnvelope;
  try {
    env = JSON.parse(raw) as ExportEnvelope;
  } catch (e) {
    throw corrupt('envelope', `unparseable export: ${(e as Error).message}`);
  }
  if (!env || env.format !== 'gel-case/v1') throw corrupt('envelope.format', 'not a gel-case/v1 file');
  if (!env.manifest) throw corrupt('envelope.manifest', 'missing manifest');
  if (env.records.length !== env.manifest.count) {
    throw corrupt('envelope.manifest.count', `record count ${env.records.length} != manifest ${env.manifest.count} (torn write)`);
  }
  for (let i = 0; i < env.records.length; i++) {
    const { checksum, ...ev } = env.records[i]!;
    if (sha256Hex(canonicalJSON(ev)) !== checksum) {
      throw corrupt(`envelope.records[${i}]`, 'record checksum mismatch (torn/corrupt write)');
    }
  }
  const orderHash = sha256Hex(env.records.map((r) => r.checksum).join('|'));
  if (orderHash !== env.manifest.orderHash) throw corrupt('envelope.manifest.orderHash', 'order hash mismatch');
  if (sha256Hex(canonicalJSON(env.records)) !== env.manifest.totalChecksum) {
    throw corrupt('envelope.manifest.totalChecksum', 'total checksum mismatch');
  }
  return env;
}
