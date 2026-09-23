import { appendEvent, forkBranch } from './service.js';
import type { BuiltCase } from './caseFactory.js';
import { attachLadderRungs, buildGelCase, LADDER_MISSING_BP, resampledGeometry } from './caseFactory.js';
import type { Bundle } from '../shared/model.js';
import { digestOf, sha256Hex } from '../shared/ids.js';
import { corrupted, exhausted } from '../shared/errors.js';
import { decodePng, toGray } from './image.js';
import { replay } from './replay.js';
import { VARIANT_DEFS, buildVariantBranch } from './variants.js';

const CLOCK_ORIGIN = '2026-09-23T01:00:00Z';

function makeClock(): () => string {
  let counter = 0;
  return () => {
    counter++;
    const total = new Date(CLOCK_ORIGIN).getTime() + counter * 60_000;
    return new Date(total).toISOString();
  };
}

export interface CasePackArtifacts {
  bundle: Bundle;
  blobs: Map<string, Buffer>;
  built: BuiltCase;
  branchIds: Record<string, string>;
}

export function buildCasePack(): CasePackArtifacts {
  const built = buildGelCase();
  const clock = makeClock();
  const log = built.log;
  const main = 'br_main';
  const blobs = new Map<string, Buffer>([[built.blobId, built.png]]);
  const branchIds: Record<string, string> = { main };

  const projectCreated = log.events[0]!;
  appendImageAndMaterials(built, main, clock, { missingRung: null });
  const rungs = attachLadderRungs(built, main, { missingBp: null });
  appendEvent(
    { log, branch: main, actor: 'system', now: clock() },
    'decision-recorded',
    { target: { type: 'laneDetection', laneId: built.lanes[0]!.laneId }, kind: 'accept', note: '自动候选 ladder 泳道几何，采纳' },
    { deterministic: false },
  );
  appendEvent(
    { log, branch: main, actor: 'reviewer', now: clock() },
    'decision-recorded',
    {
      target: { type: 'bandDetection', bandId: firstSampleBand(built, 1) },
      kind: 'candidate',
      note: '自动候选保留：审阅人暂不采纳第一个样例条带，等待分子量复核',
    },
    { deterministic: false },
  );

  appendEvent(
    { log, branch: main, actor: 'reviewer', now: clock() },
    'parameter-revised',
    {
      revision: {
        name: 'overlapSeparationPx',
        oldValue: 14,
        newValue: 10,
        reason: '第一次参数修订：邻近条带需要更严格的重叠判定，只影响重叠候选的局部派生',
      },
    },
    { deterministic: false, inputSummary: { parameter: 'overlapSeparationPx', old: 14, new: 10 } },
  );

  const withheldRung = rungs.find((r) => r.nominalBp.value === 1500)!;
  appendEvent(
    { log, branch: main, actor: 'reviewer', now: clock() },
    'rung-withheld',
    { rungId: withheldRung.rungId, reason: '只影响局部依赖的源数据改动：复核发现 1500bp ladder 点污染，撤回关联' },
    { deterministic: false, inputSummary: { rungId: withheldRung.rungId } },
  );
  void LADDER_MISSING_BP;

  const conflictBand = firstSampleBand(built, 5);
  appendEvent(
    { log, branch: main, actor: 'reviewer', now: clock() },
    'decision-recorded',
    { target: { type: 'molecularWeight', bandId: conflictBand }, kind: 'accept', note: '互相冲突的人工决定 A：接受自动候选分子量' },
    { deterministic: false },
  );
  appendEvent(
    { log, branch: main, actor: 'reviewer', now: clock() },
    'decision-recorded',
    {
      target: { type: 'molecularWeight', bandId: conflictBand },
      kind: 'interval',
      note: '互相冲突的人工决定 B（后发生，当前视图生效；A 保留于历史可回看）：该条带只接受区间',
    },
    { deterministic: false },
  );

  for (const def of VARIANT_DEFS) {
    const { branchId } = buildVariantBranch(log, projectCreated.id, def, clock, (id, png) => blobs.set(id, png));
    branchIds[def.key] = branchId;
  }

  const bundle = toBundle(log, blobs);
  return { bundle, blobs, built, branchIds };
}

export function appendImageAndMaterials(
  built: BuiltCase,
  branch: string,
  clock: () => string,
  opts: { missingRung?: number | null } = {},
): void {
  const { log, png, blobId } = built;
  appendEvent(
    { log, branch, actor: 'system', now: clock() },
    'image-imported',
    {
      image: {
        blobId,
        mediaType: 'image/png',
        width: built.spec.width,
        height: built.spec.height,
        sha256: sha256Hex(png),
        bytes: png.length,
      },
      fileName: `gel-${branch}.png`,
    },
    { deterministic: false, inputSummary: { sha256: sha256Hex(png).slice(0, 16), bytes: png.length } },
  );
  appendEvent(
    { log, branch, actor: 'system', now: clock() },
    'capture-orientation-recorded',
    {
      orientation: { rotationCw: 0, flipped: false, wellSide: 'top', rawLabel: '拍摄方向=上样孔朝上；设备原始方向，无旋转' },
    },
    { deterministic: false },
  );
  appendEvent(
    { log, branch, actor: 'system', now: clock() },
    'exposure-recorded',
    {
      exposure: {
        exposureMs: { value: 120, unit: 'ms', raw: '120 ms' },
        gain: { value: 1.0, unit: 'relative', raw: '自动增益，记录为 1.0（基准）' },
        saturationLevel: 255,
        rawText: '曝光 120 ms；自动增益；灰度饱和水平 255',
      },
    },
    { deterministic: false },
  );
  appendEvent(
    { log, branch, actor: 'system', now: clock() },
    'lane-geometry-recorded',
    { lanes: resampledGeometry(built), provenance: '自动泳道追踪，中心线逐点保留像素来源' },
    { deterministic: false, inputSummary: { laneCount: built.lanes.length, blobId } },
  );
  appendEvent(
    { log, branch, actor: 'system', now: clock() },
    'bands-recorded',
    { bands: built.bands, provenance: '自动条带检测：高斯拟合中心保留像素来源与残差' },
    { deterministic: false, inputSummary: { bandCount: built.bands.length, blobId } },
  );
  void opts;
}

function firstSampleBand(built: BuiltCase, laneNumber: number): string {
  const laneId = `lane-${laneNumber}`;
  const band = built.bands.find((b) => b.laneId === laneId);
  if (!band) throw new Error(`missing band for ${laneId}`);
  return band.bandId;
}

export function toBundle(log: BuiltCase['log'], blobs: Map<string, Buffer>): Bundle {
  const bundleBlobs = [...blobs.entries()].map(([blobId, buf]) => ({
    blobId,
    mediaType: 'image/png',
    base64: buf.toString('base64'),
  }));
  const body = { project: log.project, branches: log.branches, events: log.events, blobs: bundleBlobs };
  const bodyDigest = digestOf(body);
  return {
    manifest: {
      format: 'gel-workbench-bundle',
      formatVersion: 1,
      projectId: log.project.id,
      name: log.project.name,
      exportedAt: '2026-09-23T02:00:00Z',
      eventCount: log.events.length,
      branchCount: log.branches.length,
      blobCount: bundleBlobs.length,
      bodyDigest,
    },
    ...body,
  };
}

export function parseBundle(json: string, options: { maxBytes?: number } = {}): Bundle {
  const maxBytes = options.maxBytes ?? 256 * 1024 * 1024;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    throw corrupted('BUNDLE-JSON-BROKEN', `案例包 JSON 损坏：${(err as Error).message}`);
  }
  const bundle = parsed as Partial<Bundle>;
  if (!bundle || bundle.manifest?.format !== 'gel-workbench-bundle') {
    throw corrupted('BUNDLE-FORMAT-MAGIC', '缺少 gel-workbench-bundle 格式标识（格式损坏，区别于语义无解）');
  }
  if (bundle.manifest.formatVersion !== 1) {
    throw corrupted('BUNDLE-VERSION-UNSUPPORTED', `不支持的案例包版本 ${String(bundle.manifest.formatVersion)}`);
  }
  if (!Array.isArray(bundle.events) || !Array.isArray(bundle.branches) || !bundle.project) {
    throw corrupted('BUNDLE-STRUCTURE', '案例包结构不完整');
  }
  let totalBytes = 0;
  for (const blob of bundle.blobs ?? []) {
    totalBytes += blob.base64.length;
    try {
      decodePng(Buffer.from(blob.base64, 'base64'));
    } catch (err) {
      throw corrupted('BUNDLE-PNG-BROKEN', `图像 ${blob.blobId} PNG 损坏：${(err as Error).message}`, { blobId: blob.blobId });
    }
  }
  if (totalBytes > maxBytes) {
    throw exhausted('BUNDLE-RESOURCE-BUDGET', `案例包超出资源预算（${totalBytes} 字节）`, { bytes: totalBytes });
  }
  const body = { project: bundle.project, branches: bundle.branches, events: bundle.events, blobs: bundle.blobs };
  const expectedBlobCount = bundle.blobs?.length ?? 0;
  if (bundle.manifest.blobCount !== expectedBlobCount) {
    throw corrupted('BUNDLE-TRUNCATED', `清单声称 ${bundle.manifest.blobCount} 个图像，实际只有 ${expectedBlobCount} 个（半写/截断）`);
  }
  if (bundle.manifest.eventCount !== bundle.events.length || bundle.manifest.branchCount !== bundle.branches.length) {
    throw corrupted('BUNDLE-TRUNCATED-EVENTS', '清单计数与内容不一致（半写/截断）');
  }
  if (digestOf(body) !== bundle.manifest.bodyDigest) {
    throw corrupted('BUNDLE-DIGEST-MISMATCH', '案例包摘要不一致：内容在导出后被截断或半写', { path: 'manifest.bodyDigest' });
  }
  return bundle as Bundle;
}

export function verifyReplayDeterminism(bundle: Bundle): void {
  for (const blob of bundle.blobs) {
    const raster = toGray(decodePng(Buffer.from(blob.base64, 'base64')));
    void raster;
  }
  for (const branch of bundle.branches) {
    const events = bundle.events.filter((e) => e.branch === branch.id).sort((a, b) => a.seq - b.seq);
    const first = replay(branch.id, events, {});
    const second = replay(branch.id, events, {});
    if (digestOf(first.view.molecularWeights) !== digestOf(second.view.molecularWeights)) {
      throw new Error(`nondeterministic replay on branch ${branch.id}`);
    }
  }
}

export { forkBranch };
