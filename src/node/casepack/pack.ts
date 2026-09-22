// 离线案例包的组装、读取与导出/导入（保持身份、分支与决定历史）。
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { hashJson, sha256Hex, canonicalJson } from '../../shared/hash.js';
import { PARAMS_V1, defaultParams } from '../../shared/versions.js';
import type { ExportBundle, Material, ProjectEvent, Branch } from '../../shared/types.js';
import { buildBaseline, PROJECT_ID, PROJECT_NAME, imageMaterialOf } from './buildBaseline.js';
import { buildDossier } from './buildDossier.js';
import { renderAllAssets, type RenderedAsset } from './assets.js';
import { standardLadder, nonMonotonicLadder } from './ladder.js';

export interface BuiltCasepack {
  bundle: ExportBundle;
  blobs: Map<string, Uint8Array>;
  assets: RenderedAsset[];
}

export function buildCasepackBundle(): BuiltCasepack {
  const assets = renderAllAssets();
  const byKey = new Map(assets.map((a) => [a.key, a]));
  const baseline = buildBaseline(byKey.get('baseline')!);
  const dossierBuild = buildDossier(
    baseline,
    byKey.get('baseline')!,
    {
      rotated: byKey.get('rotated')!,
      curved: byKey.get('curved')!,
      missing: byKey.get('missing')!,
      saturated: byKey.get('saturated')!,
      overlap: byKey.get('overlap')!,
      nonmono: byKey.get('nonmono')!,
      localfail: byKey.get('localfail')!,
    },
  );

  const branches: Branch[] = [
    { id: 'main', name: '主叙事（导入→候选→修订→冲突决定）', headEventId: baseline.events[baseline.events.length - 1]!.id },
    ...dossierBuild.branches,
  ];
  const events: ProjectEvent[] = [...baseline.events, ...dossierBuild.events];

  const materialEntries: Array<Material & { blobBase64?: string }> = [];
  const blobs = new Map<string, Uint8Array>();
  const imageAssets = [byKey.get('baseline')!, ...assets.filter((a) => a.key !== 'baseline')];
  for (const asset of imageAssets) {
    const m = imageMaterialOf(asset);
    blobs.set(m.id, asset.bytes);
    materialEntries.push({ ...m, blobBase64: toBase64(asset.bytes) });
  }
  materialEntries.push({ kind: 'ladder_spec', ...baseline.ladderSpec });
  for (const m of dossierBuild.materials) {
    // variant 图像已加入（按 key 去重）
  }
  // 非单调 ladder 也作为材料登记
  const nonMono = { kind: 'ladder_spec' as const, ...nonMonoLadderFor(byKey.get('nonmono')!) };
  if (!materialEntries.some((m) => m.id === nonMono.id)) materialEntries.push(nonMono);

  const inputHash = hashJson({
    events: events.map((e) => e.id),
    materials: materialEntries.map((m) => m.id),
  });
  const bundle: ExportBundle = {
    format: 'gel-ladder-bench-archive',
    formatVersion: 1,
    exportedAt: '2026-09-19T00:00:00.000Z',
    project: { id: PROJECT_ID, name: PROJECT_NAME, params: defaultParams(PARAMS_V1) },
    branches,
    events,
    materials: materialEntries,
    dossier: dossierBuild.dossier,
    manifest: {
      materialCount: materialEntries.length,
      eventCount: events.length,
      branchCount: branches.length,
      inputHash,
    },
  };
  return { bundle, blobs, assets };
}

export function writeCasepackToDir(dir: string, bundle: ExportBundle, blobs: Map<string, Uint8Array>): void {
  mkdirSync(join(dir, 'images'), { recursive: true });
  mkdirSync(join(dir, 'blobs'), { recursive: true });
  // 归档 JSON 不内嵌 base64（包目录形式），图像以 PNG 原样保存
  const onDisk: ExportBundle = {
    ...bundle,
    materials: bundle.materials.map((m) => ({ ...m, blobBase64: undefined })),
  };
  writeFileSync(join(dir, 'pack.json'), canonicalJson(onDisk), 'utf8');
  if (bundle.dossier) writeFileSync(join(dir, 'dossier.json'), canonicalJson(bundle.dossier), 'utf8');
  for (const [id, bytes] of blobs) writeFileSync(join(dir, 'blobs', `${id}.png`), bytes);
  // 人类可读的图像副本
  for (const a of renderAllAssets.name ? [] : []) void a;
}

export function readCasepackFromDir(dir: string): ExportBundle {
  const packPath = join(dir, 'pack.json');
  const bundle = JSON.parse(readFileSync(packPath, 'utf8')) as ExportBundle;
  for (const m of bundle.materials) {
    if (m.kind === 'image') {
      const file = join(dir, 'blobs', `${m.id}.png`);
      try {
        const bytes = readFileSync(file);
        (m as Material & { blobBase64?: string }).blobBase64 = toBase64(bytes);
      } catch {
        // 允许图像目录用 images/<filename>
        const alt = join(dir, (m as { filename?: string }).filename ?? '');
        const bytes = readFileSync(alt);
        (m as Material & { blobBase64?: string }).blobBase64 = toBase64(bytes);
      }
    }
  }
  return bundle;
}

export function bundleHash(bundle: ExportBundle): string {
  return sha256Hex(canonicalJson({ ...bundle, manifest: undefined }));
}

export function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

export function fromBase64(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, 'base64'));
}

function nonMonoLadderFor(asset: RenderedAsset) {
  return nonMonotonicLadder(asset.materialId);
}

export function listPackFiles(dir: string): string[] {
  return readdirSync(dir);
}
