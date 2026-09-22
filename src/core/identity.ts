import type { GelEvent, Material } from '../shared/types';
import { canonicalJSON, digestOf, sha256Hex } from './digest';

/** 稳定身份：身份只取决于语义内容，与插入时间无关；等价输入得到稳定顺序 */

export function imageId(sha256: string, width: number, height: number, orientationDeg: number): string {
  return `img-${digestOf({ sha256: sha256.slice(0, 24), width, height, orientationDeg })}`;
}

export function blobUri(sha256: string): string {
  return `blob://${sha256}`;
}

export function laneId(ordinal: number): string {
  return `lane-${ordinal + 1}`;
}

/** 条带身份：lane + 该 lane 内弧长序（检测顺序稳定），跨图像版本保持 */
export function bandId(laneOrdinal: number, rankInLane: number): string {
  return `band-${laneOrdinal + 1}-${rankInLane + 1}`;
}

export function candidateId(inputDigest: string, laneOrdinal: number, rankInLane: number, paramVersion: string): string {
  return `mw-${digestOf({ inputDigest, laneOrdinal, rankInLane, paramVersion })}`;
}

export function materialId(material: Material): string {
  switch (material.kind) {
    case 'rawImage':
      return imageId(material.sha256, material.width, material.height, 0);
    case 'orientation':
      return `orientation-${digestOf({ up: material.upDegrees, by: material.declaredBy })}`;
    case 'exposure':
      return `exposure-${digestOf({ raw: material.rawText ?? '', fullScale: material.fullScale, fraction: material.saturationFraction })}`;
    case 'ladder':
      return material.ladderId;
    case 'laneBoundary':
      return material.laneId;
    case 'bandCenter':
      return material.bandId;
  }
}

export function eventDigest(
  branch: string,
  branchSeq: number,
  prevEventId: string | null,
  type: string,
  payload: unknown,
  logicalClock: number
): string {
  return digestOf({ branch, branchSeq, prevEventId, type, payload: canonicalJSON(payload), logicalClock });
}

export function makeEvent<T extends GelEvent['type']>(args: {
  seq: number;
  branch: string;
  branchSeq: number;
  prevEventId: string | null;
  type: T;
  payload: Extract<GelEvent, { type: T }>['payload'];
  logicalClock: number;
  wallTimeUtcIso: string;
}): GelEvent {
  const digest = eventDigest(
    args.branch,
    args.branchSeq,
    args.prevEventId,
    args.type,
    args.payload,
    args.logicalClock
  );
  return {
    eventId: `evt-${sha256Hex(`${args.branch}#${args.branchSeq}:${digest}`).slice(0, 16)}`,
    seq: args.seq,
    branch: args.branch,
    branchSeq: args.branchSeq,
    prevEventId: args.prevEventId,
    type: args.type,
    payload: args.payload,
    logicalClock: args.logicalClock,
    wallTimeUtcIso: args.wallTimeUtcIso,
    digest,
  };
}

/** 输入摘要：材料 + 参数版本，派生记录携带以声明输入 */
export function computeInputDigest(parts: unknown[]): string {
  return digestOf(parts.map((p) => canonicalJSON(p)));
}
