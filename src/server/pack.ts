import { deflateSync, inflateSync } from 'node:zlib';
import { CorruptFormatError } from '../shared/diagnostic';
import { canonicalJson, sha256Hex } from '../shared/ids';
import { deserializeState, serializeState } from './projectService';
import type { ProjectState } from '../provenance/reducer';

/**
 * .gelpack 导出容器（离线、自包含）：
 *   magic 'GELPACK1'
 *   JSON manifest（含 sha256、参数/格式版本）
 *   gzip(canonical state JSON)
 * 导入后身份、顺序、分支、决定历史必须保持。
 */
const MAGIC = Buffer.from('GELPACK1\n', 'ascii');
export const PACK_FORMAT_VERSION = 'gelpack/1';

export interface PackManifest {
  formatVersion: string;
  projectId: string;
  createdAt: string;
  stateSha256: string;
  stateLength: number;
}

export function exportPack(state: ProjectState): Uint8Array {
  const stateJson = canonicalJson(JSON.parse(serializeState(state)));
  const payload = deflateSync(Buffer.from(stateJson, 'utf8'), { level: 9 });
  const manifest: PackManifest = {
    formatVersion: PACK_FORMAT_VERSION,
    projectId: state.projectId,
    createdAt: new Date().toISOString(),
    stateSha256: sha256Hex(Buffer.from(stateJson, 'utf8')),
    stateLength: stateJson.length,
  };
  const manifestBytes = Buffer.from(canonicalJson(manifest), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32BE(manifestBytes.length, 0);
  return Buffer.concat([MAGIC, header, manifestBytes, payload]);
}

export function readPackManifest(bytes: Uint8Array): PackManifest {
  const buf = Buffer.from(bytes);
  if (buf.subarray(0, MAGIC.length).toString('ascii') !== MAGIC.toString('ascii')) {
    throw new CorruptFormatError('不是 .gelpack 文件（magic 不匹配）');
  }
  const manifestLen = buf.readUInt32BE(MAGIC.length);
  if (MAGIC.length + 4 + manifestLen > buf.length) {
    throw new CorruptFormatError('.gelpack 被截断（manifest 不完整）');
  }
  try {
    return JSON.parse(buf.subarray(MAGIC.length + 4, MAGIC.length + 4 + manifestLen).toString('utf8'));
  } catch (e) {
    throw new CorruptFormatError('.gelpack manifest JSON 损坏', e);
  }
}

export function importPack(bytes: Uint8Array): { state: ProjectState; manifest: PackManifest } {
  const manifest = readPackManifest(bytes);
  if (manifest.formatVersion !== PACK_FORMAT_VERSION) {
    throw new CorruptFormatError(`不支持的包格式版本 ${manifest.formatVersion}`);
  }
  const manifestLen = Buffer.from(bytes).readUInt32BE(MAGIC.length);
  const payload = bytes.subarray(MAGIC.length + 4 + manifestLen);
  let stateJson: string;
  try {
    stateJson = inflateSync(Buffer.from(payload)).toString('utf8');
  } catch (e) {
    throw new CorruptFormatError('.gelpack 负载无法解压（半写/截断）', e);
  }
  if (sha256Hex(Buffer.from(stateJson, 'utf8')) !== manifest.stateSha256) {
    throw new CorruptFormatError('.gelpack 状态摘要不匹配（内容损坏）');
  }
  if (stateJson.length !== manifest.stateLength) {
    throw new CorruptFormatError('.gelpack 状态长度不匹配');
  }
  const state = deserializeState(stateJson, null as never, manifest.projectId);
  return { state, manifest };
}

